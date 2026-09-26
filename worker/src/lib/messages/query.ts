import { and, eq, inArray, or, sql, type SQL } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { attachments } from "../../db/attachments.schema";
import { messageMailboxes } from "../../db/message-mailboxes.schema";
import { conversationKeySql } from "./conversation-state";
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
import type {
  AttachmentRow,
  MessageKind,
  MessageRef,
  UnifiedMessage,
} from "./types";

export type MessageSearchMode = "subject" | "fulltext";
export type MessageFolder =
  | "inbox"
  | "sent"
  | "archive"
  | "junk"
  | "trash"
  | "snoozed"
  | { mailboxId: string };

export class InvalidQueryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidQueryError";
  }
}

export interface MessageQuery {
  inboxes?: string[];
  personId?: string;
  customerId?: string;
  conversationId?: string;
  messageRef?: MessageRef;
  messageRefs?: MessageRef[];
  threadKeys?: string[];
  direction?: "inbound" | "outbound";
  after?: number;
  before?: number;
  search?: string;
  searchMode?: MessageSearchMode;
  from?: string;
  excludeBlocked?: boolean;
  /** Null requests the full matching result set; numeric limits are not service-capped. */
  limit?: number | null;
  cursor?: string;
  offset?: number;
  order?: "desc" | "asc";
  withAttachmentCounts?: boolean;
  withAttachments?: boolean;
  viewer?: { userId: string };
  withState?: boolean;
  folder?: MessageFolder;
  starred?: boolean;
  seen?: boolean;
  unseen?: true;
  includeArchived?: boolean;
  includeTrashed?: boolean;
  includeSpam?: boolean;
  includeSnoozed?: boolean;
  /** Ignore snooze visibility rules. Used by JMAP, where snooze is app-only. */
  ignoreSnooze?: boolean;
  excludeCampaignSends?: boolean;
  assignedTo?: string;
  /** Unix seconds used for snooze evaluation. Defaults to the current time. */
  now?: number;
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
  seen_at: number | null;
  starred_at: number | null;
  user_state_present: number;
  archived_at: number | null;
  spam_at: number | null;
  trashed_at: number | null;
  conversation_key: string | null;
  snoozed_until: number | null;
  assigned_user_id: string | null;
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

function customerScope(column: SQL, customerId: string | undefined): SQL {
  return customerId === undefined
    ? sql``
    : sql`AND ${column} IN (
        SELECT person_id FROM customer_people WHERE customer_id = ${customerId}
      )`;
}

function conversationScope(
  column: SQL,
  conversationId: string | undefined,
): SQL {
  return conversationId === undefined
    ? sql``
    : sql`AND ${column} = ${conversationId}`;
}

export const MESSAGE_REFS_PER_QUERY = 40;
export const THREAD_KEYS_PER_QUERY = 20;

function messageRefScope(
  kind: MessageKind,
  idColumn: SQL,
  ref: MessageRef | undefined,
): SQL {
  if (!ref) return sql``;
  if (ref.kind !== kind) return sql`AND 0`;
  return sql`AND ${idColumn} = ${ref.id}`;
}

function messageRefsScope(
  kind: MessageKind,
  idColumn: SQL,
  refs: MessageRef[] | undefined,
): SQL {
  if (refs === undefined) return sql``;
  const ids = [
    ...new Set(refs.filter((ref) => ref.kind === kind).map((ref) => ref.id)),
  ];
  return ids.length === 0 ? sql`AND 0` : sql`AND ${idColumn} IN ${ids}`;
}

function threadKeysScope(
  kind: MessageKind,
  idColumn: SQL,
  conversationIdColumn: SQL,
  personIdColumn: SQL,
  keys: string[] | undefined,
): SQL {
  if (keys === undefined) return sql``;
  const conversationKey = conversationKeySql({
    conversationId: conversationIdColumn,
    personId: personIdColumn,
  });
  const threadKey = sql`COALESCE(${conversationKey}, ${kind} || ':' || ${idColumn})`;
  const uniqueKeys = [...new Set(keys)];
  return uniqueKeys.length === 0
    ? sql`AND 0`
    : sql`AND ${threadKey} IN ${uniqueKeys}`;
}

function fromScope(column: SQL, value: string | undefined): SQL {
  if (value === undefined) return sql``;
  return sql`AND lower(${column}) LIKE ${`%${escapeLike(value.toLowerCase())}%`} ESCAPE '\\'`;
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

function personalStateJoin(
  query: MessageQuery,
  kind: MessageKind,
  idColumn: SQL,
): SQL {
  if (!query.viewer) return sql``;
  return sql`LEFT JOIN message_user_state mus
    ON mus.user_id = ${query.viewer.userId}
    AND mus.message_kind = ${kind}
    AND mus.message_id = ${idColumn}`;
}

function personalStateSelect(query: MessageQuery): SQL {
  if (!query.viewer) {
    return sql`NULL AS seen_at, NULL AS starred_at, 0 AS user_state_present`;
  }
  return sql`mus.seen_at AS seen_at,
    mus.starred_at AS starred_at,
    CASE WHEN mus.message_id IS NULL THEN 0 ELSE 1 END AS user_state_present`;
}

function mailboxFolderId(
  folder: MessageFolder | undefined,
): string | undefined {
  return typeof folder === "object" ? folder.mailboxId : undefined;
}

function snoozeStateJoin(
  query: MessageQuery,
  inboxColumn: SQL,
  conversationIdColumn: SQL,
  personIdColumn: SQL,
): SQL {
  if (!query.withState) return sql``;
  const key = conversationKeySql({
    conversationId: conversationIdColumn,
    personId: personIdColumn,
  });
  return sql`LEFT JOIN inbox_conversation_state ics
    ON ics.inbox = ${inboxColumn}
    AND ics.conversation_key = ${key}`;
}

function snoozeStateSelect(
  query: MessageQuery,
  conversationIdColumn: SQL,
  personIdColumn: SQL,
): SQL {
  if (!query.withState) {
    return sql`NULL AS conversation_key, NULL AS snoozed_until, NULL AS assigned_user_id`;
  }
  const now = query.now ?? Math.floor(Date.now() / 1000);
  const key = conversationKeySql({
    conversationId: conversationIdColumn,
    personId: personIdColumn,
  });
  return sql`${key} AS conversation_key,
    CASE WHEN ics.snoozed_until > ${now}
      THEN ics.snoozed_until
      ELSE NULL
    END AS snoozed_until,
    ics.assigned_user_id AS assigned_user_id`;
}

function snoozeScope(
  query: MessageQuery,
  inboxColumn: SQL,
  conversationIdColumn: SQL,
  personIdColumn: SQL,
): SQL {
  if (query.ignoreSnooze === true) return sql``;
  const now = query.now ?? Math.floor(Date.now() / 1000);
  const key = conversationKeySql({
    conversationId: conversationIdColumn,
    personId: personIdColumn,
  });

  if (query.folder === "inbox") {
    return sql`AND NOT EXISTS (
      SELECT 1 FROM inbox_conversation_state snooze
      WHERE snooze.inbox = ${inboxColumn}
        AND snooze.conversation_key = ${key}
        AND snooze.snoozed_until > ${now}
    )`;
  }
  if (query.folder === "snoozed") {
    return sql`AND EXISTS (
      SELECT 1 FROM inbox_conversation_state snooze
      WHERE snooze.inbox = ${inboxColumn}
        AND snooze.conversation_key = ${key}
        AND snooze.snoozed_until > ${now}
    )`;
  }
  if (query.folder === undefined && query.includeSnoozed === false) {
    return sql`AND NOT EXISTS (
      SELECT 1 FROM inbox_conversation_state snooze
      WHERE snooze.inbox = ${inboxColumn}
        AND snooze.conversation_key = ${key}
        AND snooze.snoozed_until > ${now}
    )`;
  }
  return sql``;
}

function assignmentScope(
  query: MessageQuery,
  inboxColumn: SQL,
  conversationIdColumn: SQL,
  personIdColumn: SQL,
): SQL {
  if (query.assignedTo === undefined) return sql``;
  const key = conversationKeySql({
    conversationId: conversationIdColumn,
    personId: personIdColumn,
  });
  return sql`AND EXISTS (
    SELECT 1 FROM inbox_conversation_state assignment
    WHERE assignment.inbox = ${inboxColumn}
      AND assignment.conversation_key = ${key}
      AND assignment.assigned_user_id = ${query.assignedTo}
  )`;
}

function stateScope(
  query: MessageQuery,
  kind: MessageKind,
  idColumn: SQL,
  inboxColumn: SQL,
  readColumn?: SQL,
): SQL {
  const folder = query.folder;
  const mailboxId = mailboxFolderId(folder);
  let folderScope = sql``;

  if (folder === "inbox") {
    folderScope = sql`AND mms.trashed_at IS NULL
      AND mms.spam_at IS NULL
      AND mms.archived_at IS NULL`;
  } else if (folder === "sent") {
    folderScope = sql`AND mms.trashed_at IS NULL`;
  } else if (folder === "archive") {
    folderScope = sql`AND mms.archived_at IS NOT NULL
      AND mms.trashed_at IS NULL
      AND mms.spam_at IS NULL`;
  } else if (folder === "junk") {
    folderScope = sql`AND mms.spam_at IS NOT NULL
      AND mms.trashed_at IS NULL`;
  } else if (folder === "trash") {
    folderScope = sql`AND mms.trashed_at IS NOT NULL`;
  } else if (folder === "snoozed") {
    folderScope = sql`AND mms.trashed_at IS NULL
      AND mms.spam_at IS NULL`;
  } else if (mailboxId !== undefined) {
    folderScope = sql`AND mms.trashed_at IS NULL
      AND EXISTS (
        SELECT 1
        FROM message_mailboxes mm
        JOIN mailboxes mb ON mb.id = mm.mailbox_id
        WHERE mm.message_kind = ${kind}
          AND mm.message_id = ${idColumn}
          AND mm.mailbox_id = ${mailboxId}
          AND mb.inbox = ${inboxColumn}
      )`;
  } else {
    const archived =
      query.includeArchived === false
        ? sql`AND mms.archived_at IS NULL`
        : sql``;
    const spam =
      query.includeSpam === false ? sql`AND mms.spam_at IS NULL` : sql``;
    const trashed =
      query.includeTrashed === false ? sql`AND mms.trashed_at IS NULL` : sql``;
    folderScope = sql`${archived} ${spam} ${trashed}`;
  }

  const starred =
    query.starred === undefined
      ? sql``
      : query.starred
        ? sql`AND mus.starred_at IS NOT NULL`
        : sql`AND mus.starred_at IS NULL`;
  const unseen =
    query.unseen === true && kind === "received" && readColumn
      ? sql`AND (
          (mus.message_id IS NULL AND ${readColumn} = 0)
          OR (mus.message_id IS NOT NULL AND mus.seen_at IS NULL)
        )`
      : sql``;
  let seen = sql``;
  if (query.seen !== undefined) {
    if (kind === "sent") {
      seen = query.seen ? sql`` : sql`AND 0`;
    } else if (readColumn) {
      seen = query.seen
        ? sql`AND (
            (mus.message_id IS NULL AND ${readColumn} = 1)
            OR (mus.message_id IS NOT NULL AND mus.seen_at IS NOT NULL)
          )`
        : sql`AND (
            (mus.message_id IS NULL AND ${readColumn} = 0)
            OR (mus.message_id IS NOT NULL AND mus.seen_at IS NULL)
          )`;
    }
  }

  return sql`${folderScope} ${starred} ${unseen} ${seen}`;
}

function campaignScope(query: MessageQuery): SQL {
  return query.excludeCampaignSends === true
    ? sql`AND se.campaign_id IS NULL`
    : sql``;
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
      NULL AS delivery_status,
      ${personalStateSelect(query)},
      mms.archived_at AS archived_at,
      mms.spam_at AS spam_at,
      mms.trashed_at AS trashed_at,
      ${snoozeStateSelect(query, sql`e.conversation_id`, sql`e.person_id`)}
    FROM emails e
    ${search.join}
    LEFT JOIN people p ON p.id = e.person_id
    LEFT JOIN mailbox_message_state mms
      ON mms.message_kind = 'received' AND mms.message_id = e.id
    ${personalStateJoin(query, "received", sql`e.id`)}
    ${snoozeStateJoin(
      query,
      sql`e.recipient`,
      sql`e.conversation_id`,
      sql`e.person_id`,
    )}
    WHERE 1 = 1
      ${allowedScope}
      ${explicitInboxScope(sql`e.recipient`, requestedInboxes)}
      ${personScope(sql`e.person_id`, query.personId)}
      ${customerScope(sql`e.person_id`, query.customerId)}
      ${conversationScope(sql`e.conversation_id`, query.conversationId)}
      ${messageRefScope("received", sql`e.id`, query.messageRef)}
      ${messageRefsScope("received", sql`e.id`, query.messageRefs)}
      ${threadKeysScope(
        "received",
        sql`e.id`,
        sql`e.conversation_id`,
        sql`e.person_id`,
        query.threadKeys,
      )}
      ${dateScope(sql`e.received_at`, query.after, query.before)}
      ${fromScope(sql`p.email`, query.from)}
      ${search.where}
      ${blockedScope(query.excludeBlocked ?? false)}
      ${stateScope(
        query,
        "received",
        sql`e.id`,
        sql`e.recipient`,
        sql`e.is_read`,
      )}
      ${snoozeScope(
        query,
        sql`e.recipient`,
        sql`e.conversation_id`,
        sql`e.person_id`,
      )}
      ${assignmentScope(
        query,
        sql`e.recipient`,
        sql`e.conversation_id`,
        sql`e.person_id`,
      )}
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
      se.status AS delivery_status,
      ${personalStateSelect(query)},
      mms.archived_at AS archived_at,
      mms.spam_at AS spam_at,
      mms.trashed_at AS trashed_at,
      ${snoozeStateSelect(query, sql`se.conversation_id`, sql`se.person_id`)}
    FROM sent_emails se
    LEFT JOIN people p ON p.id = se.person_id
    LEFT JOIN mailbox_message_state mms
      ON mms.message_kind = 'sent' AND mms.message_id = se.id
    ${personalStateJoin(query, "sent", sql`se.id`)}
    ${snoozeStateJoin(
      query,
      sql`se.from_address`,
      sql`se.conversation_id`,
      sql`se.person_id`,
    )}
    WHERE 1 = 1
      ${allowedScope}
      ${explicitInboxScope(sql`se.from_address`, requestedInboxes)}
      ${personScope(sql`se.person_id`, query.personId)}
      ${customerScope(sql`se.person_id`, query.customerId)}
      ${conversationScope(sql`se.conversation_id`, query.conversationId)}
      ${messageRefScope("sent", sql`se.id`, query.messageRef)}
      ${messageRefsScope("sent", sql`se.id`, query.messageRefs)}
      ${threadKeysScope(
        "sent",
        sql`se.id`,
        sql`se.conversation_id`,
        sql`se.person_id`,
        query.threadKeys,
      )}
      ${dateScope(sql`se.sent_at`, query.after, query.before)}
      ${fromScope(sql`se.from_address`, query.from)}
      ${sentSearch(query.search, query.searchMode ?? "subject")}
      ${blockedScope(query.excludeBlocked ?? false)}
      ${stateScope(query, "sent", sql`se.id`, sql`se.from_address`)}
      ${snoozeScope(
        query,
        sql`se.from_address`,
        sql`se.conversation_id`,
        sql`se.person_id`,
      )}
      ${assignmentScope(
        query,
        sql`se.from_address`,
        sql`se.conversation_id`,
        sql`se.person_id`,
      )}
      ${campaignScope(query)}
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

function toUnified(
  row: RawMessageRow,
  withState: boolean,
  hasViewer: boolean,
): UnifiedMessage {
  let message: UnifiedMessage;
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
    message = adaptReceived(selected);
  } else {
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
    message = adaptSent(selected);
  }

  if (withState) {
    const seen =
      row.kind === "sent"
        ? true
        : hasViewer
          ? row.user_state_present === 0
            ? row.is_read === 1
            : row.seen_at !== null
          : row.is_read === 1;
    message.state = {
      seen,
      starredAt: hasViewer ? row.starred_at : null,
      archivedAt: row.archived_at,
      spamAt: row.spam_at,
      trashedAt: row.trashed_at,
      mailboxIds: [],
      conversationKey: row.conversation_key,
      snoozedUntil: row.snoozed_until,
      assignedUserId: row.assigned_user_id,
    };
  }

  return message;
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

const STATE_MEMBERSHIP_BATCH_SIZE = 40;

async function enrichMailboxState(
  db: DrizzleD1Database<any>,
  messages: UnifiedMessage[],
): Promise<void> {
  if (messages.length === 0) return;

  const byKey = new Map<string, string[]>();
  for (const kind of ["received", "sent"] as const) {
    const ids = messages
      .filter((message) => message.ref.kind === kind)
      .map((message) => message.ref.id);
    for (
      let start = 0;
      start < ids.length;
      start += STATE_MEMBERSHIP_BATCH_SIZE
    ) {
      const batch = ids.slice(start, start + STATE_MEMBERSHIP_BATCH_SIZE);
      const rows = await db
        .select({
          messageKind: messageMailboxes.messageKind,
          messageId: messageMailboxes.messageId,
          mailboxId: messageMailboxes.mailboxId,
        })
        .from(messageMailboxes)
        .where(
          and(
            eq(messageMailboxes.messageKind, kind),
            inArray(messageMailboxes.messageId, batch),
          ),
        );
      for (const row of rows) {
        const key = `${row.messageKind}:${row.messageId}`;
        const mailboxIds = byKey.get(key) ?? [];
        mailboxIds.push(row.mailboxId);
        byKey.set(key, mailboxIds);
      }
    }
  }

  for (const message of messages) {
    if (!message.state) continue;
    message.state.mailboxIds = [
      ...(byKey.get(`${message.ref.kind}:${message.ref.id}`) ?? []),
    ].sort();
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
  if ("inboxes" in allowed && allowed.inboxes.length === 0) {
    return null;
  }

  const requestedInboxes = normalizeInboxes(query.inboxes);
  if (requestedInboxes?.length === 0) {
    return null;
  }

  if (
    (query.starred !== undefined ||
      query.seen !== undefined ||
      query.unseen === true) &&
    !query.viewer
  ) {
    throw new InvalidQueryError(
      "starred, seen and unseen filters require a viewer",
    );
  }
  if (
    typeof query.folder === "object" &&
    query.folder.mailboxId.trim().length === 0
  ) {
    throw new InvalidQueryError("mailboxId is required");
  }
  if (query.cursor !== undefined && query.offset !== undefined) {
    throw new InvalidQueryError(
      "queryMessages accepts cursor or offset, not both",
    );
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
  const folder = query.folder;
  const forceReceived =
    folder === "inbox" ||
    folder === "archive" ||
    folder === "junk" ||
    folder === "snoozed" ||
    query.unseen === true ||
    query.seen === false;
  const forceSent = folder === "sent";
  const forceBoth =
    folder === "trash" || (folder !== undefined && typeof folder === "object");
  const includeReceived = forceReceived
    ? true
    : forceSent
      ? false
      : forceBoth
        ? true
        : query.direction !== "outbound";
  const includeSent = forceSent
    ? true
    : forceReceived
      ? false
      : forceBoth
        ? true
        : query.direction !== "inbound";

  if (includeReceived) {
    arms.push(receivedArm(allowed, query, requestedInboxes, armWindow));
  }
  if (includeSent) {
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
  if (
    query.messageRefs !== undefined &&
    query.messageRefs.length > MESSAGE_REFS_PER_QUERY
  ) {
    throw new Error(
      `queryMessages messageRefs is limited to ${MESSAGE_REFS_PER_QUERY} per statement`,
    );
  }
  if (
    query.threadKeys !== undefined &&
    query.threadKeys.length > THREAD_KEYS_PER_QUERY
  ) {
    throw new Error(
      `queryMessages threadKeys is limited to ${THREAD_KEYS_PER_QUERY} per statement`,
    );
  }
  const built = buildMessageQuerySql(allowed, query);
  if (!built) {
    return { messages: [], nextCursor: null, hasMore: false };
  }

  const rows = await db.all<RawMessageRow>(built.statement);
  const { limit } = built;

  const hasMore = limit !== null && rows.length > limit;
  const visibleRows = limit === null ? rows : rows.slice(0, limit);
  const messages = visibleRows.map((row) =>
    toUnified(row, query.withState ?? false, query.viewer !== undefined),
  );

  await enrichAttachments(
    db,
    messages,
    query.withAttachmentCounts ?? false,
    query.withAttachments ?? false,
  );
  if (query.withState) {
    await enrichMailboxState(db, messages);
  }

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

export async function countMessages(
  db: DrizzleD1Database<any>,
  allowed: AllowedInboxes,
  query: MessageQuery = {},
): Promise<number> {
  const built = buildMessageQuerySql(allowed, {
    ...query,
    limit: null,
    cursor: undefined,
    offset: undefined,
  });
  if (!built) return 0;
  const rows = await db.all<{ count: number }>(
    sql`SELECT COUNT(*) AS count FROM (${built.statement})`,
  );
  return Number(rows[0]?.count ?? 0);
}

export async function countMessageThreads(
  db: DrizzleD1Database<any>,
  allowed: AllowedInboxes,
  query: MessageQuery = {},
): Promise<number> {
  const built = buildMessageQuerySql(allowed, {
    ...query,
    limit: null,
    cursor: undefined,
    offset: undefined,
    withState: true,
  });
  if (!built) return 0;
  const rows = await db.all<{ count: number }>(
    sql`SELECT COUNT(DISTINCT COALESCE(conversation_key, kind || ':' || id)) AS count
      FROM (${built.statement})`,
  );
  return Number(rows[0]?.count ?? 0);
}

export async function queryMessageThreadKeys(
  db: DrizzleD1Database<any>,
  allowed: AllowedInboxes,
  query: MessageQuery = {},
  limit = 257,
): Promise<string[]> {
  const built = buildMessageQuerySql(allowed, {
    ...query,
    limit: null,
    cursor: undefined,
    offset: undefined,
    withState: true,
  });
  if (!built) return [];
  const rows = await db.all<{ thread_key: string }>(
    sql`SELECT DISTINCT COALESCE(conversation_key, kind || ':' || id) AS thread_key
      FROM (${built.statement})
      ORDER BY thread_key
      LIMIT ${limit}`,
  );
  return rows.map((row) => row.thread_key);
}
