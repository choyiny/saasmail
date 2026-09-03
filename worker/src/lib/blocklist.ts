import { and, eq, or, sql } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import type { schema } from "../db/schema";
import { blocklist } from "../db/blocklist.schema";
import { emails } from "../db/emails.schema";
import { people } from "../db/people.schema";

export type Database = DrizzleD1Database<typeof schema>;

/**
 * Lowercased domain part of an email address (everything after the last "@").
 * Well-formed stored addresses have exactly one "@", so this agrees with the
 * first-"@" `substr(..., instr(..., '@')+1)` expression used in the SQL paths
 * (people-router hiding, purge selection).
 */
export function domainOf(email: string): string {
  const at = email.lastIndexOf("@");
  return at === -1 ? "" : email.slice(at + 1).toLowerCase();
}

/** True if the sender email (exact) or its domain is on the blocklist. */
export async function isBlocked(db: Database, email: string): Promise<boolean> {
  const addr = email.trim().toLowerCase();
  const domain = domainOf(addr);
  const row = await db.query.blocklist.findFirst({
    where: or(
      and(eq(blocklist.type, "email"), eq(blocklist.value, addr)),
      and(eq(blocklist.type, "domain"), eq(blocklist.value, domain)),
    ),
    columns: { id: true },
  });
  return !!row;
}

/**
 * Mark every unread received email from senders matching a block rule as read,
 * and recompute `people.unread_count`. Keeps the nav unread badge honest once
 * the people list has hidden those senders — without teaching `/api/stats` about
 * the blocklist.
 */
export async function markBlockedSendersRead(
  db: Database,
  type: "email" | "domain",
  value: string,
): Promise<{ emailsMarked: number; peopleTouched: number }> {
  const personMatch =
    type === "email"
      ? sql`p.email = ${value}`
      : sql`lower(substr(p.email, instr(p.email, '@') + 1)) = ${value}`;

  const unread = await db.all<{ id: string; person_id: string }>(sql`
    SELECT e.id, e.person_id
    FROM ${emails} e
    JOIN ${people} p ON p.id = e.person_id
    WHERE e.is_read = 0 AND ${personMatch}
  `);
  if (unread.length === 0) {
    return { emailsMarked: 0, peopleTouched: 0 };
  }

  const emailIds = unread.map((r) => r.id);
  const personIds = Array.from(new Set(unread.map((r) => r.person_id)));

  // Chunk updates in case a domain block hits a large mailbox (D1 100-param cap).
  const CHUNK = 90;
  for (let i = 0; i < emailIds.length; i += CHUNK) {
    const chunk = emailIds.slice(i, i + CHUNK);
    await db
      .update(emails)
      .set({ isRead: 1 })
      .where(sql`${emails.id} IN ${chunk}`);
  }

  for (const pid of personIds) {
    const [row] = await db.all<{ count: number }>(sql`
      SELECT COUNT(*) AS count FROM ${emails}
      WHERE person_id = ${pid} AND is_read = 0
    `);
    await db
      .update(people)
      .set({ unreadCount: row?.count ?? 0 })
      .where(eq(people.id, pid));
  }

  return { emailsMarked: emailIds.length, peopleTouched: personIds.length };
}
