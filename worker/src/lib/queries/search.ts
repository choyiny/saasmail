import { inArray } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { people } from "../../db/people.schema";
import { queryMessages } from "../messages/query";
import type { AllowedInboxes } from "../inbox-permissions";

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
  /** True when another reachable page exists before MAX_SCAN. */
  hasMore: boolean;
  /** True when matches exist beyond the MAX_SCAN search ceiling. */
  truncated: boolean;
};

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
 * This is the compatibility wrapper behind GET /api/emails/search and MCP.
 * Received messages reuse the existing emails_fts index; sent messages use
 * LIKE on subject/body. queryMessages owns the union, permission scoping and
 * deterministic cross-source ordering.
 */
export async function searchEmails(
  db: DrizzleD1Database<any>,
  opts: SearchEmailsOptions,
  allowed: AllowedInboxes,
): Promise<SearchEmailsResult> {
  const { q, inbox, personId, after, before, limit, offset } = opts;

  if (offset >= MAX_SCAN) {
    return { hits: [], hasMore: false, truncated: true };
  }

  const reachable = Math.max(MAX_SCAN - offset, 0);
  const effectiveLimit = Math.min(Math.max(limit, 0), reachable);
  if (effectiveLimit === 0) {
    return { hits: [], hasMore: false, truncated: false };
  }

  const page = await queryMessages(db, allowed, {
    search: q,
    searchMode: "fulltext",
    excludeBlocked: true,
    inboxes: inbox !== undefined ? [inbox] : undefined,
    personId,
    after,
    before,
    offset,
    limit: effectiveLimit,
  });
  const messages = page.messages;

  const personIds = [
    ...new Set(
      messages
        .map((message) => message.personId)
        .filter((id): id is string => !!id),
    ),
  ];
  const personRows =
    personIds.length > 0
      ? await db
          .select({
            id: people.id,
            email: people.email,
            name: people.name,
          })
          .from(people)
          .where(inArray(people.id, personIds))
      : [];
  const personById = new Map(personRows.map((person) => [person.id, person]));

  const hits: SearchHit[] = messages.map((message) => {
    const person = message.personId
      ? personById.get(message.personId)
      : undefined;
    return {
      id: message.ref.id,
      type: message.ref.kind,
      personId: message.personId,
      personEmail: person?.email ?? null,
      personName: person?.name ?? null,
      inbox: message.inbox,
      subject: message.subject,
      snippet: excerpt(message.bodyText),
      timestamp: message.occurredAt,
      isRead: message.isRead === null ? null : message.isRead ? 1 : 0,
    };
  });

  const reachedCeiling = offset + effectiveLimit >= MAX_SCAN;
  return {
    hits,
    hasMore: reachedCeiling ? false : page.hasMore,
    truncated: reachedCeiling && page.hasMore,
  };
}
