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
import type { Variables } from "../variables";

export const adminInboxesRouter = new OpenAPIHono<{
  Bindings: CloudflareBindings;
  Variables: Variables;
}>();

const InboxRowSchema = z.object({
  email: z.string(),
  displayName: z.string().nullable(),
  displayMode: z.enum(["thread", "chat"]),
  signatureHtml: z.string().nullable(),
  forwardTo: z.string().nullable(),
  assignedUserIds: z.array(z.string()),
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

// Exported so the bearer-token field guard's test fails if a field is added
// here without being classified in `BODY_GUARDS`.
export const PatchInboxBodySchema = z
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
  })
  .refine(
    (b) =>
      b.displayName !== undefined ||
      b.displayMode !== undefined ||
      b.signatureHtml !== undefined ||
      b.forwardTo !== undefined,
    "must update at least one field",
  );

const patchInboxRoute = createRoute({
  method: "patch",
  path: "/{email}",
  tags: ["Admin Inboxes"],
  description:
    "Update display name, display mode, signature HTML, and/or forward destination for an inbox. Row is deleted only when all four fields are at defaults (null + 'chat' + null + null).",
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
      }),
      "Updated",
    ),
    400: {
      description: "Invalid forward destination",
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
  const { email } = c.req.valid("param");
  const body = c.req.valid("json");
  const now = Math.floor(Date.now() / 1000);

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

  // Reject the tight self-forward loop at config time so the admin gets an
  // error instead of a silently-skipped forward. `buildForwardMessage` guards
  // this again at send time (and also catches forwards aimed at *other* inboxes
  // on this instance, which may not exist yet when the rule is saved).
  if (nextForwardTo !== null && nextForwardTo === email.trim().toLowerCase()) {
    return c.json(
      { error: "Forward destination cannot be the inbox itself" },
      400,
    );
  }

  // All fields at defaults → delete the row to keep the table sparse.
  if (
    nextDisplayName === null &&
    nextDisplayMode === "chat" &&
    nextSignatureHtml === null &&
    nextForwardTo === null
  ) {
    await db.delete(senderIdentities).where(eq(senderIdentities.email, email));
    return c.json(
      {
        email,
        displayName: null,
        displayMode: "chat",
        signatureHtml: null,
        forwardTo: null,
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
        updatedAt: now,
      },
    });

  return c.json(
    {
      email,
      displayName: nextDisplayName,
      displayMode: nextDisplayMode,
      signatureHtml: nextSignatureHtml,
      forwardTo: nextForwardTo,
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

  const existing = await db
    .select({ userId: inboxPermissions.userId })
    .from(inboxPermissions)
    .where(eq(inboxPermissions.email, email));

  /*
    A bearer caller may take an inbox away from someone, never give one.

    This closes the one chain that still crossed the line the policy draws.
    Every step of it is otherwise permitted: mint a member invite pinned to an
    address the caller controls (the clamp allows exactly this, and the 201
    body carries the token), redeem it through the public accept route, then
    assign that fresh member every inbox. The result is a standing account with
    mail access that outlives revoking the client and expiring the token —
    durable privilege, assembled entirely out of allowed calls.

    Shrink-only rather than a blanket denial because revocation is the half
    that de-privileges, and an operator locking someone out from their phone is
    exactly when it matters most. Granting is the durable half and stays in the
    browser, alongside promotion and admin invites, for the same reason.

    Checked here rather than in `BODY_GUARDS` because the question is not what
    the body says, it is how the body compares to what is already stored — the
    guard table is deliberately syntactic and has no database.
  */
  if (c.get("authMethod") === "oauth") {
    const held = new Set(existing.map((r) => r.userId));
    const added = userIds.filter((id) => !held.has(id));
    if (added.length > 0) {
      return c.json(
        {
          error:
            "OAuth clients may remove inbox assignments but not add them. Grant access from the web dashboard.",
          code: "OAUTH_SCOPE_DENIED",
        },
        403,
      );
    }
  }

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
