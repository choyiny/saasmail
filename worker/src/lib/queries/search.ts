import { sql } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import type { AllowedInboxes } from "../inbox-permissions";
import { escapeFts, escapeLike } from "../helpers";

export type SearchEmailsOptions = {
  /** Free-text query. Matched against subject and body. */
  q: string;
  /** Restrict to a single inbox address. */
  inbox?: string;
  /** Restrict to one contact. */
  personId?: string;
  /** Unix-seconds bounds on the message timestamp. */
  after?: number;
  before?: number;
  limit: number;
  offset: number;
};

export type SearchHit = {
  id: string;
  type: "received" | "sent";
  personId: string | null;
  personEmail: string | null;
  personName: string | null;
  /** The inbox this message belongs to: recipient in, fromAddress out. */
  inbox: string;
  subject: string | null;
  /** Short excerpt of the body, for ranking by eye without a second call. */
  snippet: string | null;
  timestamp: number;
  isRead: number | null;
};

export type SearchEmailsResult = {
  hits: SearchHit[];
  /** True when more rows exist past `limit`. */
  hasMore: boolean;
};

/** Collapse whitespace and clip, so a hit is scannable in a tool result. */
function excerpt(body: string | null, max = 200): string | null {
  if (!body) return null;
  const flat = body.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/**
 * Full-text search across a caller's mail.
 *
 * Received messages go through the `emails_fts` FTS5 index; sent messages have
 * no FTS index, so they are matched with LIKE on subject and body. The two
 * sides are merged and sorted in JS, the same shape `listPersonEmails` uses —
 * SQLite cannot rank an FTS match and a LIKE scan against each other.
 *
 * There is no HTTP equivalent of this query: the app's only text search is
 * person-grouped, inside GET /api/people/grouped. This returns message-level
 * hits, which is what an assistant asking "find the mail about X" needs.
 */
export async function searchEmails(
  db: DrizzleD1Database<any>,
  opts: SearchEmailsOptions,
  allowed: AllowedInboxes,
): Promise<SearchEmailsResult> {
  const { q, inbox, personId, after, before, limit, offset } = opts;

  // Nothing is visible to a member with no inbox grants.
  if (!allowed.isAdmin && allowed.inboxes.length === 0) {
    return { hits: [], hasMore: false };
  }

  // Over-fetch by one so `hasMore` is known without a COUNT.
  const window = offset + limit + 1;

  const ftsQuery = escapeFts(q);
  const likePattern = `%${escapeLike(q)}%`;

  const receivedScope = allowed.isAdmin
    ? sql``
    : sql`AND e.recipient IN ${allowed.inboxes}`;
  const sentScope = allowed.isAdmin
    ? sql``
    : sql`AND se.from_address IN ${allowed.inboxes}`;

  const receivedInbox = inbox ? sql`AND e.recipient = ${inbox}` : sql``;
  const sentInbox = inbox ? sql`AND se.from_address = ${inbox}` : sql``;
  const receivedPerson = personId ? sql`AND e.person_id = ${personId}` : sql``;
  const sentPerson = personId ? sql`AND se.person_id = ${personId}` : sql``;
  const receivedAfter = after ? sql`AND e.received_at >= ${after}` : sql``;
  const receivedBefore = before ? sql`AND e.received_at <= ${before}` : sql``;
  const sentAfter = after ? sql`AND se.sent_at >= ${after}` : sql``;
  const sentBefore = before ? sql`AND se.sent_at <= ${before}` : sql``;

  const receivedRows = await db.all<{
    id: string;
    person_id: string | null;
    person_email: string | null;
    person_name: string | null;
    inbox: string;
    subject: string | null;
    body_text: string | null;
    timestamp: number;
    is_read: number;
  }>(sql`
    SELECT e.id, e.person_id, p.email AS person_email, p.name AS person_name,
           e.recipient AS inbox, e.subject, e.body_text,
           e.received_at AS timestamp, e.is_read
    FROM emails e
    JOIN emails_fts ON e.rowid = emails_fts.rowid
    LEFT JOIN people p ON p.id = e.person_id
    WHERE emails_fts MATCH ${ftsQuery}
      ${receivedScope} ${receivedInbox} ${receivedPerson}
      ${receivedAfter} ${receivedBefore}
    ORDER BY e.received_at DESC
    LIMIT ${window}
  `);

  const sentRows = await db.all<{
    id: string;
    person_id: string | null;
    person_email: string | null;
    person_name: string | null;
    inbox: string;
    subject: string | null;
    body_text: string | null;
    timestamp: number;
  }>(sql`
    SELECT se.id, se.person_id, p.email AS person_email, p.name AS person_name,
           se.from_address AS inbox, se.subject, se.body_text,
           se.sent_at AS timestamp
    FROM sent_emails se
    LEFT JOIN people p ON p.id = se.person_id
    WHERE (se.subject LIKE ${likePattern} ESCAPE '\\'
           OR se.body_text LIKE ${likePattern} ESCAPE '\\')
      ${sentScope} ${sentInbox} ${sentPerson}
      ${sentAfter} ${sentBefore}
    ORDER BY se.sent_at DESC
    LIMIT ${window}
  `);

  const merged: SearchHit[] = [
    ...receivedRows.map((r) => ({
      id: r.id,
      type: "received" as const,
      personId: r.person_id,
      personEmail: r.person_email,
      personName: r.person_name,
      inbox: r.inbox,
      subject: r.subject,
      snippet: excerpt(r.body_text),
      timestamp: r.timestamp,
      isRead: r.is_read,
    })),
    ...sentRows.map((r) => ({
      id: r.id,
      type: "sent" as const,
      personId: r.person_id,
      personEmail: r.person_email,
      personName: r.person_name,
      inbox: r.inbox,
      subject: r.subject,
      snippet: excerpt(r.body_text),
      timestamp: r.timestamp,
      isRead: null,
    })),
  ].sort((a, b) => b.timestamp - a.timestamp);

  const page = merged.slice(offset, offset + limit);
  return { hits: page, hasMore: merged.length > offset + limit };
}
