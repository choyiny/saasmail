import { and, eq, inArray, sql } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { people } from "../../db/people.schema";
import { emails } from "../../db/emails.schema";
import { sentEmails } from "../../db/sent-emails.schema";
import { escapeLike } from "../helpers";
import {
  inboxScopeSql,
  jsonList,
  type AllowedInboxes,
} from "../inbox-permissions";

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
  // The grant is bound once, as JSON, and shared by both arms (D1 takes at
  // most 100 bound parameters per statement).
  return sql`AND s.id IN (
    WITH scope_inboxes(value) AS (SELECT value FROM json_each(${JSON.stringify(allowed.inboxes)}))
    SELECT person_id FROM emails WHERE recipient IN (SELECT value FROM scope_inboxes)
    UNION
    SELECT person_id FROM sent_emails WHERE from_address IN (SELECT value FROM scope_inboxes) AND person_id IS NOT NULL
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
  // `peopleScopeClause` decides WHICH PEOPLE are visible; it does not constrain
  // which of their (person, inbox) pairs are. Without this second clause a
  // contact who wrote to both an allowed inbox and a private one produced a row
  // for the private inbox too — leaking its address, message counts, and
  // latestSubject to a member who cannot read any of its mail.
  const recipientScope = inboxScopeSql(allowed, sql`e.recipient`);
  const extraConditions =
    conditions.length > 0
      ? sql`AND ${sql.join(conditions, sql` AND `)}`
      : sql``;
  const whereClause = sql`WHERE 1=1 ${extraConditions} ${scopeClause} ${recipientScope}`;

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
    // The row's counters and timestamps span every inbox; a member gets them
    // recomputed over the mail in their own inboxes (received and sent, as
    // the grouped list counts them), so a sender who also wrote to a private
    // inbox shows none of that mail's counts or recency.
    const inboxes = jsonList(allowed.inboxes);
    const [scoped] = await db.all<{
      total: number;
      unread: number;
      first: number | null;
      last: number | null;
    }>(sql`
      SELECT COUNT(*) AS total,
             COALESCE(SUM(CASE WHEN is_read = 0 THEN 1 ELSE 0 END), 0) AS unread,
             MIN(at) AS first,
             MAX(at) AS last
        FROM (
          SELECT received_at AS at, is_read FROM ${emails}
           WHERE person_id = ${id} AND recipient IN ${inboxes}
          UNION ALL
          SELECT sent_at AS at, 1 AS is_read FROM ${sentEmails}
           WHERE person_id = ${id} AND from_address IN ${inboxes}
        )
    `);
    if (!scoped || Number(scoped.total) === 0) {
      return null;
    }
    const person = rows[0];
    return {
      id: person.id,
      email: person.email,
      name: person.name,
      lastEmailAt: Number(scoped.last),
      unreadCount: Number(scoped.unread),
      totalCount: Number(scoped.total),
      createdAt: Number(scoped.first),
      updatedAt: Number(scoped.last),
    } as PersonRow;
  }

  return rows[0];
}
