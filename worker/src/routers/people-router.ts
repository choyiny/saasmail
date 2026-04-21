import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { desc, like, or, eq, sql, and, inArray } from "drizzle-orm";
import { people } from "../db/people.schema";
import { emails } from "../db/emails.schema";
import { attachments } from "../db/attachments.schema";
import { json200Response, escapeLike } from "../lib/helpers";
import type { Variables } from "../variables";
import type { AllowedInboxes } from "../lib/inbox-permissions";

function peopleScopeClause(allowed: AllowedInboxes) {
  if (allowed.isAdmin) return sql``;
  if (allowed.inboxes.length === 0)
    return sql`AND s.id IN (SELECT NULL WHERE 0)`;
  return sql`AND s.id IN (SELECT person_id FROM emails WHERE recipient IN ${allowed.inboxes})`;
}

export const peopleRouter = new OpenAPIHono<{
  Bindings: CloudflareBindings;
  Variables: Variables;
}>();

const PersonSchema = z.object({
  id: z.string(),
  email: z.string(),
  name: z.string().nullable(),
  recipient: z.string(),
  lastEmailAt: z.number(),
  unreadCount: z.number(),
  totalCount: z.number(),
  latestSubject: z.string().nullable().optional(),
});

// Grouped people (unique people, aggregated across all recipients)
const GroupedPersonSchema = z.object({
  id: z.string(),
  email: z.string(),
  name: z.string().nullable(),
  lastEmailAt: z.number(),
  unreadCount: z.number(),
  totalCount: z.number(),
  recipientCount: z.number(),
  hasAttachment: z.number(),
});

const listGroupedPeopleRoute = createRoute({
  method: "get",
  path: "/grouped",
  tags: ["People"],
  description:
    "List people grouped by person (aggregated across all recipients).",
  request: {
    query: z.object({
      q: z
        .string()
        .optional()
        .openapi({ description: "Search person name/email" }),
      page: z.coerce.number().optional().default(1),
      limit: z.coerce.number().optional().default(50),
    }),
  },
  responses: {
    ...json200Response(
      z.object({
        data: z.array(GroupedPersonSchema),
        total: z.number(),
        page: z.number(),
        limit: z.number(),
      }),
      "Paginated list of grouped people",
    ),
  },
});

peopleRouter.openapi(listGroupedPeopleRoute, async (c) => {
  const db = c.get("db");
  const { q, page, limit } = c.req.valid("query");
  const offset = (page - 1) * limit;

  const conditions: any[] = [];
  if (q) {
    const pattern = `%${escapeLike(q)}%`;
    conditions.push(
      sql`(s.email LIKE ${pattern} ESCAPE '\\' OR s.name LIKE ${pattern} ESCAPE '\\')`,
    );
  }

  const allowed = c.get("allowedInboxes")!;
  const scopeClause = peopleScopeClause(allowed);
  const extraConditions =
    conditions.length > 0
      ? sql`AND ${sql.join(conditions, sql` AND `)}`
      : sql``;
  const whereClause = sql`WHERE 1=1 ${extraConditions} ${scopeClause}`;

  const rows = await db.all<{
    id: string;
    email: string;
    name: string | null;
    lastEmailAt: number;
    unreadCount: number;
    totalCount: number;
    recipientCount: number;
    hasAttachment: number;
  }>(sql`
    SELECT
      s.id,
      s.email,
      s.name,
      MAX(e.received_at) AS lastEmailAt,
      SUM(CASE WHEN e.is_read = 0 THEN 1 ELSE 0 END) AS unreadCount,
      COUNT(*) AS totalCount,
      COUNT(DISTINCT e.recipient) AS recipientCount,
      EXISTS(
        SELECT 1 FROM ${attachments} a
        JOIN ${emails} e2 ON e2.id = a.email_id
        WHERE e2.person_id = s.id
        AND a.content_id IS NULL
      ) AS hasAttachment
    FROM ${emails} e
    JOIN ${people} s ON s.id = e.person_id
    ${whereClause}
    GROUP BY s.id
    ORDER BY lastEmailAt DESC
    LIMIT ${limit} OFFSET ${offset}
  `);

  const countResult = await db.all<{ count: number }>(sql`
    SELECT COUNT(*) AS count FROM (
      SELECT 1 FROM ${emails} e
      JOIN ${people} s ON s.id = e.person_id
      ${whereClause}
      GROUP BY s.id
    )
  `);
  const total = countResult[0]?.count ?? 0;

  return c.json({ data: rows, total, page, limit }, 200);
});

const listPeopleRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["People"],
  description: "List people sorted by most recent email.",
  request: {
    query: z.object({
      q: z
        .string()
        .optional()
        .openapi({ description: "Search person name/email" }),
      recipient: z
        .string()
        .optional()
        .openapi({ description: "Filter by recipient address" }),
      personId: z
        .string()
        .optional()
        .openapi({ description: "Filter by person ID" }),
      page: z.coerce.number().optional().default(1),
      limit: z.coerce.number().optional().default(50),
    }),
  },
  responses: {
    ...json200Response(
      z.object({
        data: z.array(PersonSchema),
        total: z.number(),
        page: z.number(),
        limit: z.number(),
      }),
      "Paginated list of people",
    ),
  },
});

peopleRouter.openapi(listPeopleRoute, async (c) => {
  const db = c.get("db");
  const { q, recipient, personId, page, limit } = c.req.valid("query");
  const offset = (page - 1) * limit;

  // Build WHERE conditions for the emails table
  const conditions: any[] = [];

  if (q) {
    const pattern = `%${escapeLike(q)}%`;
    conditions.push(
      sql`(s.email LIKE ${pattern} ESCAPE '\\' OR s.name LIKE ${pattern} ESCAPE '\\')`,
    );
  }

  if (recipient) {
    conditions.push(sql`e.recipient = ${recipient}`);
  }

  if (personId) {
    conditions.push(sql`s.id = ${personId}`);
  }

  const allowed = c.get("allowedInboxes")!;
  const scopeClause = peopleScopeClause(allowed);
  const extraConditions =
    conditions.length > 0
      ? sql`AND ${sql.join(conditions, sql` AND `)}`
      : sql``;
  const whereClause = sql`WHERE 1=1 ${extraConditions} ${scopeClause}`;

  // Group by (person, recipient) to get per-thread stats
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
        WHERE e2.person_id = s.id AND e2.recipient = e.recipient
        ORDER BY e2.received_at DESC LIMIT 1
      ) AS latestSubject
    FROM ${emails} e
    JOIN ${people} s ON s.id = e.person_id
    ${whereClause}
    GROUP BY s.id, e.recipient
    ORDER BY lastEmailAt DESC
    LIMIT ${limit} OFFSET ${offset}
  `);

  // Get total count of (person, recipient) pairs
  const countResult = await db.all<{ count: number }>(sql`
    SELECT COUNT(*) AS count FROM (
      SELECT 1 FROM ${emails} e
      JOIN ${people} s ON s.id = e.person_id
      ${whereClause}
      GROUP BY s.id, e.recipient
    )
  `);
  const total = countResult[0]?.count ?? 0;

  return c.json({ data: rows, total, page, limit }, 200);
});

const getPersonRoute = createRoute({
  method: "get",
  path: "/{id}",
  tags: ["People"],
  description: "Get person detail.",
  request: {
    params: z.object({
      id: z.string(),
    }),
  },
  responses: {
    ...json200Response(PersonSchema, "Person detail"),
  },
});

peopleRouter.openapi(getPersonRoute, async (c) => {
  const db = c.get("db");
  const { id } = c.req.valid("param");

  const rows = await db.select().from(people).where(eq(people.id, id)).limit(1);

  if (rows.length === 0) {
    return c.json({ error: "Person not found" }, 404);
  }

  const allowed = c.get("allowedInboxes")!;
  if (!allowed.isAdmin) {
    if (allowed.inboxes.length === 0) {
      return c.json({ error: "Person not found" }, 404);
    }
    const match = await db
      .select({ id: emails.id })
      .from(emails)
      .where(
        and(
          eq(emails.personId, id),
          inArray(emails.recipient, allowed.inboxes),
        ),
      )
      .limit(1);
    if (match.length === 0) {
      return c.json({ error: "Person not found" }, 404);
    }
  }

  return c.json(rows[0], 200);
});
