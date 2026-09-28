import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { and, asc, desc, eq, inArray, lt, lte, or, sql } from "drizzle-orm";
import { jmapSubmissions } from "../db/jmap-submissions.schema";
import { outboxEmails } from "../db/outbox-emails.schema";
import { sentEmails } from "../db/sent-emails.schema";
import { createEmailSender } from "../lib/email-sender";
import { attemptOutboxRow, resolveSequenceStep } from "../lib/outbox";
import {
  assertInboxAllowed,
  inboxFilter,
  isInboxAllowed,
} from "../lib/inbox-permissions";
import {
  cancelScheduledSubmission,
  restoreCanceledToDrafts,
  restoreStillPossible,
  webRestoreTarget,
} from "../jmap/release";
import { json200Response } from "../lib/helpers";
import type { Variables } from "../variables";

export const outboxRouter = new OpenAPIHono<{
  Bindings: CloudflareBindings;
  Variables: Variables;
}>();

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

const OutboxItemSchema = z.object({
  id: z.string(),
  sentEmailId: z.string(),
  fromAddress: z.string(),
  toAddress: z.string(),
  subject: z.string(),
  status: z.enum(["pending", "failed"]),
  attempts: z.number(),
  lastError: z.string().nullable(),
  nextRetryAt: z.number().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
});

const ListResponseSchema = z.object({
  items: z.array(OutboxItemSchema),
  nextCursor: z.string().nullable(),
});

const ErrorSchema = z.object({ error: z.string() });

// --- GET /api/outbox/count ---
// Registered before /{id} routes so the static segment wins.
const countRoute = createRoute({
  method: "get",
  path: "/count",
  tags: ["Outbox"],
  description: "Count of sends still awaiting retry.",
  responses: {
    ...json200Response(z.object({ pending: z.number() }), "Pending count"),
  },
});

outboxRouter.openapi(countRoute, async (c) => {
  const db = c.get("db");
  const allowed = c.get("allowedInboxes")!;
  const scope = inboxFilter(allowed, outboxEmails.fromAddress);
  const rows = await db
    .select({ n: sql<number>`count(*)` })
    .from(outboxEmails)
    .where(
      scope
        ? and(eq(outboxEmails.status, "pending"), scope)
        : eq(outboxEmails.status, "pending"),
    );
  return c.json({ pending: rows[0]?.n ?? 0 }, 200);
});

// --- GET /api/outbox/scheduled ---
// Delayed sends a JMAP client scheduled (RFC 4865 FUTURERELEASE). Only their
// author can cancel them, so only the author's are listed.
const ScheduledItemSchema = z.object({
  id: z.string(),
  sentEmailId: z.string(),
  fromAddress: z.string(),
  toAddress: z.string(),
  subject: z.string(),
  sendAt: z.number(),
});

const scheduledRoute = createRoute({
  method: "get",
  path: "/scheduled",
  tags: ["Outbox"],
  description:
    "Your delayed sends that haven't gone out yet, soonest first. Cancel one before its send time with POST /api/outbox/scheduled/{id}/cancel.",
  responses: {
    200: {
      description: "Scheduled sends",
      content: {
        "application/json": {
          schema: z.object({ items: z.array(ScheduledItemSchema) }),
        },
      },
    },
    401: { description: "Not signed in" },
  },
});

outboxRouter.openapi(scheduledRoute, async (c) => {
  const db = c.get("db");
  const allowed = c.get("allowedInboxes")!;
  const user = c.get("user");
  const scope = inboxFilter(allowed, jmapSubmissions.identityEmail);
  const rows = await db
    .select({
      id: jmapSubmissions.id,
      sentEmailId: jmapSubmissions.sentEmailId,
      fromAddress: jmapSubmissions.identityEmail,
      toAddress: sentEmails.toAddress,
      subject: sentEmails.subject,
      sendAt: jmapSubmissions.sendAt,
    })
    .from(jmapSubmissions)
    .innerJoin(sentEmails, eq(sentEmails.id, jmapSubmissions.sentEmailId))
    .where(
      and(
        eq(jmapSubmissions.userId, user.id),
        eq(jmapSubmissions.attemptState, "scheduled"),
        eq(jmapSubmissions.undoStatus, "pending"),
        ...(scope ? [scope] : []),
      ),
    )
    .orderBy(asc(jmapSubmissions.sendAt))
    .limit(MAX_LIMIT);
  return c.json({ items: rows }, 200);
});

// --- POST /api/outbox/scheduled/{id}/cancel ---
const cancelScheduledRoute = createRoute({
  method: "post",
  path: "/scheduled/{id}/cancel",
  tags: ["Outbox"],
  description:
    "Cancel a delayed send before it goes out, then move its message back to Drafts. If the move fails, the send stays canceled and the hourly maintenance finishes the move.",
  request: { params: z.object({ id: z.string() }) },
  responses: {
    200: {
      description: "Canceled",
      content: {
        "application/json": {
          schema: z.object({
            canceled: z.literal(true),
            movedToDrafts: z.boolean(),
            /** Not moved yet, but the hourly maintenance will move it. */
            willMove: z.boolean(),
          }),
        },
      },
    },
    404: { description: "Not found" },
    409: { description: "The message is already being sent or was sent" },
  },
});

outboxRouter.openapi(cancelScheduledRoute, async (c) => {
  const db = c.get("db");
  const allowed = c.get("allowedInboxes")!;
  const user = c.get("user");
  const { id } = c.req.valid("param");
  const [row] = await db
    .select({ identityEmail: jmapSubmissions.identityEmail })
    .from(jmapSubmissions)
    .where(and(eq(jmapSubmissions.id, id), eq(jmapSubmissions.userId, user.id)))
    .limit(1);
  if (!row || !isInboxAllowed(allowed, row.identityEmail)) {
    return c.json({ error: "Not found" }, 404);
  }
  // Step 1 decides: cancel wins only while the send is still scheduled.
  const outcome = await cancelScheduledSubmission(c.env, {
    submissionId: id,
    userId: user.id,
    restoreToDrafts: true,
  });
  if (outcome === "notFound") return c.json({ error: "Not found" }, 404);
  if (outcome === "cannotUnsend") {
    return c.json(
      { error: "The message is already being sent or was sent" },
      409,
    );
  }
  // Step 2 is best effort: the send is canceled either way.
  let movedToDrafts = false;
  let willMove = false;
  try {
    const target = await webRestoreTarget(db, id);
    movedToDrafts = target
      ? await restoreCanceledToDrafts(c.env, {
          submissionId: id,
          userId: user.id,
          target,
          now: Math.floor(Date.now() / 1000),
        })
      : false;
  } catch (error) {
    console.error(
      `[outbox] moving canceled ${id} back to Drafts failed:`,
      error,
    );
  }
  if (!movedToDrafts) {
    willMove = await restoreStillPossible(c.env, id);
    if (!willMove) {
      // The send never filed its draft into Sent: nothing to move back.
      await db
        .update(jmapSubmissions)
        .set({ restoreToDrafts: 0 })
        .where(eq(jmapSubmissions.id, id));
    }
  }
  return c.json({ canceled: true as const, movedToDrafts, willMove }, 200);
});

// --- GET /api/outbox ---
const listRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Outbox"],
  description:
    "List outbox rows (sends awaiting retry or terminally failed), newest first. Cursor is the createdAt of the last item.",
  request: {
    query: z.object({
      cursor: z.string().optional(),
      limit: z.string().optional(),
    }),
  },
  responses: { ...json200Response(ListResponseSchema, "Outbox rows") },
});

outboxRouter.openapi(listRoute, async (c) => {
  const db = c.get("db");
  const allowed = c.get("allowedInboxes")!;
  const { cursor, limit: limitRaw } = c.req.valid("query");

  let limit = DEFAULT_LIMIT;
  if (limitRaw) {
    const parsed = Number.parseInt(limitRaw, 10);
    if (Number.isFinite(parsed) && parsed > 0)
      limit = Math.min(parsed, MAX_LIMIT);
  }

  // A `bookkeeping_pending` row was already accepted by the provider and only
  // waits for its owner's bookkeeping: it is not a send anyone can act on.
  const clauses = [inArray(outboxEmails.status, ["pending", "failed"])];
  const scope = inboxFilter(allowed, outboxEmails.fromAddress);
  if (scope) clauses.push(scope);
  if (cursor) {
    const sep = cursor.indexOf("_");
    if (sep === -1) {
      // Backward compat: bare createdAt cursor (old format).
      clauses.push(lt(outboxEmails.createdAt, Number.parseInt(cursor, 10)));
    } else {
      const c_createdAt = Number.parseInt(cursor.slice(0, sep), 10);
      const cid = cursor.slice(sep + 1);
      // Compound keyset: rows with a smaller createdAt, OR rows with the same
      // createdAt but a smaller id (nanoid lexicographic descending).
      clauses.push(
        or(
          lt(outboxEmails.createdAt, c_createdAt),
          and(
            eq(outboxEmails.createdAt, c_createdAt),
            lt(outboxEmails.id, cid),
          ),
        ),
      );
    }
  }

  const rows = await db
    .select()
    .from(outboxEmails)
    .where(and(...clauses))
    .orderBy(desc(outboxEmails.createdAt), desc(outboxEmails.id))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const last = items.length > 0 ? items[items.length - 1] : null;
  const nextCursor = hasMore && last ? `${last.createdAt}_${last.id}` : null;

  return c.json(
    {
      items: items.map((r) => ({
        id: r.id,
        sentEmailId: r.sentEmailId,
        fromAddress: r.fromAddress,
        toAddress: r.toAddress,
        subject: r.subject,
        status: r.status as "pending" | "failed",
        attempts: r.attempts,
        lastError: r.lastError,
        nextRetryAt: r.nextRetryAt,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
      })),
      nextCursor,
    },
    200,
  );
});

const ALREADY_ACCEPTED =
  "The provider already accepted this message; it can't be retried or cancelled";

// --- POST /api/outbox/{id}/retry ---
const retryRoute = createRoute({
  method: "post",
  path: "/{id}/retry",
  tags: ["Outbox"],
  description:
    "Immediately re-attempt a send. Retrying a terminally failed row resets its attempt budget.",
  request: { params: z.object({ id: z.string() }) },
  responses: {
    ...json200Response(
      z.object({
        outcome: z.enum([
          "sent",
          "suppressed",
          "retrying",
          "failed",
          "pending",
        ]),
      }),
      "Attempt resolution",
    ),
    404: {
      description: "Not found",
      content: { "application/json": { schema: ErrorSchema } },
    },
    409: {
      description: "The provider already accepted this message",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

outboxRouter.openapi(retryRoute, async (c) => {
  const db = c.get("db");
  const { id } = c.req.valid("param");
  const allowed = c.get("allowedInboxes")!;

  const rows = await db
    .select()
    .from(outboxEmails)
    .where(eq(outboxEmails.id, id))
    .limit(1);
  if (rows.length === 0) return c.json({ error: "Not found" }, 404);
  const row = rows[0];
  assertInboxAllowed(allowed, row.fromAddress);
  if (row.status === "bookkeeping_pending") {
    // Retrying would send an accepted message a second time.
    return c.json({ error: ALREADY_ACCEPTED }, 409);
  }

  const now = Math.floor(Date.now() / 1000);
  // Make the row claimable now; a failed row gets a fresh attempt budget.
  // A pending row whose next_retry_at is in the future was just claimed by
  // the processor (send in flight) or is cooling down after a crashed attempt
  // — resetting it here would defeat the claim's double-send protection.
  // Failed rows are always safe to revive.
  const reset = await db
    .update(outboxEmails)
    .set({
      status: "pending",
      nextRetryAt: now,
      ...(row.status === "failed" ? { attempts: 0 } : {}),
      updatedAt: now,
    })
    .where(
      and(
        eq(outboxEmails.id, id),
        // The status guard also covers a row that became held since the read.
        row.status === "failed"
          ? eq(outboxEmails.status, "failed")
          : and(
              eq(outboxEmails.status, "pending"),
              lte(outboxEmails.nextRetryAt, now),
            ),
      ),
    )
    .returning({ id: outboxEmails.id });
  if (reset.length === 0) {
    return c.json({ outcome: "pending" as const }, 200);
  }

  const sender = createEmailSender(c.env);
  const outcome = await attemptOutboxRow(db, c.env, sender, id);
  // null = a concurrent processor claimed it first; report it as pending.
  return c.json({ outcome: outcome ?? ("pending" as const) }, 200);
});

// --- DELETE /api/outbox/{id} ---
const cancelRoute = createRoute({
  method: "delete",
  path: "/{id}",
  tags: ["Outbox"],
  description:
    "Cancel a pending/failed send: removes it from the outbox and marks the message failed.",
  request: { params: z.object({ id: z.string() }) },
  responses: {
    ...json200Response(z.object({ deleted: z.literal(true) }), "Cancelled"),
    404: {
      description: "Not found",
      content: { "application/json": { schema: ErrorSchema } },
    },
    409: {
      description: "Send in progress",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

outboxRouter.openapi(cancelRoute, async (c) => {
  const db = c.get("db");
  const { id } = c.req.valid("param");
  const allowed = c.get("allowedInboxes")!;

  const rows = await db
    .select()
    .from(outboxEmails)
    .where(eq(outboxEmails.id, id))
    .limit(1);
  if (rows.length === 0) return c.json({ error: "Not found" }, 404);
  const row = rows[0];
  assertInboxAllowed(allowed, row.fromAddress);
  if (row.status === "bookkeeping_pending") {
    // Cancelling would mark a delivered message failed.
    return c.json({ error: ALREADY_ACCEPTED }, 409);
  }

  const now = Math.floor(Date.now() / 1000);
  // Guard against cancelling while a send is in flight: the processor holds a
  // claim by pushing next_retry_at an hour into the future. Deleting mid-claim
  // would let the processor complete the send and flip sent_emails back to "sent"
  // after the caller already saw { deleted: true }.
  const deleted = await db
    .delete(outboxEmails)
    .where(
      row.status === "failed"
        ? and(eq(outboxEmails.id, id), eq(outboxEmails.status, "failed"))
        : and(
            eq(outboxEmails.id, id),
            eq(outboxEmails.status, "pending"),
            lte(outboxEmails.nextRetryAt, now),
          ),
    )
    .returning({ id: outboxEmails.id });
  if (deleted.length === 0) {
    return c.json(
      { error: "A send attempt is in progress — try again in a moment" },
      409,
    );
  }
  await db
    .update(sentEmails)
    .set({ status: "failed" })
    .where(eq(sentEmails.id, row.sentEmailId));
  if (row.sequenceEmailId) {
    await resolveSequenceStep(db, row.sequenceEmailId, "failed", null);
  }
  return c.json({ deleted: true as const }, 200);
});
