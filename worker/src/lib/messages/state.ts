import { and, eq, inArray, or, sql } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { nanoid } from "nanoid";
import { users } from "../../db/auth.schema";
import { emails } from "../../db/emails.schema";
import { sentEmails } from "../../db/sent-emails.schema";
import { messageUserState } from "../../db/message-user-state.schema";
import { mailboxMessageState } from "../../db/mailbox-message-state.schema";
import { mailboxes } from "../../db/mailboxes.schema";
import { messageMailboxes } from "../../db/message-mailboxes.schema";
import { suggestedReplies } from "../../db/suggested-replies.schema";
import {
  isInboxAllowed,
  resolveAllowedInboxes,
  type AllowedInboxes,
} from "../inbox-permissions";
import type { MessageRef } from "./types";

export class MessageStateAccessError extends Error {
  constructor() {
    super("Message or mailbox not found or not allowed");
    this.name = "MessageStateAccessError";
  }
}

export class InvalidMessageStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidMessageStateError";
  }
}

type ResolvedMessage = {
  ref: MessageRef;
  inbox: string;
  isRead: number | null;
};

const refKey = (ref: MessageRef) => `${ref.kind}:${ref.id}`;
const LOOKUP_BATCH_SIZE = 40;
const WRITE_BATCH_STATEMENTS = 40;
const USER_STATE_ROWS_PER_STATEMENT = Math.floor(90 / 6);
const MAILBOX_STATE_ROWS_PER_STATEMENT = Math.floor(90 / 8);
const MAILBOX_MEMBERSHIP_ROWS_PER_STATEMENT = Math.floor(90 / 5);
const MAILBOX_MEMBERSHIP_DELETE_ROWS_PER_STATEMENT = Math.floor(90 / 3);

async function runWriteBatches(
  db: DrizzleD1Database<any>,
  statements: any[],
): Promise<void> {
  // Each D1 batch is transactional, but a mutation can span several batches.
  // If a later batch fails, earlier batches remain applied. The writes here are
  // idempotent upserts/deletes, matching the Stage 3 (#11) chunk-and-retry
  // behavior used by bulk mailbox actions.
  for (
    let start = 0;
    start < statements.length;
    start += WRITE_BATCH_STATEMENTS
  ) {
    await db.batch(
      statements.slice(start, start + WRITE_BATCH_STATEMENTS) as any,
    );
  }
}

function dedupeRefs(refs: MessageRef[]): MessageRef[] {
  const seen = new Set<string>();
  const result: MessageRef[] = [];
  for (const ref of refs) {
    const key = refKey(ref);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(ref);
  }
  return result;
}

async function allowedForUser(
  db: DrizzleD1Database<any>,
  userId: string,
): Promise<AllowedInboxes> {
  const [user] = await db
    .select({ id: users.id, role: users.role })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  if (!user) throw new MessageStateAccessError();
  return resolveAllowedInboxes(db, user);
}

async function resolveMessageRefs(
  db: DrizzleD1Database<any>,
  allowed: AllowedInboxes,
  refs: MessageRef[],
): Promise<ResolvedMessage[]> {
  const unique = dedupeRefs(refs);
  if (unique.length === 0) return [];

  const receivedIds = unique
    .filter((ref) => ref.kind === "received")
    .map((ref) => ref.id);
  const sentIds = unique
    .filter((ref) => ref.kind === "sent")
    .map((ref) => ref.id);

  const received: Array<{
    id: string;
    inbox: string;
    isRead: number | null;
  }> = [];
  for (let start = 0; start < receivedIds.length; start += LOOKUP_BATCH_SIZE) {
    const batch = receivedIds.slice(start, start + LOOKUP_BATCH_SIZE);
    received.push(
      ...(await db
        .select({
          id: emails.id,
          inbox: emails.recipient,
          isRead: emails.isRead,
        })
        .from(emails)
        .where(inArray(emails.id, batch))),
    );
  }

  const sent: Array<{ id: string; inbox: string }> = [];
  for (let start = 0; start < sentIds.length; start += LOOKUP_BATCH_SIZE) {
    const batch = sentIds.slice(start, start + LOOKUP_BATCH_SIZE);
    sent.push(
      ...(await db
        .select({
          id: sentEmails.id,
          inbox: sentEmails.fromAddress,
        })
        .from(sentEmails)
        .where(inArray(sentEmails.id, batch))),
    );
  }

  const byKey = new Map<string, ResolvedMessage>();
  for (const row of received) {
    const resolved: ResolvedMessage = {
      ref: { kind: "received", id: row.id },
      inbox: row.inbox,
      isRead: row.isRead,
    };
    byKey.set(refKey(resolved.ref), resolved);
  }
  for (const row of sent) {
    const resolved: ResolvedMessage = {
      ref: { kind: "sent", id: row.id },
      inbox: row.inbox,
      isRead: null,
    };
    byKey.set(refKey(resolved.ref), resolved);
  }

  return unique.map((ref) => {
    const resolved = byKey.get(refKey(ref));
    if (!resolved || !isInboxAllowed(allowed, resolved.inbox)) {
      throw new MessageStateAccessError();
    }
    return resolved;
  });
}

export async function setUserState(
  db: DrizzleD1Database<any>,
  userId: string,
  refs: MessageRef[],
  changes: { seen?: boolean; starred?: boolean },
): Promise<void> {
  const allowed = await allowedForUser(db, userId);
  const resolved = await resolveMessageRefs(db, allowed, refs);
  const now = Math.floor(Date.now() / 1000);

  const rows = resolved.flatMap((message) => {
    const effectiveSeen =
      message.ref.kind === "received" ? changes.seen : undefined;
    if (effectiveSeen === undefined && changes.starred === undefined) return [];

    const seenAt =
      message.ref.kind === "sent"
        ? null
        : effectiveSeen === true
          ? now
          : effectiveSeen === false
            ? null
            : message.isRead === 1
              ? now
              : null;
    const starredAt = changes.starred === true ? now : null;
    return [
      {
        userId,
        messageKind: message.ref.kind,
        messageId: message.ref.id,
        seenAt,
        starredAt,
        updatedAt: now,
      },
    ];
  });

  const statements: any[] = [];
  for (
    let start = 0;
    start < rows.length;
    start += USER_STATE_ROWS_PER_STATEMENT
  ) {
    const chunk = rows.slice(start, start + USER_STATE_ROWS_PER_STATEMENT);
    statements.push(
      db
        .insert(messageUserState)
        .values(chunk)
        .onConflictDoUpdate({
          target: [
            messageUserState.userId,
            messageUserState.messageKind,
            messageUserState.messageId,
          ],
          set: {
            updatedAt: sql`excluded.updated_at`,
            ...(changes.seen !== undefined
              ? {
                  seenAt: sql`CASE WHEN excluded.message_kind = 'received' THEN excluded.seen_at ELSE message_user_state.seen_at END`,
                }
              : {}),
            ...(changes.starred !== undefined
              ? { starredAt: sql`excluded.starred_at` }
              : {}),
          },
        }),
    );
  }
  await runWriteBatches(db, statements);
}

export async function setSystemSpamState(
  db: DrizzleD1Database<any>,
  inbox: string,
  messageId: string,
  spam = true,
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const spamAt = spam ? now : null;

  await db
    .insert(mailboxMessageState)
    .values({
      inbox: inbox.trim().toLowerCase(),
      messageKind: "received",
      messageId,
      archivedAt: null,
      spamAt,
      trashedAt: null,
      updatedBy: null,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [mailboxMessageState.messageKind, mailboxMessageState.messageId],
      set: {
        inbox: inbox.trim().toLowerCase(),
        spamAt,
        updatedBy: null,
        updatedAt: now,
      },
    });
}

export async function setMailboxState(
  db: DrizzleD1Database<any>,
  allowed: AllowedInboxes,
  userId: string | null,
  refs: MessageRef[],
  changes: {
    archived?: boolean;
    spam?: boolean;
    trashed?: boolean;
  },
): Promise<void> {
  const resolved = await resolveMessageRefs(db, allowed, refs);
  const now = Math.floor(Date.now() / 1000);

  for (const message of resolved) {
    if (
      message.ref.kind === "sent" &&
      (changes.archived !== undefined || changes.spam !== undefined)
    ) {
      throw new InvalidMessageStateError(
        "Archived and spam state apply only to received messages",
      );
    }
  }

  if (
    changes.archived === undefined &&
    changes.spam === undefined &&
    changes.trashed === undefined
  ) {
    return;
  }

  const archivedAt = changes.archived === true ? now : null;
  const spamAt = changes.spam === true ? now : null;
  const trashedAt = changes.trashed === true ? now : null;
  const rows = resolved.map((message) => ({
    inbox: message.inbox,
    messageKind: message.ref.kind,
    messageId: message.ref.id,
    archivedAt,
    spamAt,
    trashedAt,
    updatedBy: userId,
    updatedAt: now,
  }));

  const statements: any[] = [];
  for (
    let start = 0;
    start < rows.length;
    start += MAILBOX_STATE_ROWS_PER_STATEMENT
  ) {
    statements.push(
      db
        .insert(mailboxMessageState)
        .values(rows.slice(start, start + MAILBOX_STATE_ROWS_PER_STATEMENT))
        .onConflictDoUpdate({
          target: [
            mailboxMessageState.messageKind,
            mailboxMessageState.messageId,
          ],
          set: {
            inbox: sql`excluded.inbox`,
            updatedBy: sql`excluded.updated_by`,
            updatedAt: sql`excluded.updated_at`,
            ...(changes.archived !== undefined
              ? { archivedAt: sql`excluded.archived_at` }
              : {}),
            ...(changes.spam !== undefined
              ? { spamAt: sql`excluded.spam_at` }
              : {}),
            ...(changes.trashed !== undefined
              ? { trashedAt: sql`excluded.trashed_at` }
              : {}),
          },
        }),
    );
  }
  await runWriteBatches(db, statements);
}

async function getMailboxForMutation(
  db: DrizzleD1Database<any>,
  allowed: AllowedInboxes,
  mailboxId: string,
) {
  const [mailbox] = await db
    .select()
    .from(mailboxes)
    .where(eq(mailboxes.id, mailboxId))
    .limit(1);
  if (!mailbox || !isInboxAllowed(allowed, mailbox.inbox)) {
    throw new MessageStateAccessError();
  }
  return mailbox;
}

function normalizeMailboxName(name: string): string {
  const value = name.trim();
  if (!value) throw new InvalidMessageStateError("Mailbox name is required");
  return value;
}

export async function createMailbox(
  db: DrizzleD1Database<any>,
  allowed: AllowedInboxes,
  userId: string,
  input: {
    inbox: string;
    name: string;
    parentId?: string | null;
    sortOrder?: number;
  },
) {
  const inbox = input.inbox.trim().toLowerCase();
  if (!isInboxAllowed(allowed, inbox)) throw new MessageStateAccessError();

  const parentId = input.parentId ?? null;
  if (parentId) {
    const parent = await getMailboxForMutation(db, allowed, parentId);
    if (parent.inbox !== inbox) throw new MessageStateAccessError();
  }

  const now = Math.floor(Date.now() / 1000);
  const row = {
    id: nanoid(),
    inbox,
    name: normalizeMailboxName(input.name),
    role: null,
    parentId,
    sortOrder: input.sortOrder ?? 0,
    createdBy: userId,
    createdAt: now,
    updatedAt: now,
  };

  await db.insert(mailboxes).values(row);
  return row;
}

export async function getMailbox(
  db: DrizzleD1Database<any>,
  allowed: AllowedInboxes,
  mailboxId: string,
) {
  return getMailboxForMutation(db, allowed, mailboxId);
}

export async function listMailboxes(
  db: DrizzleD1Database<any>,
  allowed: AllowedInboxes,
  inbox?: string,
) {
  const requested = inbox?.trim().toLowerCase();
  if (requested !== undefined) {
    if (!requested || !isInboxAllowed(allowed, requested)) {
      throw new MessageStateAccessError();
    }
    return db.select().from(mailboxes).where(eq(mailboxes.inbox, requested));
  }

  if (allowed.isAdmin) return db.select().from(mailboxes);
  if (allowed.inboxes.length === 0) return [];

  const rows: (typeof mailboxes.$inferSelect)[] = [];
  for (
    let start = 0;
    start < allowed.inboxes.length;
    start += LOOKUP_BATCH_SIZE
  ) {
    rows.push(
      ...(await db
        .select()
        .from(mailboxes)
        .where(
          inArray(
            mailboxes.inbox,
            allowed.inboxes.slice(start, start + LOOKUP_BATCH_SIZE),
          ),
        )),
    );
  }
  return rows;
}

export async function updateMailbox(
  db: DrizzleD1Database<any>,
  allowed: AllowedInboxes,
  _userId: string,
  mailboxId: string,
  changes: { name?: string; sortOrder?: number },
) {
  const mailbox = await getMailboxForMutation(db, allowed, mailboxId);
  const updatedAt = Math.floor(Date.now() / 1000);
  const update: { name?: string; sortOrder?: number; updatedAt: number } = {
    updatedAt,
  };
  if (changes.name !== undefined)
    update.name = normalizeMailboxName(changes.name);
  if (changes.sortOrder !== undefined) update.sortOrder = changes.sortOrder;

  await db.update(mailboxes).set(update).where(eq(mailboxes.id, mailboxId));
  return { ...mailbox, ...update };
}

export async function renameMailbox(
  db: DrizzleD1Database<any>,
  allowed: AllowedInboxes,
  _userId: string,
  mailboxId: string,
  name: string,
) {
  const mailbox = await getMailboxForMutation(db, allowed, mailboxId);
  const updatedAt = Math.floor(Date.now() / 1000);
  const nextName = normalizeMailboxName(name);

  await db
    .update(mailboxes)
    .set({ name: nextName, updatedAt })
    .where(eq(mailboxes.id, mailboxId));

  return { ...mailbox, name: nextName, updatedAt };
}

export async function deleteMailbox(
  db: DrizzleD1Database<any>,
  allowed: AllowedInboxes,
  _userId: string,
  mailboxId: string,
): Promise<void> {
  await getMailboxForMutation(db, allowed, mailboxId);
  await db.delete(mailboxes).where(eq(mailboxes.id, mailboxId));
}

export async function setMailboxMembership(
  db: DrizzleD1Database<any>,
  allowed: AllowedInboxes,
  userId: string | null,
  refs: MessageRef[],
  changes: { add?: string[]; remove?: string[] },
): Promise<void> {
  const resolved = await resolveMessageRefs(db, allowed, refs);
  const add = [...new Set(changes.add ?? [])];
  const remove = [...new Set(changes.remove ?? [])];
  const mailboxIds = [...new Set([...add, ...remove])];

  if (mailboxIds.length === 0 || resolved.length === 0) return;

  const rows: (typeof mailboxes.$inferSelect)[] = [];
  for (let start = 0; start < mailboxIds.length; start += LOOKUP_BATCH_SIZE) {
    const batch = mailboxIds.slice(start, start + LOOKUP_BATCH_SIZE);
    rows.push(
      ...(await db
        .select()
        .from(mailboxes)
        .where(inArray(mailboxes.id, batch))),
    );
  }
  const byId = new Map(rows.map((row) => [row.id, row]));

  for (const mailboxId of mailboxIds) {
    const mailbox = byId.get(mailboxId);
    if (!mailbox || !isInboxAllowed(allowed, mailbox.inbox)) {
      throw new MessageStateAccessError();
    }
  }

  for (const message of resolved) {
    for (const mailboxId of mailboxIds) {
      if (byId.get(mailboxId)!.inbox !== message.inbox) {
        throw new MessageStateAccessError();
      }
    }
  }

  const now = Math.floor(Date.now() / 1000);
  const statements: any[] = [];
  const addRows = resolved.flatMap((message) =>
    add.map((mailboxId) => ({
      messageKind: message.ref.kind,
      messageId: message.ref.id,
      mailboxId,
      addedBy: userId,
      addedAt: now,
    })),
  );
  for (
    let start = 0;
    start < addRows.length;
    start += MAILBOX_MEMBERSHIP_ROWS_PER_STATEMENT
  ) {
    statements.push(
      db
        .insert(messageMailboxes)
        .values(
          addRows.slice(start, start + MAILBOX_MEMBERSHIP_ROWS_PER_STATEMENT),
        )
        .onConflictDoNothing({
          target: [
            messageMailboxes.messageKind,
            messageMailboxes.messageId,
            messageMailboxes.mailboxId,
          ],
        }),
    );
  }

  const removals = resolved.flatMap((message) =>
    remove.map((mailboxId) => ({
      messageKind: message.ref.kind,
      messageId: message.ref.id,
      mailboxId,
    })),
  );
  for (
    let start = 0;
    start < removals.length;
    start += MAILBOX_MEMBERSHIP_DELETE_ROWS_PER_STATEMENT
  ) {
    const chunk = removals.slice(
      start,
      start + MAILBOX_MEMBERSHIP_DELETE_ROWS_PER_STATEMENT,
    );
    const where = or(
      ...chunk.map((row) =>
        and(
          eq(messageMailboxes.messageKind, row.messageKind),
          eq(messageMailboxes.messageId, row.messageId),
          eq(messageMailboxes.mailboxId, row.mailboxId),
        ),
      ),
    );
    if (where) statements.push(db.delete(messageMailboxes).where(where));
  }

  await runWriteBatches(db, statements);
}

const DELETE_BATCH_SIZE = 40;

export async function deleteMessageState(
  db: DrizzleD1Database<any>,
  refs: MessageRef[],
): Promise<void> {
  const unique = dedupeRefs(refs);

  for (const kind of ["received", "sent"] as const) {
    const ids = unique.filter((ref) => ref.kind === kind).map((ref) => ref.id);

    for (let start = 0; start < ids.length; start += DELETE_BATCH_SIZE) {
      const batch = ids.slice(start, start + DELETE_BATCH_SIZE);
      const userWhere = and(
        eq(messageUserState.messageKind, kind),
        inArray(messageUserState.messageId, batch),
      );
      const mailboxWhere = and(
        eq(mailboxMessageState.messageKind, kind),
        inArray(mailboxMessageState.messageId, batch),
      );
      const membershipWhere = and(
        eq(messageMailboxes.messageKind, kind),
        inArray(messageMailboxes.messageId, batch),
      );

      await db.delete(messageUserState).where(userWhere);
      await db.delete(mailboxMessageState).where(mailboxWhere);
      await db.delete(messageMailboxes).where(membershipWhere);
      if (kind === "received") {
        await db
          .delete(suggestedReplies)
          .where(inArray(suggestedReplies.emailId, batch));
      }
    }
  }
}
