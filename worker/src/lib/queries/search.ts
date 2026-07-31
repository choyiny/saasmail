import { sql } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { inboxScopeSql, type AllowedInboxes } from "../inbox-permissions";
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
  /**
   * True when the result set was clipped at MAX_SCAN. The caller should narrow
   * the query rather than page further — later pages are not reachable.
   */
  truncated: boolean;
};

/**
 * Hard ceiling on rows pulled from either table for one search.
 *
 * Both queries fetch whole bodies, and the merge happens in the isolate, so an
 * unbounded `offset + limit` would let a caller ask for page 5000 and drag the
 * entire matching corpus through D1 into memory to return nothing. Refining a
 * query is the right move for a text search; deep paging is not.
 */
const MAX_SCAN = 500;

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

  // Nothing is visible to a member with no inbox grants. This branch is
  // load-bearing, not defensive: `IN ()` is a SQLite syntax error, so the
  // scope fragments below cannot express "match nothing" for an empty list.
  if (!allowed.isAdmin && allowed.inboxes.length === 0) {
    return { hits: [], hasMore: false, truncated: false };
  }

  // Beyond the scan ceiling there is nothing left to page through.
  if (offset >= MAX_SCAN) {
    return { hits: [], hasMore: false, truncated: true };
  }

  // Over-fetch by one so `hasMore` is known without a COUNT.
  const window = Math.min(offset + limit + 1, MAX_SCAN);

  const ftsQuery = escapeFts(q);
  const likePattern = `%${escapeLike(q)}%`;

  const receivedScope = inboxScopeSql(allowed, sql`e.recipient`);
  const sentScope = inboxScopeSql(allowed, sql`se.from_address`);

  // `!== undefined` rather than truthiness: 0 is a legitimate Unix timestamp
  // bound, and `""` should not silently widen an inbox filter to everything.
  const receivedInbox =
    inbox !== undefined ? sql`AND e.recipient = ${inbox}` : sql``;
  const sentInbox =
    inbox !== undefined ? sql`AND se.from_address = ${inbox}` : sql``;
  const receivedPerson =
    personId !== undefined ? sql`AND e.person_id = ${personId}` : sql``;
  const sentPerson =
    personId !== undefined ? sql`AND se.person_id = ${personId}` : sql``;
  const receivedAfter =
    after !== undefined ? sql`AND e.received_at >= ${after}` : sql``;
  const receivedBefore =
    before !== undefined ? sql`AND e.received_at <= ${before}` : sql``;
  const sentAfter =
    after !== undefined ? sql`AND se.sent_at >= ${after}` : sql``;
  const sentBefore =
    before !== undefined ? sql`AND se.sent_at <= ${before}` : sql``;

  // Blocking a sender is expected to hide their existing mail, not merely stop
  // new mail — the web UI filters these out, so search must too or an
  // assistant resurfaces exactly the correspondence a user blocked.
  const notBlocked = sql`AND NOT EXISTS (
    SELECT 1 FROM blocklist b
    WHERE (b.type = 'email'  AND b.value = p.email)
       OR (b.type = 'domain' AND b.value = lower(substr(p.email, instr(p.email, '@') + 1)))
  )`;

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
      ${receivedAfter} ${receivedBefore} ${notBlocked}
    ORDER BY e.received_at DESC, e.id DESC
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
      ${sentAfter} ${sentBefore} ${notBlocked}
    ORDER BY se.sent_at DESC, se.id DESC
    LIMIT ${window}
  `);

  type Row = Omit<SearchHit, "snippet"> & { body: string | null };

  const merged: Row[] = [
    ...receivedRows.map((r) => ({
      id: r.id,
      type: "received" as const,
      personId: r.person_id,
      personEmail: r.person_email,
      personName: r.person_name,
      inbox: r.inbox,
      subject: r.subject,
      body: r.body_text,
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
      body: r.body_text,
      timestamp: r.timestamp,
      isRead: null,
    })),
    // Tie-break on id so equal timestamps order identically on every call —
    // bulk imports and sequence blasts produce many rows sharing a second, and
    // an unstable order makes a message appear on two pages while another is
    // never returned at all. Matches the SQL ORDER BY above.
  ].sort((a, b) => b.timestamp - a.timestamp || (a.id < b.id ? 1 : -1));

  // Build excerpts only for the rows actually returned; doing it during the
  // map above ran the whitespace regex over every fetched body.
  const hits: SearchHit[] = merged
    .slice(offset, offset + limit)
    .map(({ body, ...rest }) => ({ ...rest, snippet: excerpt(body) }));

  return {
    hits,
    hasMore: merged.length > offset + limit,
    truncated: merged.length >= MAX_SCAN,
  };
}
