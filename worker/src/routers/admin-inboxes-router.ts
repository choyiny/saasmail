import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { eq, sql } from "drizzle-orm";
import { senderIdentities } from "../db/sender-identities.schema";
import { inboxPermissions } from "../db/inbox-permissions.schema";
import { emails } from "../db/emails.schema";
import { json200Response, json201Response } from "../lib/helpers";
import {
  MAX_SIGNATURE_HTML_LENGTH,
  sanitizeSignatureHtml,
} from "../lib/sanitize-signature";
import { GmailApiError, listSendAs } from "../lib/gmail/api";
import { GoogleAuthError } from "../lib/gmail/oauth";
import { getAccessToken } from "../lib/gmail/token";
import { clearGmailThreadIds } from "../lib/gmail/thread-ids";
import type { Variables } from "../variables";

type InboxesEnv = CloudflareBindings & {
  GOOGLE_OAUTH_CLIENT_ID?: string;
  GOOGLE_OAUTH_CLIENT_SECRET?: string;
  TOKEN_ENCRYPTION_KEY?: string;
};

export const adminInboxesRouter = new OpenAPIHono<{
  Bindings: InboxesEnv;
  Variables: Variables;
}>();

/** The secrets a Gmail token refresh needs, or null when unconfigured. */
function gmailConfig(env: InboxesEnv) {
  const clientId = env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = env.GOOGLE_OAUTH_CLIENT_SECRET;
  const encryptionKey = env.TOKEN_ENCRYPTION_KEY;
  if (!clientId || !clientSecret || !encryptionKey) return null;
  return { clientId, clientSecret, encryptionKey };
}

const InboxRowSchema = z.object({
  email: z.string(),
  displayName: z.string().nullable(),
  displayMode: z.enum(["thread", "chat"]),
  signatureHtml: z.string().nullable(),
  forwardTo: z.string().nullable(),
  assignedUserIds: z.array(z.string()),
  source: z.enum(["cloudflare", "gmail"]),
  gmailAccountId: z.string().nullable(),
});

const listInboxesRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Admin Inboxes"],
  description:
    "List all known inboxes (from received emails + sender_identities), with display name and assigned members.",
  responses: {
    ...json200Response(z.array(InboxRowSchema), "List of inboxes"),
  },
});

adminInboxesRouter.openapi(listInboxesRoute, async (c) => {
  const db = c.get("db");
  type Row = {
    email: string;
    displayName: string | null;
    displayMode: "thread" | "chat" | null;
    signatureHtml: string | null;
    forwardTo: string | null;
    assignedUserIds: string | null;
    source: "cloudflare" | "gmail" | null;
    gmailAccountId: string | null;
  };
  const rows = await db.all<Row>(sql`
    WITH universe AS (
      SELECT DISTINCT recipient AS email FROM ${emails}
      UNION
      SELECT email FROM ${senderIdentities}
    )
    SELECT
      u.email AS email,
      s.display_name AS displayName,
      s.display_mode AS displayMode,
      s.signature_html AS signatureHtml,
      s.forward_to AS forwardTo,
      s.source AS source,
      s.gmail_account_id AS gmailAccountId,
      (
        SELECT COALESCE(
          '[' || GROUP_CONCAT('"' || ip.user_id || '"') || ']',
          '[]'
        )
        FROM ${inboxPermissions} ip
        WHERE ip.email = u.email
      ) AS assignedUserIds
    FROM universe u
    LEFT JOIN ${senderIdentities} s ON s.email = u.email
    ORDER BY u.email
  `);

  return c.json(
    rows.map((r) => ({
      email: r.email,
      displayName: r.displayName,
      displayMode: r.displayMode ?? "chat",
      signatureHtml: r.signatureHtml,
      forwardTo: r.forwardTo,
      assignedUserIds: r.assignedUserIds ? JSON.parse(r.assignedUserIds) : [],
      source: r.source ?? "cloudflare",
      gmailAccountId: r.gmailAccountId,
    })),
    200,
  );
});

const createInboxRoute = createRoute({
  method: "post",
  path: "/",
  tags: ["Admin Inboxes"],
  description:
    "Create a new inbox by inserting a sender_identities row. Returns 409 if an identity already exists for that email.",
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            email: z.string().email(),
            displayName: z.string().min(1).nullable().optional(),
            displayMode: z.enum(["thread", "chat"]).optional(),
          }),
        },
      },
    },
  },
  responses: {
    ...json201Response(
      z.object({
        email: z.string(),
        displayName: z.string().nullable(),
        displayMode: z.enum(["thread", "chat"]),
        signatureHtml: z.string().nullable(),
        forwardTo: z.string().nullable(),
        assignedUserIds: z.array(z.string()),
      }),
      "Created inbox",
    ),
    409: {
      description: "Inbox already exists",
      content: {
        "application/json": {
          schema: z.object({ error: z.string() }),
        },
      },
    },
  },
});

adminInboxesRouter.openapi(createInboxRoute, async (c) => {
  const db = c.get("db");
  const body = c.req.valid("json");
  const email = body.email.trim().toLowerCase();
  const displayName = body.displayName ?? null;
  const displayMode = body.displayMode ?? "chat";
  const now = Math.floor(Date.now() / 1000);

  const existing = await db
    .select({ email: senderIdentities.email })
    .from(senderIdentities)
    .where(eq(senderIdentities.email, email))
    .limit(1);
  if (existing.length > 0) {
    return c.json({ error: "Inbox already exists" }, 409);
  }

  await db.insert(senderIdentities).values({
    email,
    displayName,
    displayMode,
    createdAt: now,
    updatedAt: now,
  });

  return c.json(
    {
      email,
      displayName,
      displayMode,
      signatureHtml: null,
      forwardTo: null,
      assignedUserIds: [],
    },
    201,
  );
});

const PatchInboxBodySchema = z
  .object({
    displayName: z.string().nullable().optional(),
    displayMode: z.enum(["thread", "chat"]).optional(),
    // Length cap prevents a single admin from blowing up storage and
    // the outbound-email payload. Real content is sanitized further
    // by `sanitizeSignatureHtml` in the handler.
    signatureHtml: z
      .string()
      .max(MAX_SIGNATURE_HTML_LENGTH)
      .nullable()
      .optional(),
    // Destination for per-inbox forwarding. "" clears it (the UI sends an empty
    // input as ""), so the union accepts a valid address, "", or null.
    forwardTo: z
      .union([z.string().email(), z.literal(""), z.null()])
      .optional(),
    // Where this inbox's mail comes from. Absent = unchanged.
    source: z.enum(["cloudflare", "gmail"]).optional(),
    // FK to gmail_accounts.id. Absent = unchanged; null clears it.
    gmailAccountId: z.string().nullable().optional(),
    // Google Group routing was attempted in this slice and withdrawn after
    // adversarial review found List-ID and Delivered-To are both
    // sender-forgeable — an attacker could pick which customer's timeline
    // their message lands on. The column still exists for a later slice;
    // nothing may configure it yet, so a non-null value here is rejected
    // outright (see the handler) rather than silently accepted or ignored.
    gmailGroupAddress: z.string().nullable().optional(),
  })
  .refine(
    (b) =>
      b.displayName !== undefined ||
      b.displayMode !== undefined ||
      b.signatureHtml !== undefined ||
      b.forwardTo !== undefined ||
      b.source !== undefined ||
      b.gmailAccountId !== undefined ||
      b.gmailGroupAddress !== undefined,
    "must update at least one field",
  );

const patchInboxRoute = createRoute({
  method: "patch",
  path: "/{email}",
  tags: ["Admin Inboxes"],
  description:
    "Update display name, display mode, signature HTML, forward destination, and/or Gmail source mapping for an inbox. Row is deleted only when all four display/forward fields are at defaults (null + 'chat' + null + null). Google Group routing (gmailGroupAddress) is not accepted in this release.",
  request: {
    params: z.object({ email: z.string() }),
    body: {
      content: {
        "application/json": {
          schema: PatchInboxBodySchema,
        },
      },
    },
  },
  responses: {
    ...json200Response(
      z.object({
        email: z.string(),
        displayName: z.string().nullable(),
        displayMode: z.enum(["thread", "chat"]),
        signatureHtml: z.string().nullable(),
        forwardTo: z.string().nullable(),
        source: z.enum(["cloudflare", "gmail"]),
        gmailAccountId: z.string().nullable(),
      }),
      "Updated",
    ),
    400: {
      description:
        "Invalid forward destination, invalid source, a group address was supplied, or the connected Google account cannot send as this inbox",
      content: {
        "application/json": {
          schema: z.object({ error: z.string() }),
        },
      },
    },
    502: {
      description:
        "Gmail could not be reached to verify the mapping; nothing was saved",
      content: {
        "application/json": {
          schema: z.object({ error: z.string() }),
        },
      },
    },
    503: {
      description: "Gmail integration is not configured on this instance",
      content: {
        "application/json": {
          schema: z.object({ error: z.string() }),
        },
      },
    },
  },
});

adminInboxesRouter.openapi(patchInboxRoute, async (c) => {
  const db = c.get("db");
  const { email: emailParam } = c.req.valid("param");
  const body = c.req.valid("json");
  const now = Math.floor(Date.now() / 1000);

  // Normalise the address the way every other site does (`POST /` above, the
  // send path's inbox lookup, forwardTo below). Without this a PATCH to
  // `Support@Acme.dev` writes a row the send path — which lowercases before
  // looking up — can never find, so a mapping could pass the sendAs check
  // below and still be dead on arrival.
  const email = emailParam.trim().toLowerCase();

  // Google Group routing was attempted in this slice and withdrawn after
  // adversarial review found List-ID and Delivered-To are both
  // sender-forgeable — an attacker could choose which customer's timeline
  // their message landed on. Reject outright, before touching the row at
  // all: a rejected request must not half-apply the rest of the body.
  if (body.gmailGroupAddress != null) {
    return c.json(
      {
        error:
          "Google Group routing is not supported yet. Only personal mailboxes can be mapped to an inbox in this release.",
      },
      400,
    );
  }

  // Load current row (if any) so we can apply a partial update without losing
  // the field the caller didn't touch.
  const current = await db
    .select()
    .from(senderIdentities)
    .where(eq(senderIdentities.email, email))
    .limit(1);
  const currentRow = current[0];

  const nextDisplayName =
    body.displayName !== undefined
      ? body.displayName === ""
        ? null
        : body.displayName
      : (currentRow?.displayName ?? null);
  const nextDisplayMode =
    body.displayMode !== undefined
      ? body.displayMode
      : (currentRow?.displayMode ?? "chat");
  // Sanitize at write time. Strips scripts / event handlers /
  // javascript: URLs before storage so a compromised admin token
  // can't turn this field into a stored-XSS vector for the rest of
  // the org. See sanitize-signature.ts for the threat model.
  const nextSignatureHtml =
    body.signatureHtml !== undefined
      ? body.signatureHtml === "" || body.signatureHtml === null
        ? null
        : await sanitizeSignatureHtml(body.signatureHtml)
      : (currentRow?.signatureHtml ?? null);
  const nextForwardTo =
    body.forwardTo !== undefined
      ? body.forwardTo === "" || body.forwardTo === null
        ? null
        : body.forwardTo.trim().toLowerCase()
      : (currentRow?.forwardTo ?? null);
  // `source` and `gmail_account_id` are one fact, not two.
  //
  // Merging them independently let either field be written without the other,
  // and the two halves of the feature read the pair differently: the sync
  // routes on `gmail_account_id` and the send path on `source`. So
  // `{"gmailAccountId": "..."}` alone wrote a mapping the send-as check never
  // saw, and `{"source": "cloudflare"}` alone left the id in place — the
  // operator had unmapped the inbox, the cron had not, and the UI rendered
  // "Cloudflare" for a row that was plainly Gmail-fed. Both are reachable
  // from the documented HTTP API and the MCP surface; only the admin UI
  // happens to always send the pair.
  //
  // What is written is therefore derived from the resulting STATE, and the
  // send-as verification below keys off that same state rather than off which
  // fields the request happened to carry.
  const sourceGiven = body.source !== undefined;
  const accountGiven = body.gmailAccountId !== undefined;

  // One body that says both things at once is a mistake worth naming rather
  // than silently resolving in a direction the caller may not have meant.
  if (
    sourceGiven &&
    accountGiven &&
    body.source === "cloudflare" &&
    body.gmailAccountId !== null
  ) {
    return c.json(
      {
        error:
          'source: "cloudflare" and a gmailAccountId contradict each other. Send source: "gmail" with the mailbox to map it, or source: "cloudflare" on its own to unmap it.',
      },
      400,
    );
  }

  let nextSource = sourceGiven
    ? body.source!
    : (currentRow?.source ?? "cloudflare");
  let nextGmailAccountId = accountGiven
    ? body.gmailAccountId!
    : (currentRow?.gmailAccountId ?? null);

  // Naming a mailbox is choosing Gmail...
  if (accountGiven && body.gmailAccountId !== null && !sourceGiven) {
    nextSource = "gmail";
  }
  // ...and choosing Cloudflare is giving the mailbox up.
  if (nextSource === "cloudflare") nextGmailAccountId = null;

  // Reject the tight self-forward loop at config time so the admin gets an
  // error instead of a silently-skipped forward. `buildForwardMessage` guards
  // this again at send time (and also catches forwards aimed at *other* inboxes
  // on this instance, which may not exist yet when the rule is saved).
  if (nextForwardTo !== null && nextForwardTo === email) {
    return c.json(
      { error: "Forward destination cannot be the inbox itself" },
      400,
    );
  }

  // A Gmail mapping is only usable if the connected account may actually put
  // this address in a From: header. Until this check existed, a wrong mapping
  // was saved happily and only surfaced when a real reply bounced.
  //
  // Checked only when the mapping is new or changed: re-checking on every
  // unrelated edit would make renaming an inbox fail whenever Gmail is
  // unreachable, and an unchanged mapping was already checked when it was
  // saved.
  if (
    nextSource === "gmail" &&
    nextGmailAccountId !== null &&
    (currentRow?.source !== "gmail" ||
      currentRow?.gmailAccountId !== nextGmailAccountId)
  ) {
    const cfg = gmailConfig(c.env);
    if (!cfg) {
      return c.json({ error: "Gmail integration is not configured" }, 503);
    }

    let sendAs: string[];
    try {
      const accessToken = await getAccessToken(db, nextGmailAccountId, cfg);
      sendAs = await listSendAs(accessToken);
    } catch (e) {
      // Log a code, never the error's free text and never the token: this
      // path holds an access token, and an admin-facing message plus a log
      // line are both places it must never reach.
      const reason =
        e instanceof GmailApiError || e instanceof GoogleAuthError
          ? e.code
          : "sendas_check_failed";
      console.error(
        `[admin-inboxes] could not verify the Gmail mapping for ${email} (account ${nextGmailAccountId}): ${reason}`,
      );
      // Refuse rather than save something unverified — an unchecked mapping
      // that looks checked is exactly the failure this guard exists to stop.
      return c.json(
        {
          error: `Could not verify that ${email} can be sent from the connected Google account, so the mapping was not saved. Please try again.`,
        },
        502,
      );
    }

    // Both sides are normalised: `listSendAs` lowercases Gmail's, and `email`
    // was normalised at the top of this handler.
    if (!sendAs.includes(email)) {
      return c.json(
        {
          error: `The connected Google account cannot send as ${email}, so the mapping was not saved. Add ${email} under "Send mail as" in that account's Gmail settings, verify it, then map this inbox again.`,
        },
        400,
      );
    }
  }
  // The mailbox this inbox's stored Gmail thread ids came from is about to
  // stop being the mailbox it reads from. Those ids are per-MAILBOX and
  // nothing records which account issued them, so from here on they are
  // claims no one can check — and handing one to a different account's
  // `messages.send` is a 4xx, which is terminal, which is never queued. See
  // `clearGmailThreadIds`.
  const mappingChanged =
    nextGmailAccountId !== (currentRow?.gmailAccountId ?? null);

  // All fields at defaults → delete the row to keep the table sparse.
  if (
    nextDisplayName === null &&
    nextDisplayMode === "chat" &&
    nextSignatureHtml === null &&
    nextForwardTo === null &&
    nextSource === "cloudflare" &&
    nextGmailAccountId === null
  ) {
    await db.delete(senderIdentities).where(eq(senderIdentities.email, email));
    if (mappingChanged) await clearGmailThreadIds(db, [email]);
    return c.json(
      {
        email,
        displayName: null,
        displayMode: "chat",
        signatureHtml: null,
        forwardTo: null,
        source: "cloudflare",
        gmailAccountId: null,
      },
      200,
    );
  }

  await db
    .insert(senderIdentities)
    .values({
      email,
      displayName: nextDisplayName,
      displayMode: nextDisplayMode,
      signatureHtml: nextSignatureHtml,
      forwardTo: nextForwardTo,
      source: nextSource,
      gmailAccountId: nextGmailAccountId,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: senderIdentities.email,
      set: {
        displayName: nextDisplayName,
        displayMode: nextDisplayMode,
        signatureHtml: nextSignatureHtml,
        forwardTo: nextForwardTo,
        source: nextSource,
        gmailAccountId: nextGmailAccountId,
        updatedAt: now,
      },
    });

  if (mappingChanged) await clearGmailThreadIds(db, [email]);

  return c.json(
    {
      email,
      displayName: nextDisplayName,
      displayMode: nextDisplayMode,
      signatureHtml: nextSignatureHtml,
      forwardTo: nextForwardTo,
      source: nextSource,
      gmailAccountId: nextGmailAccountId,
    },
    200,
  );
});

const putAssignmentsRoute = createRoute({
  method: "put",
  path: "/{email}/assignments",
  tags: ["Admin Inboxes"],
  description:
    "Replace the full set of member user IDs assigned to this inbox.",
  request: {
    params: z.object({ email: z.string() }),
    body: {
      content: {
        "application/json": {
          schema: z.object({ userIds: z.array(z.string()) }),
        },
      },
    },
  },
  responses: {
    ...json200Response(
      z.object({ email: z.string(), assignedUserIds: z.array(z.string()) }),
      "Assignments replaced",
    ),
  },
});

adminInboxesRouter.openapi(putAssignmentsRoute, async (c) => {
  const db = c.get("db");
  const currentUser = c.get("user");
  const { email } = c.req.valid("param");
  const { userIds } = c.req.valid("json");
  const now = Math.floor(Date.now() / 1000);

  await db.delete(inboxPermissions).where(eq(inboxPermissions.email, email));
  if (userIds.length > 0) {
    await db.insert(inboxPermissions).values(
      userIds.map((userId) => ({
        userId,
        email,
        createdAt: now,
        createdBy: currentUser.id,
      })),
    );
  }
  return c.json({ email, assignedUserIds: userIds }, 200);
});

const deleteInboxRoute = createRoute({
  method: "delete",
  path: "/{email}",
  tags: ["Admin Inboxes"],
  description:
    "Delete an inbox (sender_identity row + its inbox_permissions). Inbound emails are not removed.",
  request: {
    params: z.object({ email: z.string() }),
  },
  responses: {
    ...json200Response(z.object({ success: z.literal(true) }), "Inbox deleted"),
    404: {
      description: "Inbox not found",
      content: {
        "application/json": {
          schema: z.object({ error: z.string() }),
        },
      },
    },
  },
});

adminInboxesRouter.openapi(deleteInboxRoute, async (c) => {
  const db = c.get("db");
  const { email } = c.req.valid("param");

  const existing = await db
    .select({ email: senderIdentities.email })
    .from(senderIdentities)
    .where(eq(senderIdentities.email, email))
    .limit(1);
  if (existing.length === 0) {
    return c.json({ error: "Inbox not found" }, 404);
  }

  await db.delete(inboxPermissions).where(eq(inboxPermissions.email, email));
  await db.delete(senderIdentities).where(eq(senderIdentities.email, email));

  return c.json({ success: true as const }, 200);
});

const listUserInboxesRoute = createRoute({
  method: "get",
  path: "/users/{id}/inboxes",
  tags: ["Admin Inboxes"],
  description: "List inboxes assigned to a specific user.",
  request: {
    params: z.object({ id: z.string() }),
  },
  responses: {
    ...json200Response(z.array(z.string()), "List of inbox addresses"),
  },
});

adminInboxesRouter.openapi(listUserInboxesRoute, async (c) => {
  const db = c.get("db");
  const { id } = c.req.valid("param");
  const rows = await db
    .select({ email: inboxPermissions.email })
    .from(inboxPermissions)
    .where(eq(inboxPermissions.userId, id));
  return c.json(
    rows.map((r) => r.email),
    200,
  );
});
