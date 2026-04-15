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
  lastEmailAt: z.number(),
  unreadCount: z.number(),
  totalCount: z.number(),
  latestSubject: z.string().nullable().optional(),
});

const listSendersRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Senders"],
  description: "List senders sorted by most recent email.",
  request: {
    query: z.object({
      q: z.string().optional().openapi({ description: "Search sender name/email" }),
      recipient: z.string().optional().openapi({ description: "Filter by recipient address" }),
      page: z.coerce.number().optional().default(1),
      limit: z.coerce.number().optional().default(50),
    }),
  },
  responses: {
    ...json200Response(z.array(SenderSchema), "List of senders"),
  },
});

sendersRouter.openapi(listSendersRoute, async (c) => {
  const db = c.get("db");
  const { q, recipient, page, limit } = c.req.valid("query");
  const offset = (page - 1) * limit;

  const conditions: any[] = [];

  if (q) {
    const pattern = `%${q}%`;
    conditions.push(
      or(like(senders.email, pattern), like(senders.name, pattern))
    );
  }

  if (recipient) {
    conditions.push(
      sql`${senders.id} IN (
        SELECT DISTINCT ${emails.senderId} FROM ${emails}
        WHERE ${emails.recipient} = ${recipient}
      )`
    );
  }

  const where = conditions.length > 0
    ? sql`${sql.join(conditions, sql` AND `)}`
    : undefined;

  const rows = await db
    .select({
      id: senders.id,
      email: senders.email,
      name: senders.name,
      lastEmailAt: senders.lastEmailAt,
      unreadCount: senders.unreadCount,
      totalCount: senders.totalCount,
    })
    .from(senders)
    .where(where)
    .orderBy(desc(senders.lastEmailAt))
    .limit(limit)
    .offset(offset);

  const result = await Promise.all(
    rows.map(async (sender) => {
      const latest = await db
        .select({ subject: emails.subject })
        .from(emails)
        .where(eq(emails.senderId, sender.id))
        .orderBy(desc(emails.receivedAt))
        .limit(1);
      return {
        ...sender,
        latestSubject: latest[0]?.subject ?? null,
      };
    })
  );

  return c.json(result, 200);
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
