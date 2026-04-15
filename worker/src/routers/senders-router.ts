import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { desc, like, or, eq, sql } from "drizzle-orm";
import { senders } from "../db/senders.schema";
import { emails } from "../db/emails.schema";
import { json200Response } from "../lib/helpers";
import type { Variables } from "../variables";

export const sendersRouter = new OpenAPIHono<{
  Bindings: CloudflareBindings;
  Variables: Variables;
}>();

const SenderSchema = z.object({
  id: z.string(),
  email: z.string(),
  name: z.string().nullable(),
  recipient: z.string(),
  lastEmailAt: z.number(),
  unreadCount: z.number(),
  totalCount: z.number(),
  latestSubject: z.string().nullable().optional(),
});

// Grouped senders (unique senders, aggregated across all recipients)
const GroupedSenderSchema = z.object({
  id: z.string(),
  email: z.string(),
  name: z.string().nullable(),
  lastEmailAt: z.number(),
  unreadCount: z.number(),
  totalCount: z.number(),
  recipientCount: z.number(),
});

const listGroupedSendersRoute = createRoute({
  method: "get",
  path: "/grouped",
  tags: ["Senders"],
  description: "List senders grouped by sender (aggregated across all recipients).",
  request: {
    query: z.object({
      q: z
        .string()
        .optional()
        .openapi({ description: "Search sender name/email" }),
      page: z.coerce.number().optional().default(1),
      limit: z.coerce.number().optional().default(50),
    }),
  },
  responses: {
    ...json200Response(
      z.object({
        data: z.array(GroupedSenderSchema),
        total: z.number(),
        page: z.number(),
        limit: z.number(),
      }),
      "Paginated list of grouped senders",
    ),
  },
});

sendersRouter.openapi(listGroupedSendersRoute, async (c) => {
  const db = c.get("db");
  const { q, page, limit } = c.req.valid("query");
  const offset = (page - 1) * limit;

  const conditions: any[] = [];
  if (q) {
    const pattern = `%${q}%`;
    conditions.push(
      sql`(${senders.email} LIKE ${pattern} OR ${senders.name} LIKE ${pattern})`,
    );
  }

  const whereClause =
    conditions.length > 0
      ? sql`WHERE ${sql.join(conditions, sql` AND `)}`
      : sql``;

  const rows = await db.all<{
    id: string;
    email: string;
    name: string | null;
    lastEmailAt: number;
    unreadCount: number;
    totalCount: number;
    recipientCount: number;
  }>(sql`
    SELECT
      s.id,
      s.email,
      s.name,
      MAX(e.received_at) AS lastEmailAt,
      SUM(CASE WHEN e.is_read = 0 THEN 1 ELSE 0 END) AS unreadCount,
      COUNT(*) AS totalCount,
      COUNT(DISTINCT e.recipient) AS recipientCount
    FROM ${emails} e
    JOIN ${senders} s ON s.id = e.sender_id
    ${whereClause}
    GROUP BY s.id
    ORDER BY lastEmailAt DESC
    LIMIT ${limit} OFFSET ${offset}
  `);

  const countResult = await db.all<{ count: number }>(sql`
    SELECT COUNT(*) AS count FROM (
      SELECT 1 FROM ${emails} e
      JOIN ${senders} s ON s.id = e.sender_id
      ${whereClause}
      GROUP BY s.id
    )
  `);
  const total = countResult[0]?.count ?? 0;

  return c.json({ data: rows, total, page, limit }, 200);
});

const listSendersRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Senders"],
  description: "List senders sorted by most recent email.",
  request: {
    query: z.object({
      q: z
        .string()
        .optional()
        .openapi({ description: "Search sender name/email" }),
      recipient: z
        .string()
        .optional()
        .openapi({ description: "Filter by recipient address" }),
      senderId: z
        .string()
        .optional()
        .openapi({ description: "Filter by sender ID" }),
      page: z.coerce.number().optional().default(1),
      limit: z.coerce.number().optional().default(50),
    }),
  },
  responses: {
    ...json200Response(
      z.object({
        data: z.array(SenderSchema),
        total: z.number(),
        page: z.number(),
        limit: z.number(),
      }),
      "Paginated list of senders",
    ),
  },
});

sendersRouter.openapi(listSendersRoute, async (c) => {
  const db = c.get("db");
  const { q, recipient, senderId, page, limit } = c.req.valid("query");
  const offset = (page - 1) * limit;

  // Build WHERE conditions for the emails table
  const conditions: any[] = [];

  if (q) {
    const pattern = `%${q}%`;
    conditions.push(
      sql`(${senders.email} LIKE ${pattern} OR ${senders.name} LIKE ${pattern})`,
    );
  }

  if (recipient) {
    conditions.push(sql`${emails.recipient} = ${recipient}`);
  }

  if (senderId) {
    conditions.push(sql`s.id = ${senderId}`);
  }

  const whereClause =
    conditions.length > 0
      ? sql`WHERE ${sql.join(conditions, sql` AND `)}`
      : sql``;

  // Group by (sender, recipient) to get per-thread stats
  const rows = await db.all<{
    id: string;
    email: string;
    name: string | null;
    recipient: string;
    lastEmailAt: number;
    unreadCount: number;
    totalCount: number;
    latestSubject: string | null;
  }>(sql`
    SELECT
      s.id,
      s.email,
      s.name,
      e.recipient,
      MAX(e.received_at) AS lastEmailAt,
      SUM(CASE WHEN e.is_read = 0 THEN 1 ELSE 0 END) AS unreadCount,
      COUNT(*) AS totalCount,
      (
        SELECT e2.subject FROM emails e2
        WHERE e2.sender_id = s.id AND e2.recipient = e.recipient
        ORDER BY e2.received_at DESC LIMIT 1
      ) AS latestSubject
    FROM ${emails} e
    JOIN ${senders} s ON s.id = e.sender_id
    ${whereClause}
    GROUP BY s.id, e.recipient
    ORDER BY lastEmailAt DESC
    LIMIT ${limit} OFFSET ${offset}
  `);

  // Get total count of (sender, recipient) pairs
  const countResult = await db.all<{ count: number }>(sql`
    SELECT COUNT(*) AS count FROM (
      SELECT 1 FROM ${emails} e
      JOIN ${senders} s ON s.id = e.sender_id
      ${whereClause}
      GROUP BY s.id, e.recipient
    )
  `);
  const total = countResult[0]?.count ?? 0;

  return c.json({ data: rows, total, page, limit }, 200);
});

const getSenderRoute = createRoute({
  method: "get",
  path: "/{id}",
  tags: ["Senders"],
  description: "Get sender detail.",
  request: {
    params: z.object({
      id: z.string(),
    }),
  },
  responses: {
    ...json200Response(SenderSchema, "Sender detail"),
  },
});

sendersRouter.openapi(getSenderRoute, async (c) => {
  const db = c.get("db");
  const { id } = c.req.valid("param");

  const rows = await db
    .select()
    .from(senders)
    .where(eq(senders.id, id))
    .limit(1);

  if (rows.length === 0) {
    return c.json({ error: "Sender not found" }, 404);
  }

  return c.json(rows[0], 200);
});
