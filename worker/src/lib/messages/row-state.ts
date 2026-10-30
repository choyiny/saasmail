import { and, eq, sql } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { userRowPins } from "../../db/user-row-pins.schema";
import { jsonList, type AllowedInboxes } from "../inbox-permissions";
import {
  buildMessageQuerySql,
  MESSAGE_REFS_PER_QUERY,
  type MessageQuery,
} from "./query";
import { setUserState } from "./state";
import type { MessageKind, MessageRef } from "./types";

/**
 * The inbox list's rows (`computeGroupedRows` in people-router.ts) read and
 * written through the per-message state: a person row holds that person's
 * mail outside any group conversation, a group row the mail of one
 * conversation. See docs/mailbox-state.md § Rows in the inbox list.
 */

/** Most messages one row-state request may touch (HTTP boundary limit). */
export const MAX_ROW_STATE_MESSAGES = 5000;

export type RowType = "person" | "group";
export type RowRef = { type: RowType; id: string };

export const rowKey = (ref: RowRef) => `${ref.type}:${ref.id}`;

export type RowMailState = {
  starred: boolean;
  pinned: boolean;
  trashedAt: number | null;
  archivedAt: number | null;
  snoozedUntil: number | null;
  inInbox: boolean;
  /** Unseen eligible received messages. */
  unreadCount: number;
  /** Unseen received messages in Inbox whose conversation is not snoozed. */
  inboxUnreadCount: number;
};

/** A row's message as the row actions need it. */
export type RowMessage = {
  kind: MessageKind;
  id: string;
  inbox: string;
  personId: string | null;
  conversationId: string | null;
  archivedAt: number | null;
  spamAt: number | null;
  trashedAt: number | null;
  starredAt: number | null;
  conversationKey: string | null;
  /** The conversation's wake time while it is snoozed, else null. */
  snoozedUntil: number | null;
  occurredAt: number;
};

/**
 * The message query for some rows: person rows by person (outside any group
 * conversation), group rows by conversation. Each list is bound as one JSON
 * value, so any number of rows stays under D1's 100-parameter limit.
 */
function rowQueries(
  items: RowRef[] | undefined,
): Array<
  Pick<MessageQuery, "personIds" | "conversationId" | "conversationIds">
> {
  if (items === undefined) return [{}];
  const personIds = items.filter((i) => i.type === "person").map((i) => i.id);
  const conversationIds = items
    .filter((i) => i.type === "group")
    .map((i) => i.id);
  const out: Array<
    Pick<MessageQuery, "personIds" | "conversationId" | "conversationIds">
  > = [];
  if (personIds.length > 0) out.push({ personIds, conversationId: null });
  if (conversationIds.length > 0) out.push({ conversationIds });
  return out;
}

/** The row a message belongs to, as SQL over the message query's columns. */
const ROW_TYPE = sql.raw(
  `CASE WHEN conversation_id IS NULL THEN 'person' ELSE 'group' END`,
);
const ROW_ID = sql.raw(`COALESCE(conversation_id, person_id)`);

/**
 * Star, pin, archive, trash, snooze and unread for every row with an eligible
 * (not spam) message in the viewer's inboxes, or only for `items`. A row with
 * no eligible message is absent from the map: it is in no folder of the list.
 */
export async function rowMailState(
  db: DrizzleD1Database<any>,
  viewer: { userId: string },
  allowed: AllowedInboxes,
  now: number,
  items?: RowRef[],
): Promise<Map<string, RowMailState>> {
  const out = new Map<string, RowMailState>();
  for (const filter of rowQueries(items)) {
    const built = buildMessageQuerySql(allowed, {
      ...filter,
      viewer,
      withState: true,
      limit: null,
      now,
    });
    if (!built) continue;
    const rows = await db.all<{
      type: RowType;
      id: string;
      starred: number;
      untrashed: number;
      last_trashed: number | null;
      inbox_state: number;
      inbox_awake: number;
      inbox_snoozed: number;
      earliest_wake: number | null;
      archived: number;
      last_archived: number | null;
      unseen: number;
      inbox_unseen: number;
    }>(sql`
      SELECT
        type,
        id,
        MAX(starred_at IS NOT NULL) AS starred,
        SUM(trashed_at IS NULL) AS untrashed,
        MAX(trashed_at) AS last_trashed,
        SUM(in_inbox) AS inbox_state,
        SUM(in_inbox AND snoozed_until IS NULL) AS inbox_awake,
        SUM(in_inbox AND snoozed_until IS NOT NULL) AS inbox_snoozed,
        MIN(CASE WHEN in_inbox THEN snoozed_until END) AS earliest_wake,
        SUM(kind = 'received' AND archived_at IS NOT NULL AND trashed_at IS NULL) AS archived,
        MAX(CASE WHEN kind = 'received' AND trashed_at IS NULL THEN archived_at END) AS last_archived,
        SUM(unseen) AS unseen,
        SUM(unseen AND in_inbox AND snoozed_until IS NULL) AS inbox_unseen
      FROM (
        SELECT
          ${ROW_TYPE} AS type,
          ${ROW_ID} AS id,
          kind,
          starred_at,
          archived_at,
          trashed_at,
          snoozed_until,
          (kind = 'received' AND archived_at IS NULL AND trashed_at IS NULL) AS in_inbox,
          (kind = 'received' AND CASE WHEN user_state_present = 1
            THEN seen_at IS NULL ELSE is_read = 0 END) AS unseen
        FROM (${built.statement})
        WHERE spam_at IS NULL
      )
      WHERE id IS NOT NULL
      GROUP BY type, id
    `);
    for (const r of rows) {
      const trashed = r.untrashed === 0;
      out.set(rowKey(r), {
        starred: r.starred === 1,
        pinned: false,
        trashedAt: trashed ? r.last_trashed : null,
        archivedAt:
          !trashed && r.inbox_state === 0 && r.archived > 0
            ? r.last_archived
            : null,
        snoozedUntil:
          r.inbox_state > 0 && r.inbox_snoozed === r.inbox_state
            ? r.earliest_wake
            : null,
        inInbox: r.inbox_awake > 0,
        unreadCount: r.unseen,
        inboxUnreadCount: r.inbox_unseen,
      });
    }
  }

  const pinWhere = [eq(userRowPins.userId, viewer.userId)];
  if (items !== undefined) {
    pinWhere.push(
      sql`(${userRowPins.itemType} || ':' || ${userRowPins.itemId}) IN ${jsonList(items.map(rowKey))}`,
    );
  }
  const pins = await db
    .select({ type: userRowPins.itemType, id: userRowPins.itemId })
    .from(userRowPins)
    .where(and(...pinWhere));
  for (const pin of pins) {
    // A pin whose row has no eligible message left is never shown.
    const state = out.get(`${pin.type}:${pin.id}`);
    if (state) state.pinned = true;
  }
  return out;
}

/**
 * The messages of some rows in the caller's inboxes, with the viewer's state,
 * newest first, at most `limit` of them (callers pass one over their cap to
 * tell "at the cap" from "over it").
 */
export async function rowMessages(
  db: DrizzleD1Database<any>,
  allowed: AllowedInboxes,
  viewer: { userId: string },
  items: RowRef[],
  now: number,
  limit: number,
): Promise<RowMessage[]> {
  const out: RowMessage[] = [];
  for (const filter of rowQueries(items)) {
    const built = buildMessageQuerySql(allowed, {
      ...filter,
      viewer,
      withState: true,
      limit: null,
      now,
    });
    if (!built) continue;
    const rows = await db.all<{
      kind: MessageKind;
      id: string;
      inbox: string;
      person_id: string | null;
      conversation_id: string | null;
      archived_at: number | null;
      spam_at: number | null;
      trashed_at: number | null;
      starred_at: number | null;
      conversation_key: string | null;
      snoozed_until: number | null;
      occurred_at: number;
    }>(sql`
      SELECT kind, id, inbox, person_id, conversation_id, archived_at, spam_at,
        trashed_at, starred_at, conversation_key, snoozed_until, occurred_at
      FROM (${built.statement})
      LIMIT ${limit - out.length}
    `);
    for (const r of rows) {
      out.push({
        kind: r.kind,
        id: r.id,
        inbox: r.inbox,
        personId: r.person_id,
        conversationId: r.conversation_id,
        archivedAt: r.archived_at,
        spamAt: r.spam_at,
        trashedAt: r.trashed_at,
        starredAt: r.starred_at,
        conversationKey: r.conversation_key,
        snoozedUntil: r.snoozed_until,
        occurredAt: r.occurred_at,
      });
    }
    if (out.length >= limit) break;
  }
  return out;
}

/** Which of `items` have at least one message in the caller's inboxes. */
export async function visibleRows(
  db: DrizzleD1Database<any>,
  allowed: AllowedInboxes,
  items: RowRef[],
): Promise<Set<string>> {
  const out = new Set<string>();
  for (const filter of rowQueries(items)) {
    const built = buildMessageQuerySql(allowed, { ...filter, limit: null });
    if (!built) continue;
    const rows = await db.all<{ type: RowType; id: string }>(sql`
      SELECT DISTINCT ${ROW_TYPE} AS type, ${ROW_ID} AS id
      FROM (${built.statement})
    `);
    for (const r of rows) if (r.id !== null) out.add(rowKey(r));
  }
  return out;
}

/**
 * Mark as seen, for one user, the received messages they have not seen among
 * some people's or conversations' mail (the inbox list's "mark read"). The
 * caller still updates `emails.is_read`; this is what the list's unread count
 * reads (docs/mailbox-state.md § Rows in the inbox list).
 */
export async function markSeenForViewer(
  db: DrizzleD1Database<any>,
  userId: string,
  allowed: AllowedInboxes,
  filter: Pick<MessageQuery, "personIds" | "conversationIds" | "inboxes">,
): Promise<void> {
  const built = buildMessageQuerySql(allowed, {
    ...filter,
    viewer: { userId },
    unseen: true,
    limit: null,
  });
  if (!built) return;
  const rows = await db.all<{ id: string }>(
    sql`SELECT id FROM (${built.statement}) WHERE kind = 'received'`,
  );
  const refs: MessageRef[] = rows.map((r) => ({ kind: "received", id: r.id }));
  for (let start = 0; start < refs.length; start += MESSAGE_REFS_PER_QUERY) {
    await setUserState(
      db,
      userId,
      refs.slice(start, start + MESSAGE_REFS_PER_QUERY),
      {
        seen: true,
      },
    );
  }
}

/** The row a message belongs to. */
export function rowOf(message: RowMessage): RowRef | null {
  if (message.conversationId)
    return { type: "group", id: message.conversationId };
  if (message.personId) return { type: "person", id: message.personId };
  return null;
}
