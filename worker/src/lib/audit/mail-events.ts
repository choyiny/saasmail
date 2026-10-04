import { sql } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import type { MessageRef } from "../messages/types";
import { currentAuditActor } from "./context";
import { AUDIT_ACTIONS, type AuditAction } from "./events";
import { recordAudit, recordBulkAudit } from "./record";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = DrizzleD1Database<any>;

type StateMessage = { ref: MessageRef; inbox: string };
type MailboxFlags = { archived: boolean; spam: boolean; trashed: boolean };
type MailboxChanges = { archived?: boolean; spam?: boolean; trashed?: boolean };

const refId = (ref: MessageRef) => `${ref.kind}:${ref.id}`;
const messages = (n: number) => (n === 1 ? "1 message" : `${n} messages`);
const conversations = (n: number) =>
  n === 1 ? "1 conversation" : `${n} conversations`;

function byInbox<T extends { inbox: string }>(items: T[]): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const group = groups.get(item.inbox) ?? [];
    group.push(item);
    groups.set(item.inbox, group);
  }
  return groups;
}

/**
 * Whether a shared-state change by this caller is worth a row. A person, an
 * API key, an MCP or JMAP client and the agent all pass a user id. A rule or
 * the system passes none: their per-message filing is routine and counted by
 * `rules.match_count` instead.
 */
function actedByPerson(userId: string | null): boolean {
  return userId !== null;
}

/**
 * A read made only for the audit log must never fail the request it belongs
 * to: on any error the caller gets `null` and records nothing.
 */
async function auditRead<T>(
  what: string,
  read: () => Promise<T>,
): Promise<T | null> {
  try {
    return await read();
  } catch (error) {
    console.warn(
      `[audit] ${what} not read; the change is not recorded:`,
      error,
    );
    return null;
  }
}

/**
 * The shared flags of these messages before a change, or `null` when they
 * could not be read. An event counts only the messages whose flag really
 * changes: archiving an archived message is not an event, and a JMAP move to
 * Inbox clears all three flags whatever was set.
 */
export function mailboxFlagsBefore(
  db: Db,
  resolved: StateMessage[],
): Promise<Map<string, MailboxFlags> | null> {
  return auditRead("mailbox flags", async () => {
    const before = new Map<string, MailboxFlags>();
    if (resolved.length === 0) return before;
    const rows = await db.all<{
      kind: string;
      id: string;
      archived_at: number | null;
      spam_at: number | null;
      trashed_at: number | null;
    }>(sql`
      SELECT mms.message_kind AS kind, mms.message_id AS id,
        mms.archived_at, mms.spam_at, mms.trashed_at
      FROM json_each(${JSON.stringify(
        resolved.map((message) => [message.ref.kind, message.ref.id]),
      )}) ref
      JOIN mailbox_message_state mms
        ON mms.message_kind = json_extract(ref.value, '$[0]')
        AND mms.message_id = json_extract(ref.value, '$[1]')
    `);
    for (const row of rows) {
      before.set(`${row.kind}:${row.id}`, {
        archived: row.archived_at !== null,
        spam: row.spam_at !== null,
        trashed: row.trashed_at !== null,
      });
    }
    return before;
  });
}

/** True when recording this change needs `mailboxFlagsBefore`. */
export function needsFlagsBefore(
  userId: string | null,
  changes: MailboxChanges,
): boolean {
  return (
    actedByPerson(userId) &&
    (changes.archived !== undefined ||
      changes.spam !== undefined ||
      changes.trashed !== undefined)
  );
}

/**
 * Which of these messages are in which of these folders before a change, as
 * `kind:id:folderId` keys; `null` when it could not be read.
 */
export function folderMembershipBefore(
  db: Db,
  userId: string | null,
  resolved: StateMessage[],
  folderIds: string[],
): Promise<Set<string> | null> {
  if (!actedByPerson(userId)) return Promise.resolve(null);
  return auditRead("folder membership", async () => {
    const rows = await db.all<{ kind: string; id: string; folder: string }>(sql`
      SELECT mm.message_kind AS kind, mm.message_id AS id,
        mm.mailbox_id AS folder
      FROM json_each(${JSON.stringify(
        resolved.map((message) => [message.ref.kind, message.ref.id]),
      )}) ref
      JOIN message_mailboxes mm
        ON mm.message_kind = json_extract(ref.value, '$[0]')
        AND mm.message_id = json_extract(ref.value, '$[1]')
      WHERE mm.mailbox_id IN (SELECT value FROM json_each(${JSON.stringify(folderIds)}))
    `);
    return new Set(rows.map((row) => `${row.kind}:${row.id}:${row.folder}`));
  });
}

type ConversationBefore = {
  snoozedUntil: number | null;
  assignedUserId: string | null;
};
const conversationId = (c: { inbox: string; conversationKey: string }) =>
  `${c.inbox}\u0000${c.conversationKey}`;

/**
 * The snooze and the assignee of these conversations before a change;
 * `null` when it could not be read.
 */
export function conversationStateBefore(
  db: Db,
  userId: string | null,
  conversations: { inbox: string; conversationKey: string }[],
): Promise<Map<string, ConversationBefore> | null> {
  if (!actedByPerson(userId)) return Promise.resolve(null);
  return auditRead("conversation state", async () => {
    const before = new Map<string, ConversationBefore>();
    if (conversations.length === 0) return before;
    const rows = await db.all<{
      inbox: string;
      key: string;
      snoozed_until: number | null;
      assigned_user_id: string | null;
    }>(sql`
      SELECT ics.inbox AS inbox, ics.conversation_key AS key,
        ics.snoozed_until, ics.assigned_user_id
      FROM json_each(${JSON.stringify(
        conversations.map((c) => [c.inbox, c.conversationKey]),
      )}) ref
      JOIN inbox_conversation_state ics
        ON ics.inbox = json_extract(ref.value, '$[0]')
        AND ics.conversation_key = json_extract(ref.value, '$[1]')
    `);
    for (const row of rows) {
      before.set(`${row.inbox}\u0000${row.key}`, {
        snoozedUntil: row.snoozed_until,
        assignedUserId: row.assigned_user_id,
      });
    }
    return before;
  });
}

const STATE_EVENTS: {
  key: keyof MailboxChanges;
  set: [AuditAction, (n: number, inbox: string) => string];
  cleared: [AuditAction, (n: number, inbox: string) => string];
}[] = [
  {
    key: "archived",
    set: [
      AUDIT_ACTIONS.mailArchived,
      (n, inbox) => `Archived ${messages(n)} in ${inbox}`,
    ],
    cleared: [
      AUDIT_ACTIONS.mailUnarchived,
      (n, inbox) => `Moved ${messages(n)} out of Archive in ${inbox}`,
    ],
  },
  {
    key: "spam",
    set: [
      AUDIT_ACTIONS.mailSpam,
      (n, inbox) => `Marked ${messages(n)} as junk in ${inbox}`,
    ],
    cleared: [
      AUDIT_ACTIONS.mailNotSpam,
      (n, inbox) => `Marked ${messages(n)} as not junk in ${inbox}`,
    ],
  },
  {
    key: "trashed",
    set: [
      AUDIT_ACTIONS.mailTrashed,
      (n, inbox) => `Moved ${messages(n)} to Trash in ${inbox}`,
    ],
    cleared: [
      AUDIT_ACTIONS.mailRestored,
      (n, inbox) => `Restored ${messages(n)} from Trash in ${inbox}`,
    ],
  },
];

/**
 * Records a `setMailboxState` call: one row per inbox and per flag, counting
 * only the messages whose flag really changed. A rule is recorded only when
 * it marks mail as junk, which it does to mail that has just arrived.
 */
export async function auditMailboxState(
  db: Db,
  userId: string | null,
  resolved: StateMessage[],
  changes: MailboxChanges,
  before: Map<string, MailboxFlags> | null,
): Promise<void> {
  const person = actedByPerson(userId);
  const rule = currentAuditActor().actorType === "rule";
  if (!person && !rule) return;

  for (const event of STATE_EVENTS) {
    const value = changes[event.key];
    if (value === undefined) continue;
    if (!person && !(event.key === "spam" && value === true)) continue;

    let affected = resolved;
    if (person) {
      // The flags could not be read: say nothing rather than guess.
      if (!before) continue;
      affected = resolved.filter(
        (message) =>
          (before.get(refId(message.ref))?.[event.key] ?? false) !== value,
      );
    }
    const [action, sentence] = value ? event.set : event.cleared;
    for (const [inbox, group] of byInbox(affected)) {
      await recordBulkAudit(db, {
        action,
        targetType: "message",
        inbox,
        refs: group.map((message) => refId(message.ref)),
        summary: (n) => sentence(n, inbox),
      });
    }
  }
}

/**
 * Records a `setMailboxMembership` call: one row per folder and direction,
 * counting only messages that were not in the folder (added) or were in it
 * (removed) before.
 */
export async function auditMailboxMembership(
  db: Db,
  userId: string | null,
  resolved: StateMessage[],
  folders: { id: string; name: string; inbox: string }[],
  direction: "added" | "removed",
  before: Set<string> | null,
): Promise<void> {
  if (!actedByPerson(userId) || !before) return;
  for (const folder of folders) {
    const moved = resolved.filter(
      (message) =>
        before.has(`${refId(message.ref)}:${folder.id}`) ===
        (direction === "removed"),
    );
    await recordBulkAudit(db, {
      action: AUDIT_ACTIONS.mailMoved,
      targetType: "message",
      inbox: folder.inbox,
      refs: moved.map((message) => refId(message.ref)),
      summary: (n) =>
        direction === "added"
          ? `Filed ${messages(n)} into '${folder.name}'`
          : `Removed ${messages(n)} from '${folder.name}'`,
      details: { folderId: folder.id, folder: folder.name, direction },
    });
  }
}

/**
 * Records a snooze or an unsnooze, one row per inbox, counting only the
 * conversations whose snooze changes: waking one that was not asleep is not
 * an event.
 */
export async function auditSnooze(
  db: Db,
  userId: string | null,
  resolved: { inbox: string; conversationKey: string }[],
  until: number | null,
  before: Map<string, ConversationBefore> | null,
): Promise<void> {
  if (!actedByPerson(userId) || !before) return;
  const now = Math.floor(Date.now() / 1000);
  const changed = resolved.filter((conversation) => {
    const was = before.get(conversationId(conversation))?.snoozedUntil ?? null;
    const asleep = was !== null && was > now;
    return until === null ? asleep : was !== until;
  });
  for (const [inbox, group] of byInbox(changed)) {
    await recordBulkAudit(db, {
      action:
        until === null
          ? AUDIT_ACTIONS.mailUnsnoozed
          : AUDIT_ACTIONS.mailSnoozed,
      targetType: "conversation",
      inbox,
      refs: group.map((conversation) => conversation.conversationKey),
      summary: (n) =>
        until === null
          ? `Unsnoozed ${conversations(n)} in ${inbox}`
          : `Snoozed ${conversations(n)} in ${inbox} until ${new Date(until * 1000).toISOString()}`,
      ...(until === null ? {} : { details: { until } }),
    });
  }
}

/**
 * Records an assignment or an unassignment, one row per inbox, counting only
 * the conversations whose assignee changes.
 */
export async function auditAssign(
  db: Db,
  actorUserId: string | null,
  resolved: { inbox: string; conversationKey: string }[],
  assignee: { id: string; email: string } | null,
  before: Map<string, ConversationBefore> | null,
): Promise<void> {
  if (!actedByPerson(actorUserId) || !before) return;
  const changed = resolved.filter(
    (conversation) =>
      (before.get(conversationId(conversation))?.assignedUserId ?? null) !==
      (assignee?.id ?? null),
  );
  for (const [inbox, group] of byInbox(changed)) {
    await recordBulkAudit(db, {
      action: assignee
        ? AUDIT_ACTIONS.mailAssigned
        : AUDIT_ACTIONS.mailUnassigned,
      targetType: "conversation",
      inbox,
      refs: group.map((conversation) => conversation.conversationKey),
      summary: (n) =>
        assignee
          ? `Assigned ${conversations(n)} in ${inbox} to ${assignee.email}`
          : `Unassigned ${conversations(n)} in ${inbox}`,
      ...(assignee
        ? { details: { assigneeUserId: assignee.id, assignee: assignee.email } }
        : {}),
    });
  }
}

/**
 * Records a message handed to the provider or to the outbox's retries. A
 * send the provider refused, or one dropped because every recipient is
 * suppressed, sent nothing and is not recorded.
 */
export async function auditMailSent(
  db: Db,
  sent: {
    id: string;
    from: string;
    to: string;
    /** Recipients besides `to`: further To, Cc and Bcc. */
    otherRecipients?: number;
    subject: string | null;
    status: string;
    templateSlug?: string | null;
    /** For a reply: whether it followed the original's Reply-To. */
    repliedTo?: "reply_to" | "sender";
    /** True when a send that had failed went out on a manual retry. */
    retried?: boolean;
  },
): Promise<void> {
  if (!["sent", "retrying", "scheduled"].includes(sent.status)) return;
  await recordAudit(db, {
    action: AUDIT_ACTIONS.mailSent,
    targetType: "message",
    targetId: `sent:${sent.id}`,
    inbox: sent.from,
    summary: `${sent.retried ? "Retried and sent" : "Sent"} '${sent.subject ?? ""}' to ${sent.to} from ${sent.from}`,
    details: {
      sentEmailId: sent.id,
      to: sent.to,
      otherRecipients: sent.otherRecipients ?? 0,
      status: sent.status,
      ...(sent.templateSlug ? { templateSlug: sent.templateSlug } : {}),
      ...(sent.repliedTo ? { repliedTo: sent.repliedTo } : {}),
      ...(sent.retried ? { retried: true } : {}),
    },
  });
}

/**
 * Records hard-deleted messages, one row per inbox. A single message is named
 * by its subject: after the delete nothing else says what it was.
 */
export async function auditMailDeleted(
  db: Db,
  deleted: { ref: MessageRef; inbox: string; subject?: string | null }[],
  /** What they were deleted along with, e.g. "the contact alice@example.com". */
  context?: { with: string; details?: Record<string, unknown> },
): Promise<void> {
  const along = context ? `, with ${context.with}` : "";
  for (const [inbox, group] of byInbox(deleted)) {
    const subject = group.length === 1 ? group[0].subject : null;
    await recordBulkAudit(db, {
      action: AUDIT_ACTIONS.mailDeleted,
      targetType: "message",
      inbox,
      refs: group.map((message) => refId(message.ref)),
      summary: (n) =>
        n === 1 && subject
          ? `Deleted '${subject}' from ${inbox}${along}`
          : `Deleted ${messages(n)} from ${inbox}${along}`,
      ...(context?.details ? { details: context.details } : {}),
    });
  }
}
