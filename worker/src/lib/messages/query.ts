import { and, eq, inArray, or, sql, type SQL } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { attachments } from "../../db/attachments.schema";
import { escapeFts, escapeLike } from "../helpers";
import { inboxScopeSql, type AllowedInboxes } from "../inbox-permissions";
import {
  adaptReceived,
  adaptSent,
  type ReceivedSelect,
  type SentSelect,
} from "./adapters";
import { decodeCursor, encodeCursor } from "./cursor";
import type { MessageCursorV1 } from "./cursor";
import type { AttachmentRow, MessageKind, UnifiedMessage } from "./types";

export type MessageSearchMode = "subject" | "fulltext";

export interface MessageQuery {
  inboxes?: string[];
  personId?: string;
  conversationId?: string;
  direction?: "inbound" | "outbound";
  after?: number;
  before?: number;
  search?: string;
  searchMode?: MessageSearchMode;
  excludeBlocked?: boolean;
  /** Null requests the full matching result set; numeric limits are not service-capped. */
  limit?: number | null;
  cursor?: string;
  offset?: number;
  order?: "desc" | "asc";
  withAttachmentCounts?: boolean;
  withAttachments?: boolean;
}

export interface MessagePage {
  messages: UnifiedMessage[];
  nextCursor: string | null;
  hasMore: boolean;
}

type RawMessageRow = {
  kind: MessageKind;
  id: string;
  person_id: string | null;
  inbox: string;
  conversation_id: string | null;
  message_id: string | null;
  in_reply_to: string | null;
  from_email: string | null;
  from_name: string | null;
  to_email: string;
  to_name: string | null;
  cc: string | null;
  subject: string | null;
  body_text: string | null;
  body_html: string | null;
  occurred_at: number;
  is_read: number | null;
  campaign_id: string | null;
  sequence_id: string | null;
  sequence_enrollment_id: string | null;
  delivery_status: string | null;
};

function normalizeInboxes(inboxes: string[] | undefined): string[] | undefined {
  if (inboxes === undefined) return undefined;
  return [
    ...new Set(inboxes.map((value) => value.trim().toLowerCase())),
  ].filter(Boolean);
}

function explicitInboxScope(column: SQL, inboxes: string[] | undefined): SQL {
  if (inboxes === undefined) return sql``;
  if (inboxes.length === 0) return sql`AND 0`;
  return sql`AND ${column} IN ${inboxes}`;
}

function personScope(column: SQL, personId: string | undefined): SQL {
  return personId === undefined ? sql`` : sql`AND ${column} = ${personId}`;
}

function conversationScope(
  column: SQL,
  conversationId: string | undefined,
): SQL {
  return conversationId === undefined
    ? sql``
    : sql`AND ${column} = ${conversationId}`;
}

function dateScope(
  column: SQL,
  after: number | undefined,
  before: number | undefined,
): SQL {
  const lower = after === undefined ? sql`` : sql`AND ${column} >= ${after}`;
  const upper = before === undefined ? sql`` : sql`AND ${column} <= ${before}`;
  return sql`${lower} ${upper}`;
}

function blockedScope(enabled: boolean): SQL {
  if (!enabled) return sql``;
  return sql`AND NOT EXISTS (
    SELECT 1 FROM blocklist b
    WHERE (b.type = 'email' AND b.value = lower(p.email))
       OR (
         b.type = 'domain'
         AND b.value = lower(substr(p.email, instr(p.email, '@') + 1))
       )
  )`;
}

function receivedSearch(
  search: string | undefined,
  mode: MessageSearchMode,
): { join: SQL; where: SQL } {
  const value = search?.trim();
  if (!value) return { join: sql``, where: sql`` };

  if (mode === "fulltext") {
    return {
      join: sql`JOIN emails_fts ON e.rowid = emails_fts.rowid`,
      where: sql`AND emails_fts MATCH ${escapeFts(value)}`,
    };
  }

  return {
    join: sql``,
    where: sql`AND e.subject LIKE ${`%${escapeLike(value)}%`} ESCAPE '\\'`,
  };
}

function sentSearch(search: string | undefined, mode: MessageSearchMode): SQL {
  const value = search?.trim();
  if (!value) return sql``;

  const pattern = `%${escapeLike(value)}%`;
  return mode === "fulltext"
    ? sql`AND (
        se.subject LIKE ${pattern} ESCAPE '\\'
        OR se.body_text LIKE ${pattern} ESCAPE '\\'
      )`
    : sql`AND se.subject LIKE ${pattern} ESCAPE '\\'`;
}

type ArmWindow = {
  cursor: MessageCursorV1 | null;
  order: "desc" | "asc";
  limit: number | null;
};

function sourceCursorScope(
  timestampColumn: SQL,
  idColumn: SQL,
  kind: MessageKind,
  cursor: MessageCursorV1 | null,
  order: "desc" | "asc",
): SQL {
  if (!cursor) return sql``;

  if (order === "asc") {
    return sql`AND (
      ${timestampColumn} > ${cursor.occurredAt}
      OR (${timestampColumn} = ${cursor.occurredAt} AND ${idColumn} > ${cursor.id})
      OR (
        ${timestampColumn} = ${cursor.occurredAt}
        AND ${idColumn} = ${cursor.id}
        AND ${kind} > ${cursor.kind}
      )
    )`;
  }

  return sql`AND (
    ${timestampColumn} < ${cursor.occurredAt}
    OR (${timestampColumn} = ${cursor.occurredAt} AND ${idColumn} < ${cursor.id})
    OR (
      ${timestampColumn} = ${cursor.occurredAt}
      AND ${idColumn} = ${cursor.id}
      AND ${kind} > ${cursor.kind}
    )
  )`;
}

function boundSourceArm(
  base: SQL,
  timestampColumn: SQL,
  idColumn: SQL,
  window: ArmWindow,
): SQL {
  if (window.limit === null) return base;

  const order =
    window.order === "asc"
      ? sql`ORDER BY ${timestampColumn} ASC, ${idColumn} ASC`
      : sql`ORDER BY ${timestampColumn} DESC, ${idColumn} DESC`;

  return sql`
    SELECT * FROM (
      ${base}
      ${order}
      LIMIT ${window.limit}
    )
  `;
}

function receivedArm(
  allowed: AllowedInboxes,
  query: MessageQuery,
  requestedInboxes: string[] | undefined,
  window: ArmWindow,
): SQL {
  const search = receivedSearch(query.search, query.searchMode ?? "subject");
  const allowedScope = inboxScopeSql(allowed, sql`e.recipient`);
  const base = sql`
    SELECT
      'received' AS kind,
      e.id AS id,
      e.person_id AS person_id,
      e.recipient AS inbox,
      e.conversation_id AS conversation_id,
      e.message_id AS message_id,
      NULL AS in_reply_to,
      p.email AS from_email,
      p.name AS from_name,
      e.recipient AS to_email,
      NULL AS to_name,
      e.cc AS cc,
      e.subject AS subject,
      e.body_text AS body_text,
      e.body_html AS body_html,
      e.received_at AS occurred_at,
      e.is_read AS is_read,
      NULL AS campaign_id,
      NULL AS sequence_id,
      NULL AS sequence_enrollment_id,
      NULL AS delivery_status
    FROM emails e
    ${search.join}
    LEFT JOIN people p ON p.id = e.person_id
    WHERE 1 = 1
      ${allowedScope}
      ${explicitInboxScope(sql`e.recipient`, requestedInboxes)}
      ${personScope(sql`e.person_id`, query.personId)}
      ${conversationScope(sql`e.conversation_id`, query.conversationId)}
      ${dateScope(sql`e.received_at`, query.after, query.before)}
      ${search.where}
      ${blockedScope(query.excludeBlocked ?? false)}
      ${sourceCursorScope(
        sql`e.received_at`,
        sql`e.id`,
        "received",
        window.cursor,
        window.order,
      )}
  `;

  return boundSourceArm(base, sql`e.received_at`, sql`e.id`, window);
}

function sentArm(
  allowed: AllowedInboxes,
  query: MessageQuery,
  requestedInboxes: string[] | undefined,
  window: ArmWindow,
): SQL {
  const allowedScope = inboxScopeSql(allowed, sql`se.from_address`);
  const base = sql`
    SELECT
      'sent' AS kind,
      se.id AS id,
      se.person_id AS person_id,
      se.from_address AS inbox,
      se.conversation_id AS conversation_id,
      se.message_id AS message_id,
      se.in_reply_to AS in_reply_to,
      se.from_address AS from_email,
      NULL AS from_name,
      se.to_address AS to_email,
      p.name AS to_name,
      se.cc AS cc,
      se.subject AS subject,
      se.body_text AS body_text,
      se.body_html AS body_html,
      se.sent_at AS occurred_at,
      NULL AS is_read,
      se.campaign_id AS campaign_id,
      se.sequence_id AS sequence_id,
      se.sequence_enrollment_id AS sequence_enrollment_id,
      se.status AS delivery_status
    FROM sent_emails se
    LEFT JOIN people p ON p.id = se.person_id
    WHERE 1 = 1
      ${allowedScope}
      ${explicitInboxScope(sql`se.from_address`, requestedInboxes)}
      ${personScope(sql`se.person_id`, query.personId)}
      ${conversationScope(sql`se.conversation_id`, query.conversationId)}
      ${dateScope(sql`se.sent_at`, query.after, query.before)}
      ${sentSearch(query.search, query.searchMode ?? "subject")}
      ${blockedScope(query.excludeBlocked ?? false)}
      ${sourceCursorScope(
        sql`se.sent_at`,
        sql`se.id`,
        "sent",
        window.cursor,
        window.order,
      )}
  `;

  return boundSourceArm(base, sql`se.sent_at`, sql`se.id`, window);
}

function cursorScope(
  cursor: MessageCursorV1 | null,
  order: "desc" | "asc",
): SQL {
  if (!cursor) return sql``;

  if (order === "asc") {
    return sql`WHERE (
      occurred_at > ${cursor.occurredAt}
      OR (occurred_at = ${cursor.occurredAt} AND id > ${cursor.id})
      OR (
        occurred_at = ${cursor.occurredAt}
        AND id = ${cursor.id}
        AND kind > ${cursor.kind}
      )
    )`;
  }

  return sql`WHERE (
    occurred_at < ${cursor.occurredAt}
    OR (occurred_at = ${cursor.occurredAt} AND id < ${cursor.id})
    OR (
      occurred_at = ${cursor.occurredAt}
      AND id = ${cursor.id}
      AND kind > ${cursor.kind}
    )
  )`;
}

function toUnified(row: RawMessageRow): UnifiedMessage {
  if (row.kind === "received") {
    const selected: ReceivedSelect = {
      id: row.id,
      personId: row.person_id,
      recipient: row.inbox,
      subject: row.subject,
      bodyHtml: row.body_html,
      bodyText: row.body_text,
      messageId: row.message_id,
      isRead: row.is_read ?? 0,
      cc: row.cc,
      conversationId: row.conversation_id,
      receivedAt: row.occurred_at,
      personEmail: row.from_email,
      personName: row.from_name,
    };
    return adaptReceived(selected);
  }

  const selected: SentSelect = {
    id: row.id,
    personId: row.person_id,
    fromAddress: row.inbox,
    toAddress: row.to_email,
    subject: row.subject,
    bodyHtml: row.body_html,
    bodyText: row.body_text,
    inReplyTo: row.in_reply_to,
    messageId: row.message_id,
    status: row.delivery_status ?? "sent",
    cc: row.cc,
    conversationId: row.conversation_id,
    campaignId: row.campaign_id,
    sequenceId: row.sequence_id,
    sequenceEnrollmentId: row.sequence_enrollment_id,
    sentAt: row.occurred_at,
    personName: row.to_name,
  };
  return adaptSent(selected);
}

function attachmentWhere(messages: UnifiedMessage[]): SQL | undefined {
  const receivedIds = messages
    .filter((message) => message.ref.kind === "received")
    .map((message) => message.ref.id);
  const sentIds = messages
    .filter((message) => message.ref.kind === "sent")
    .map((message) => message.ref.id);

  const clauses: SQL[] = [];
  if (receivedIds.length > 0) {
    clauses.push(
      and(
        eq(attachments.kind, "inbound"),
        inArray(attachments.emailId, receivedIds),
      )!,
    );
  }
  if (sentIds.length > 0) {
    clauses.push(
      and(eq(attachments.kind, "sent"), inArray(attachments.emailId, sentIds))!,
    );
  }

  if (clauses.length === 0) return undefined;
  return clauses.length === 1 ? clauses[0] : or(...clauses);
}

const ATTACHMENT_BATCH_SIZE = 90;

async function enrichAttachments(
  db: DrizzleD1Database<any>,
  messages: UnifiedMessage[],
  withCounts: boolean,
  withAttachments: boolean,
): Promise<void> {
  if (messages.length === 0 || (!withCounts && !withAttachments)) return;

  const key = (kind: MessageKind, id: string) => `${kind}:${id}`;

  if (withAttachments) {
    const grouped = new Map<string, AttachmentRow[]>();

    for (
      let start = 0;
      start < messages.length;
      start += ATTACHMENT_BATCH_SIZE
    ) {
      const batch = messages.slice(start, start + ATTACHMENT_BATCH_SIZE);
      const where = attachmentWhere(batch);
      if (!where) continue;

      const rows = await db.select().from(attachments).where(where);
      for (const row of rows) {
        const kind: MessageKind = row.kind === "sent" ? "sent" : "received";
        const groupKey = key(kind, row.emailId);
        const current = grouped.get(groupKey) ?? [];
        current.push(row);
        grouped.set(groupKey, current);
      }
    }

    for (const message of messages) {
      const rowsForMessage =
        grouped.get(key(message.ref.kind, message.ref.id)) ?? [];
      message.attachments = rowsForMessage;
      if (withCounts) message.attachmentCount = rowsForMessage.length;
    }
    return;
  }

  const counts = new Map<string, number>();
  for (let start = 0; start < messages.length; start += ATTACHMENT_BATCH_SIZE) {
    const batch = messages.slice(start, start + ATTACHMENT_BATCH_SIZE);
    const where = attachmentWhere(batch);
    if (!where) continue;

    const rows = await db
      .select({
        emailId: attachments.emailId,
        kind: attachments.kind,
        count: sql<number>`COUNT(*)`,
      })
      .from(attachments)
      .where(where)
      .groupBy(attachments.emailId, attachments.kind);

    for (const row of rows) {
      const kind: MessageKind = row.kind === "sent" ? "sent" : "received";
      counts.set(key(kind, row.emailId), row.count);
    }
  }

  for (const message of messages) {
    message.attachmentCount =
      counts.get(key(message.ref.kind, message.ref.id)) ?? 0;
  }
}

export type BuiltMessageQuery = {
  statement: SQL;
  limit: number | null;
};

export function buildMessageQuerySql(
  allowed: AllowedInboxes,
  query: MessageQuery = {},
): BuiltMessageQuery | null {
  if (!allowed.isAdmin && allowed.inboxes.length === 0) {
    return null;
  }

  const requestedInboxes = normalizeInboxes(query.inboxes);
  if (requestedInboxes?.length === 0) {
    return null;
  }

  if (query.cursor !== undefined && query.offset !== undefined) {
    throw new Error("queryMessages accepts cursor or offset, not both");
  }

  const limit =
    query.limit === null ? null : Math.max(Math.floor(query.limit ?? 50), 1);
  const offset = Math.max(Math.floor(query.offset ?? 0), 0);
  const orderDirection = query.order === "asc" ? "asc" : "desc";
  const decodedCursor =
    query.cursor === undefined ? null : decodeCursor(query.cursor);
  const armLimit =
    limit === null ? null : decodedCursor ? limit + 1 : offset + limit + 1;
  const armWindow: ArmWindow = {
    cursor: decodedCursor,
    order: orderDirection,
    limit: armLimit,
  };

  const arms: SQL[] = [];
  if (query.direction !== "outbound") {
    arms.push(receivedArm(allowed, query, requestedInboxes, armWindow));
  }
  if (query.direction !== "inbound") {
    arms.push(sentArm(allowed, query, requestedInboxes, armWindow));
  }

  if (arms.length === 0) {
    return null;
  }

  const union = sql.join(arms, sql` UNION ALL `);
  const cursorWhere = cursorScope(decodedCursor, orderDirection);
  const order =
    orderDirection === "asc"
      ? sql`ORDER BY occurred_at ASC, id ASC, kind ASC`
      : sql`ORDER BY occurred_at DESC, id DESC, kind ASC`;

  const limitClause = limit === null ? sql`LIMIT -1` : sql`LIMIT ${limit + 1}`;
  const statement = sql`
    SELECT * FROM (${union})
    ${cursorWhere}
    ${order}
    ${limitClause}
    OFFSET ${decodedCursor ? 0 : offset}
  `;

  return { statement, limit };
}

export async function queryMessages(
  db: DrizzleD1Database<any>,
  allowed: AllowedInboxes,
  query: MessageQuery = {},
): Promise<MessagePage> {
  const built = buildMessageQuerySql(allowed, query);
  if (!built) {
    return { messages: [], nextCursor: null, hasMore: false };
  }

  const rows = await db.all<RawMessageRow>(built.statement);
  const { limit } = built;

  const hasMore = limit !== null && rows.length > limit;
  const visibleRows = limit === null ? rows : rows.slice(0, limit);
  const messages = visibleRows.map(toUnified);

  await enrichAttachments(
    db,
    messages,
    query.withAttachmentCounts ?? false,
    query.withAttachments ?? false,
  );

  const last =
    limit === null ? undefined : rows[Math.min(limit, rows.length) - 1];
  const nextCursor =
    hasMore && last
      ? encodeCursor({
          v: 1,
          occurredAt: last.occurred_at,
          id: last.id,
          kind: last.kind,
        })
      : null;

  return {
    messages,
    nextCursor,
    hasMore,
  };
}
