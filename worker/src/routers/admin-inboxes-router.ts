import { AUDIT_ACTIONS } from "../lib/audit/events";
import { recordAudit } from "../lib/audit/record";
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { and, eq, sql } from "drizzle-orm";
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
import { ensureBackfillJobs } from "../lib/gmail/backfill-job";
import { gmailAuthConfig } from "../lib/gmail/sync";
import { getOutlookAccessToken, outlookAuthConfig } from "../lib/outlook/token";
import {
  getProfile as getOutlookProfile,
  MicrosoftAuthError,
} from "../lib/outlook/oauth";
import type { Variables } from "../variables";
import {
  readSpamModels,
  resetSpamFilter,
  setSpamFilterEnabled,
} from "../lib/spam/filter";
import { modelReady } from "../lib/spam/score";
import {
  backfillStatus,
  insertThreadBackfill,
  latestThreadBackfills,
  startThreadBackfill,
} from "../lib/messages/thread-backfill";

type InboxesEnv = CloudflareBindings & {
  GOOGLE_OAUTH_CLIENT_ID?: string;
  GOOGLE_OAUTH_CLIENT_SECRET?: string;
  TOKEN_ENCRYPTION_KEY?: string;
};

export const adminInboxesRouter = new OpenAPIHono<{
  Bindings: InboxesEnv;
  Variables: Variables;
}>();

/** Whether a mail import into the inbox is storing mail. */
async function importRunning(
  db: Variables["db"],
  inbox: string,
): Promise<boolean> {
  const [row] = await db.all<{ n: number }>(sql`
    SELECT COUNT(*) AS n FROM async_jobs
    WHERE job_type = 'mail_import' AND ref_id = ${inbox}
      AND status = 'running'
  `);
  return (row?.n ?? 0) > 0;
}

/** The inbox's last conversation-mode backfill, if it ever had one. */
const ThreadBackfillSchema = z
  .object({
    id: z.string(),
    mode: z.enum(["relationship", "headers"]),
    status: z.enum(["running", "completed", "failed"]),
    processed: z.number().int(),
    total: z.number().int(),
  })
  .nullable();

const InboxRowSchema = z.object({
  email: z.string(),
  displayName: z.string().nullable(),
  displayMode: z.enum(["thread", "chat"]),
  threadingMode: z.enum(["relationship", "headers"]),
  threadBackfill: ThreadBackfillSchema,
  signatureHtml: z.string().nullable(),
  forwardTo: z.string().nullable(),
  spamThreshold: z.number().nullable(),
  agentInstructions: z.string().nullable(),
  agentAutodraft: z.boolean(),
  assignedUserIds: z.array(z.string()),
  spamFilter: z.object({
    enabled: z.boolean(),
    spamMessages: z.number().int(),
    hamMessages: z.number().int(),
    /** Trained on 20 junk and 20 not-junk messages: it scores new mail. */
    ready: z.boolean(),
  }),
  source: z.enum(["cloudflare", "gmail", "outlook"]),
  gmailAccountId: z.string().nullable(),
  outlookAccountId: z.string().nullable(),
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
    threadingMode: "relationship" | "headers" | null;
    signatureHtml: string | null;
    forwardTo: string | null;
    spamThreshold: number | null;
    agentInstructions: string | null;
    agentAutodraft: number | null;
    assignedUserIds: string | null;
    source: "cloudflare" | "gmail" | "outlook" | null;
    gmailAccountId: string | null;
    outlookAccountId: string | null;
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
      s.threading_mode AS threadingMode,
      s.signature_html AS signatureHtml,
      s.forward_to AS forwardTo,
      s.spam_threshold AS spamThreshold,
      s.agent_instructions AS agentInstructions,
      s.agent_autodraft AS agentAutodraft,
      s.source AS source,
      s.gmail_account_id AS gmailAccountId,
      s.outlook_account_id AS outlookAccountId,
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

  const models = await readSpamModels(db);
  const backfills = await latestThreadBackfills(
    db,
    rows.map((r) => r.email),
  );
  return c.json(
    rows.map((r) => ({
      spamFilter: spamFilterStatus(models.get(r.email.toLowerCase())),
      email: r.email,
      displayName: r.displayName,
      displayMode: r.displayMode ?? "chat",
      threadingMode: r.threadingMode ?? "relationship",
      threadBackfill: backfillStatus(backfills.get(r.email) ?? null),
      signatureHtml: r.signatureHtml,
      forwardTo: r.forwardTo,
      spamThreshold: r.spamThreshold,
      agentInstructions: r.agentInstructions,
      agentAutodraft: r.agentAutodraft === 1,
      assignedUserIds: r.assignedUserIds ? JSON.parse(r.assignedUserIds) : [],
      source: r.source ?? "cloudflare",
      gmailAccountId: r.gmailAccountId,
      outlookAccountId: r.outlookAccountId,
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
        threadingMode: z.enum(["relationship", "headers"]),
        threadBackfill: ThreadBackfillSchema,
        signatureHtml: z.string().nullable(),
        forwardTo: z.string().nullable(),
        spamThreshold: z.number().nullable(),
        agentInstructions: z.string().nullable(),
        agentAutodraft: z.boolean(),
        assignedUserIds: z.array(z.string()),
        spamFilter: z.object({
          enabled: z.boolean(),
          spamMessages: z.number().int(),
          hamMessages: z.number().int(),
          ready: z.boolean(),
        }),
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
  await recordAudit(db, {
    action: AUDIT_ACTIONS.inboxCreated,
    targetType: "inbox",
    targetId: email,
    inbox: email,
    summary: `Created the inbox ${email}`,
    details: { displayName, displayMode },
  });

  return c.json(
    {
      email,
      displayName,
      displayMode,
      threadingMode: "relationship" as const,
      threadBackfill: null,
      signatureHtml: null,
      forwardTo: null,
      spamThreshold: null,
      spamFilter: spamFilterStatus(undefined),
      agentInstructions: null,
      agentAutodraft: false,
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
    spamThreshold: z.number().min(0).max(100).nullable().optional(),
    agentInstructions: z.string().max(4000).optional(),
    agentAutodraft: z.boolean().optional(),
    /**
     * How mail groups into conversations. Changing it rekeys the inbox's mail
     * in the background, clears its snoozes and assignments, and makes every
     * JMAP client resync once the rekeying is done.
     */
    threadingMode: z.enum(["relationship", "headers"]).optional(),
    // Where this inbox's mail comes from. Absent = unchanged.
    source: z.enum(["cloudflare", "gmail", "outlook"]).optional(),
    // FK to gmail_accounts.id. Absent = unchanged; null clears it.
    gmailAccountId: z.string().nullable().optional(),
    // FK to outlook_accounts.id. Absent = unchanged; null clears it.
    outlookAccountId: z.string().nullable().optional(),
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
      b.threadingMode !== undefined ||
      b.displayName !== undefined ||
      b.displayMode !== undefined ||
      b.signatureHtml !== undefined ||
      b.forwardTo !== undefined ||
      b.spamThreshold !== undefined ||
      b.agentInstructions !== undefined ||
      b.agentAutodraft !== undefined ||
      b.source !== undefined ||
      b.gmailAccountId !== undefined ||
      b.outlookAccountId !== undefined ||
      b.gmailGroupAddress !== undefined,
    "must update at least one field",
  );

const patchInboxRoute = createRoute({
  method: "patch",
  path: "/{email}",
  tags: ["Admin Inboxes"],
  description:
    "Update display name, display mode, conversation (threading) mode, signature HTML, forward destination, spam threshold, agent instructions, automatic suggested replies, and/or Gmail or Outlook source mapping for an inbox. Row is deleted only when all fields are at defaults. A new threading mode starts a background backfill (409 while one runs for the inbox), clears the inbox's snoozes and assignments, and resets JMAP clients when the backfill ends. Google Group routing (gmailGroupAddress) is not accepted in this release.",
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
        threadingMode: z.enum(["relationship", "headers"]),
        threadBackfill: ThreadBackfillSchema,
        signatureHtml: z.string().nullable(),
        forwardTo: z.string().nullable(),
        spamThreshold: z.number().nullable(),
        agentInstructions: z.string().nullable(),
        agentAutodraft: z.boolean(),
        source: z.enum(["cloudflare", "gmail", "outlook"]),
        gmailAccountId: z.string().nullable(),
        outlookAccountId: z.string().nullable(),
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
    409: {
      description: "A conversation-mode backfill is running for this inbox",
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
  const { email: rawEmail } = c.req.valid("param");
  const email = rawEmail.trim().toLowerCase();
  const body = c.req.valid("json");
  const now = Math.floor(Date.now() / 1000);

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
  const nextSpamThreshold =
    body.spamThreshold !== undefined
      ? body.spamThreshold
      : (currentRow?.spamThreshold ?? null);
  const nextAgentInstructions =
    body.agentInstructions !== undefined
      ? body.agentInstructions.trim() === ""
        ? null
        : body.agentInstructions
      : (currentRow?.agentInstructions ?? null);
  const nextAgentAutodraft =
    body.agentAutodraft !== undefined
      ? body.agentAutodraft
        ? 1
        : 0
      : (currentRow?.agentAutodraft ?? 0);
  const currentThreadingMode = currentRow?.threadingMode ?? "relationship";
  const nextThreadingMode = body.threadingMode ?? currentThreadingMode;
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
  const outlookGiven = body.outlookAccountId !== undefined;

  // Naming both providers' mailboxes, or an Outlook mailbox with a source
  // other than "outlook", has no single meaning — refuse rather than guess.
  // (Gmail's own contradiction with source "cloudflare" is checked below.)
  const gmailNamed = accountGiven && body.gmailAccountId !== null;
  const outlookNamed = outlookGiven && body.outlookAccountId !== null;
  if (
    (gmailNamed && outlookNamed) ||
    (gmailNamed && body.source === "outlook") ||
    (outlookNamed && sourceGiven && body.source !== "outlook")
  ) {
    return c.json(
      {
        error:
          'The source and the mailbox in this request contradict each other. Send source: "gmail" with a gmailAccountId, source: "outlook" with an outlookAccountId, or source: "cloudflare" on its own to unmap.',
      },
      400,
    );
  }

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

  let nextOutlookAccountId = outlookGiven
    ? body.outlookAccountId!
    : (currentRow?.outlookAccountId ?? null);

  // Naming a mailbox is choosing its provider...
  if (gmailNamed && !sourceGiven) nextSource = "gmail";
  if (outlookNamed && !sourceGiven) nextSource = "outlook";
  // ...and an inbox reads from one place, so the provider it is not mapped
  // to (both, for Cloudflare) gives its mailbox up.
  if (nextSource !== "gmail") nextGmailAccountId = null;
  if (nextSource !== "outlook") nextOutlookAccountId = null;

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

  // A Gmail source with no mailbox names nothing to sync from, and the
  // sendAs check below is skipped for it because there is no account to ask —
  // so without this it is the one way to write an unverified "gmail" row.
  // Not reachable from the UI, which always sends both fields together.
  if (nextSource === "gmail" && nextGmailAccountId === null) {
    return c.json(
      {
        error:
          'A Gmail inbox must name the connected mailbox it reads from. Send gmailAccountId alongside source: "gmail", or use source: "cloudflare" to unmap it.',
      },
      400,
    );
  }

  // A Gmail mapping is only usable if the connected account may actually put
  // this address in a From: header. Until this check existed, a wrong mapping
  // was saved happily and only surfaced when a real reply bounced.
  //
  // Keyed on the RESULTING mapping, not on `body.source`. Entering this block
  // only when the request carried `source` is what let
  // `{"gmailAccountId": "..."}` write a mapping with no `sendAs` call at all
  // — the gate skipped entirely by the one field that creates the thing it
  // gates. A non-null `nextGmailAccountId` now implies `nextSource ===
  // "gmail"` by construction above, so this is the whole condition.
  //
  // Still only when the mapping is new or changed: re-checking on every
  // unrelated edit would make renaming an inbox fail whenever Gmail is
  // unreachable, and an unchanged mapping was already checked when it was
  // saved.
  if (
    nextGmailAccountId !== null &&
    (currentRow?.source !== "gmail" ||
      currentRow?.gmailAccountId !== nextGmailAccountId)
  ) {
    const cfg = await gmailAuthConfig(db, c.env);
    if (!cfg) {
      return c.json(
        {
          error:
            "Google is not set up yet. Add its OAuth client ID and secret under Inboxes → Connected mailboxes → Google settings.",
        },
        503,
      );
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

  if (nextSource === "outlook" && nextOutlookAccountId === null) {
    return c.json(
      {
        error:
          'An Outlook inbox must name the connected mailbox it reads from. Send outlookAccountId alongside source: "outlook", or use source: "cloudflare" to unmap it.',
      },
      400,
    );
  }

  // The Outlook counterpart of the send-as check above: the mailbox must
  // receive (and so can send) as this address — its own address or one of
  // its aliases. Microsoft lists aliases for work and school accounts; a
  // personal account offers only its own address.
  if (
    nextOutlookAccountId !== null &&
    (currentRow?.source !== "outlook" ||
      currentRow?.outlookAccountId !== nextOutlookAccountId)
  ) {
    const cfg = await outlookAuthConfig(db, c.env);
    if (!cfg) {
      return c.json(
        {
          error:
            "Microsoft is not set up yet. Add its app registration's client ID and secret under Inboxes → Connected mailboxes → Microsoft settings.",
        },
        503,
      );
    }
    let addresses: string[];
    try {
      const token = await getOutlookAccessToken(db, nextOutlookAccountId, cfg);
      const profile = await getOutlookProfile(token);
      addresses = [profile.emailAddress, ...profile.aliases];
    } catch (e) {
      const reason =
        e instanceof MicrosoftAuthError ? e.code : "address_check_failed";
      console.error(
        `[admin-inboxes] could not verify the Outlook mapping for ${email} (account ${nextOutlookAccountId}): ${reason}`,
      );
      return c.json(
        {
          error: `Could not verify that ${email} belongs to the connected Microsoft mailbox, so the mapping was not saved. Please try again.`,
        },
        502,
      );
    }
    if (!addresses.includes(email)) {
      return c.json(
        {
          error: `The connected Microsoft mailbox does not receive mail as ${email}, so the mapping was not saved. Map its own address (${addresses[0]}), or add ${email} as an alias of that mailbox in Microsoft 365 first.`,
        },
        400,
      );
    }
  }

  const outlookMappingChanged =
    nextOutlookAccountId !== (currentRow?.outlookAccountId ?? null);

  // The mailbox this inbox's stored Gmail thread ids came from is about to
  // stop being the mailbox it reads from. Those ids are per-MAILBOX and
  // nothing records which account issued them, so from here on they are
  // claims no one can check — and handing one to a different account's
  // `messages.send` is a 4xx, which is terminal, which is never queued. See
  // `clearGmailThreadIds`.
  const mappingChanged =
    nextGmailAccountId !== (currentRow?.gmailAccountId ?? null);
  // What this request changes, for the audit log. The signature and the
  // agent instructions are named, not copied.
  const changes: Record<string, unknown> = {};
  const track = (field: string, from: unknown, to: unknown, show = true) => {
    if (from === to) return;
    changes[field] = show ? { from, to } : "changed";
  };
  track("displayName", currentRow?.displayName ?? null, nextDisplayName);
  track("displayMode", currentRow?.displayMode ?? "chat", nextDisplayMode);
  track(
    "signatureHtml",
    currentRow?.signatureHtml ?? null,
    nextSignatureHtml,
    false,
  );
  track("forwardTo", currentRow?.forwardTo ?? null, nextForwardTo);
  track("spamThreshold", currentRow?.spamThreshold ?? null, nextSpamThreshold);
  track(
    "agentInstructions",
    currentRow?.agentInstructions ?? null,
    nextAgentInstructions,
    false,
  );
  track("agentAutodraft", currentRow?.agentAutodraft ?? 0, nextAgentAutodraft);
  track("threadingMode", currentThreadingMode, nextThreadingMode);
  // The mapping by source and account id; the mailbox's address stays out.
  track("source", currentRow?.source ?? "cloudflare", nextSource);
  track(
    "gmailAccountId",
    currentRow?.gmailAccountId ?? null,
    nextGmailAccountId,
  );
  track(
    "outlookAccountId",
    currentRow?.outlookAccountId ?? null,
    nextOutlookAccountId,
  );

  // A new conversation mode claims the inbox for its backfill before anything
  // is saved, so a second switch while one runs changes nothing. Asking for
  // the current mode again after its backfill failed runs it again.
  const latestBackfill = backfillStatus(
    (await latestThreadBackfills(db, [email])).get(email) ?? null,
  );
  const retryBackfill =
    body.threadingMode !== undefined &&
    nextThreadingMode === currentThreadingMode &&
    latestBackfill?.status === "failed" &&
    latestBackfill.mode === nextThreadingMode;
  if (retryBackfill) {
    changes.threadingMode = {
      from: currentThreadingMode,
      to: nextThreadingMode,
      retry: true,
    };
  }
  const wantsBackfill =
    nextThreadingMode !== currentThreadingMode || retryBackfill;
  if (wantsBackfill && (await importRunning(db, email))) {
    // Its slices read the mode as they go: mail stored under the old one
    // could land behind the backfill's cursor and never be regrouped.
    return c.json(
      {
        error:
          "Mail is being imported into this inbox; change its conversations when the import finishes",
      },
      409,
    );
  }
  const backfill = wantsBackfill
    ? await insertThreadBackfill(db, {
        inbox: email,
        mode: nextThreadingMode,
        requestedBy: c.get("user")?.id ?? null,
      })
    : null;
  if (wantsBackfill && !backfill) {
    return c.json(
      {
        error:
          "This inbox's conversations are still being regrouped; try again when that finishes",
      },
      409,
    );
  }
  let threadBackfill = latestBackfill;
  const startBackfill = async () => {
    if (!backfill) return;
    changes.clearedConversationStates = await startThreadBackfill(
      db,
      c.env,
      backfill,
      (promise) => c.executionCtx.waitUntil(promise),
    );
    // Read back: the job now has its total (and in demo mode, progress).
    threadBackfill = backfillStatus(
      (await latestThreadBackfills(db, [email])).get(email) ?? backfill,
    );
  };

  const auditInboxUpdate = async () => {
    const fields = Object.keys(changes).filter(
      (field) => field !== "clearedConversationStates",
    );
    if (fields.length === 0) return;
    await recordAudit(db, {
      action: AUDIT_ACTIONS.inboxUpdated,
      targetType: "inbox",
      targetId: email,
      inbox: email,
      summary: `Changed ${fields.join(", ")} of ${email}`,
      details: changes,
    });
  };

  // All fields at defaults → delete the row to keep the table sparse.
  if (
    nextDisplayName === null &&
    nextDisplayMode === "chat" &&
    nextSignatureHtml === null &&
    nextForwardTo === null &&
    nextSpamThreshold === null &&
    nextAgentInstructions === null &&
    nextAgentAutodraft === 0 &&
    nextThreadingMode === "relationship" &&
    nextSource === "cloudflare" &&
    nextGmailAccountId === null &&
    nextOutlookAccountId === null
  ) {
    // Only while the mode is still the default: another admin may have just
    // switched it (their backfill is running).
    await db
      .delete(senderIdentities)
      .where(
        and(
          eq(senderIdentities.email, email),
          eq(senderIdentities.threadingMode, "relationship"),
        ),
      );
    if (mappingChanged) await clearGmailThreadIds(db, [email]);
    await startBackfill();
    await auditInboxUpdate();
    return c.json(
      {
        email,
        displayName: null,
        displayMode: "chat",
        threadingMode: "relationship",
        threadBackfill,
        signatureHtml: null,
        forwardTo: null,
        spamThreshold: null,
        agentInstructions: null,
        agentAutodraft: false,
        source: "cloudflare",
        gmailAccountId: null,
        outlookAccountId: null,
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
      spamThreshold: nextSpamThreshold,
      agentInstructions: nextAgentInstructions,
      agentAutodraft: nextAgentAutodraft,
      threadingMode: nextThreadingMode,
      source: nextSource,
      gmailAccountId: nextGmailAccountId,
      outlookAccountId: nextOutlookAccountId,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: senderIdentities.email,
      set: {
        // Written only when asked for, so saving another field can't undo a
        // switch another admin just made.
        ...(body.threadingMode !== undefined
          ? { threadingMode: nextThreadingMode }
          : {}),
        displayName: nextDisplayName,
        displayMode: nextDisplayMode,
        signatureHtml: nextSignatureHtml,
        forwardTo: nextForwardTo,
        spamThreshold: nextSpamThreshold,
        agentInstructions: nextAgentInstructions,
        agentAutodraft: nextAgentAutodraft,
        source: nextSource,
        gmailAccountId: nextGmailAccountId,
        outlookAccountId: nextOutlookAccountId,
        updatedAt: now,
      },
    });

  await startBackfill();
  await auditInboxUpdate();
  if (mappingChanged) await clearGmailThreadIds(db, [email]);

  // A mailbox is usually connected before any inbox is mapped to it, so this
  // is the moment its import can actually run. Start it now rather than at
  // the next cron tick; the cron starts it anyway if this does not.
  // Best effort: the mapping is already saved, and must not be reported as
  // failed because a job did not start.
  if (mappingChanged && nextGmailAccountId) {
    await ensureBackfillJobs(db, c.env, nextGmailAccountId).catch(() => {});
  }
  if (outlookMappingChanged && nextOutlookAccountId) {
    await ensureBackfillJobs(db, c.env, nextOutlookAccountId).catch(() => {});
  }

  return c.json(
    {
      email,
      displayName: nextDisplayName,
      displayMode: nextDisplayMode,
      threadingMode: nextThreadingMode,
      threadBackfill,
      signatureHtml: nextSignatureHtml,
      forwardTo: nextForwardTo,
      spamThreshold: nextSpamThreshold,
      agentInstructions: nextAgentInstructions,
      agentAutodraft: nextAgentAutodraft === 1,
      source: nextSource,
      gmailAccountId: nextGmailAccountId,
      outlookAccountId: nextOutlookAccountId,
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
  const { email: rawEmail } = c.req.valid("param");
  const email = rawEmail.trim().toLowerCase();
  const { userIds } = c.req.valid("json");
  const now = Math.floor(Date.now() / 1000);

  const before = await db
    .select({ userId: inboxPermissions.userId })
    .from(inboxPermissions)
    .where(eq(inboxPermissions.email, email));
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

  const had = new Set(before.map((row) => row.userId));
  const has = new Set(userIds);
  const added = userIds.filter((userId) => !had.has(userId));
  const removed = [...had].filter((userId) => !has.has(userId));
  if (added.length > 0 || removed.length > 0) {
    await recordAudit(db, {
      action: AUDIT_ACTIONS.userInboxAccessChanged,
      targetType: "inbox",
      targetId: email,
      inbox: email,
      summary: `Changed who can access ${email}: ${added.length} added, ${removed.length} removed`,
      details: { added, removed },
    });
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
    409: {
      description:
        "The inbox's conversations are being regrouped; try again when that finishes",
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
  const { email: rawEmail } = c.req.valid("param");
  const email = rawEmail.trim().toLowerCase();

  const existing = await db
    .select({
      email: senderIdentities.email,
      threadingMode: senderIdentities.threadingMode,
    })
    .from(senderIdentities)
    .where(eq(senderIdentities.email, email))
    .limit(1);
  if (existing.length === 0) {
    return c.json({ error: "Inbox not found" }, 404);
  }

  // Its mail stays. Mail grouped by thread goes back to the default grouping
  // with the inbox's mode, so its keys are cleared in the background.
  const latest = (await latestThreadBackfills(db, [email])).get(email);
  if (latest?.status === "running") {
    return c.json(
      {
        error:
          "This inbox's conversations are being regrouped; delete it when that finishes",
      },
      409,
    );
  }
  const clear =
    existing[0].threadingMode === "headers"
      ? await insertThreadBackfill(db, {
          inbox: email,
          mode: "relationship",
          requestedBy: c.get("user")?.id ?? null,
        })
      : null;
  await db.delete(inboxPermissions).where(eq(inboxPermissions.email, email));
  await db.delete(senderIdentities).where(eq(senderIdentities.email, email));
  if (clear) {
    await startThreadBackfill(db, c.env, clear, (promise) =>
      c.executionCtx.waitUntil(promise),
    );
  }
  await recordAudit(db, {
    action: AUDIT_ACTIONS.inboxDeleted,
    targetType: "inbox",
    targetId: email,
    inbox: email,
    summary: `Deleted the inbox ${email}`,
  });

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

function spamFilterStatus(
  model:
    | { enabled: boolean; spamMessages: number; hamMessages: number }
    | undefined,
) {
  const counts = {
    spamMessages: model?.spamMessages ?? 0,
    hamMessages: model?.hamMessages ?? 0,
  };
  return {
    enabled: model?.enabled ?? false,
    ...counts,
    ready: modelReady(counts),
  };
}

const SpamFilterSchema = z.object({
  enabled: z.boolean(),
  spamMessages: z.number().int(),
  hamMessages: z.number().int(),
  ready: z.boolean(),
});

const spamFilterRoute = createRoute({
  method: "put",
  path: "/{email}/spam-filter",
  tags: ["Admin Inboxes"],
  description:
    "Turn the inbox's learning spam filter on or off. On, it learns from people's junk and not-junk marks and replies, and once trained on 20 messages of each kind it scores new mail (`spamProbability`) for a `spam_probability` rule to act on. Its training is kept when it is off.",
  request: {
    params: z.object({ email: z.string() }),
    body: {
      content: {
        "application/json": { schema: z.object({ enabled: z.boolean() }) },
      },
    },
  },
  responses: {
    500: { description: "Internal server error" },
    200: {
      description: "The filter",
      content: { "application/json": { schema: SpamFilterSchema } },
    },
  },
});

adminInboxesRouter.openapi(spamFilterRoute, async (c) => {
  const db = c.get("db");
  // Hono already decoded the parameter.
  const inbox = c.req.valid("param").email.trim().toLowerCase();
  const { enabled } = c.req.valid("json");
  await setSpamFilterEnabled(db, inbox, enabled);
  await recordAudit(db, {
    action: AUDIT_ACTIONS.inboxUpdated,
    targetType: "inbox",
    targetId: inbox,
    inbox,
    summary: `${enabled ? "Turned on" : "Turned off"} the learning spam filter of ${inbox}`,
    details: { spamFilterEnabled: enabled },
  });
  const models = await readSpamModels(db);
  return c.json(spamFilterStatus(models.get(inbox)), 200);
});

const spamFilterResetRoute = createRoute({
  method: "post",
  path: "/{email}/spam-filter/reset",
  tags: ["Admin Inboxes"],
  description:
    "Forget everything the inbox's learning spam filter learned (tokens, training, counters). It stays on or off.",
  request: { params: z.object({ email: z.string() }) },
  responses: {
    500: { description: "Internal server error" },
    200: {
      description: "The filter, emptied",
      content: { "application/json": { schema: SpamFilterSchema } },
    },
  },
});

adminInboxesRouter.openapi(spamFilterResetRoute, async (c) => {
  const db = c.get("db");
  const inbox = c.req.valid("param").email.trim().toLowerCase();
  await resetSpamFilter(db, inbox);
  await recordAudit(db, {
    action: AUDIT_ACTIONS.inboxUpdated,
    targetType: "inbox",
    targetId: inbox,
    inbox,
    summary: `Reset the learning spam filter of ${inbox}`,
    details: { spamFilterReset: true },
  });
  const models = await readSpamModels(db);
  return c.json(spamFilterStatus(models.get(inbox)), 200);
});
