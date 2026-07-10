import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { and, desc, eq, lt, sql } from "drizzle-orm";
import { outboxEmails } from "../db/outbox-emails.schema";
import { sentEmails } from "../db/sent-emails.schema";
import { createEmailSender } from "../lib/email-sender";
import { attemptOutboxRow, resolveSequenceStep } from "../lib/outbox";
import { assertInboxAllowed, inboxFilter } from "../lib/inbox-permissions";
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

  const clauses = [];
  const scope = inboxFilter(allowed, outboxEmails.fromAddress);
  if (scope) clauses.push(scope);
  if (cursor)
    clauses.push(lt(outboxEmails.createdAt, Number.parseInt(cursor, 10)));

  const rows = await db
    .select()
    .from(outboxEmails)
    .where(clauses.length > 0 ? and(...clauses) : undefined)
    .orderBy(desc(outboxEmails.createdAt))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const nextCursor =
    hasMore && items.length > 0
      ? String(items[items.length - 1].createdAt)
      : null;

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

  const now = Math.floor(Date.now() / 1000);
  // Make the row claimable now; a failed row gets a fresh attempt budget.
  await db
    .update(outboxEmails)
    .set({
      status: "pending",
      nextRetryAt: now,
      ...(row.status === "failed" ? { attempts: 0 } : {}),
      updatedAt: now,
    })
    .where(eq(outboxEmails.id, id));

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

  await db.delete(outboxEmails).where(eq(outboxEmails.id, id));
  await db
    .update(sentEmails)
    .set({ status: "failed" })
    .where(eq(sentEmails.id, row.sentEmailId));
  if (row.sequenceEmailId) {
    await resolveSequenceStep(db, row.sequenceEmailId, "failed", null);
  }
  return c.json({ deleted: true as const }, 200);
});
