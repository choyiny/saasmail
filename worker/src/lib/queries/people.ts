import { and, eq, inArray, sql } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { people } from "../../db/people.schema";
import { emails } from "../../db/emails.schema";
import { escapeLike } from "../helpers";
import type { AllowedInboxes } from "../inbox-permissions";

export type PersonRow = typeof people.$inferSelect;

export type PersonListRow = {
  id: string;
  email: string;
  name: string | null;
  recipient: string;
  lastEmailAt: number;
  unreadCount: number;
  totalCount: number;
  latestSubject: string | null;
};

export type ListPeopleOptions = {
  q?: string;
  recipient?: string;
  personId?: string;
  page: number;
  limit: number;
};

export type ListPeopleResult = {
  data: PersonListRow[];
  total: number;
  page: number;
  limit: number;
};

/**
 * SQL fragment restricting a `people s` join to the caller's allowed inboxes.
 * Returned as a bare `AND ...` chunk so callers can splice it into an existing
 * `WHERE 1=1` clause alongside their own filters.
 */
export function peopleScopeClause(allowed: AllowedInboxes) {
  if (allowed.isAdmin) return sql``;
  if (allowed.inboxes.length === 0)
    return sql`AND s.id IN (SELECT NULL WHERE 0)`;
  // A person is in scope if they emailed one of our allowed inboxes OR if we
  // sent them mail from one of our allowed inboxes.
  return sql`AND s.id IN (
    SELECT person_id FROM emails WHERE recipient IN ${allowed.inboxes}
    UNION
    SELECT person_id FROM sent_emails WHERE from_address IN ${allowed.inboxes} AND person_id IS NOT NULL
  )`;
}

/**
 * List people as (person, recipient) pairs sorted by most recent email,
 * scoped to the inboxes the caller may see.
 */
export async function listPeople(
  db: DrizzleD1Database<any>,
  opts: ListPeopleOptions,
  allowed: AllowedInboxes,
): Promise<ListPeopleResult> {
  const { q, recipient, personId, page, limit } = opts;
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

  const scopeClause = peopleScopeClause(allowed);
  const extraConditions =
    conditions.length > 0
      ? sql`AND ${sql.join(conditions, sql` AND `)}`
      : sql``;
  const whereClause = sql`WHERE 1=1 ${extraConditions} ${scopeClause}`;

  // Group by (person, recipient) to get per-thread stats
  const rows = await db.all<PersonListRow>(sql`
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

  return { data: rows, total, page, limit };
}

/**
 * Fetch a person by id, but only if the caller may see at least one email
 * they sent to an allowed inbox. Null covers both "no such person" and
 * "not permitted" so callers can't distinguish the two.
 */
export async function getPersonScoped(
  db: DrizzleD1Database<any>,
  id: string,
  allowed: AllowedInboxes,
): Promise<PersonRow | null> {
  const rows = await db.select().from(people).where(eq(people.id, id)).limit(1);

  if (rows.length === 0) {
    return null;
  }

  if (!allowed.isAdmin) {
    if (allowed.inboxes.length === 0) {
      return null;
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
      return null;
    }
  }

  return rows[0];
}
