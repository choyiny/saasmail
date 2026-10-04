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

export const adminInboxesRouter = new OpenAPIHono<{
  Bindings: CloudflareBindings;
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
      b.agentAutodraft !== undefined,
    "must update at least one field",
  );

const patchInboxRoute = createRoute({
  method: "patch",
  path: "/{email}",
  tags: ["Admin Inboxes"],
  description:
    "Update display name, display mode, conversation (threading) mode, signature HTML, forward destination, spam threshold, agent instructions, and/or automatic suggested replies for an inbox. Row is deleted only when all fields are at defaults. A new threading mode starts a background backfill (409 while one runs for the inbox), clears the inbox's snoozes and assignments, and resets JMAP clients when the backfill ends.",
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
    nextThreadingMode === "relationship"
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
        updatedAt: now,
      },
    });

  await startBackfill();
  await auditInboxUpdate();
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
