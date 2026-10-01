import { and, eq, inArray, sql, type SQL, type SQLWrapper } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { emails } from "../../db/emails.schema";
import { inboxConversationState } from "../../db/inbox-conversation-state.schema";
import { sentEmails } from "../../db/sent-emails.schema";
import {
  isInboxAllowed,
  resolveAllowedInboxes,
  type AllowedInboxes,
} from "../inbox-permissions";
import { users } from "../../db/auth.schema";
import { InvalidMessageStateError, MessageStateAccessError } from "./state";
import type { MessageRef, UnifiedMessage } from "./types";

const LOOKUP_BATCH_SIZE = 40;
const MAX_SNOOZE_SECONDS = 366 * 24 * 60 * 60;

type ConversationSource = {
  conversationId: string | null;
  personId: string | null;
};

type ResolvedConversation = {
  inbox: string;
  conversationKey: string;
};

const refKey = (ref: MessageRef) => `${ref.kind}:${ref.id}`;

export function conversationKeySql(alias: {
  conversationId: SQLWrapper;
  personId: SQLWrapper;
}): SQL<string | null> {
  return sql<
    string | null
  >`COALESCE(${alias.conversationId}, 'p:' || ${alias.personId})`;
}

export function conversationKeyOf(
  message:
    | Pick<UnifiedMessage, "conversationId" | "personId">
    | ConversationSource,
): string | null {
  if (message.conversationId) return message.conversationId;
  if (message.personId) return `p:${message.personId}`;
  return null;
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

async function resolveConversationRefs(
  db: DrizzleD1Database<any>,
  allowed: AllowedInboxes,
  refs: MessageRef[],
): Promise<ResolvedConversation[]> {
  const unique = dedupeRefs(refs);
  if (unique.length === 0) return [];

  const receivedIds = unique
    .filter((ref) => ref.kind === "received")
    .map((ref) => ref.id);
  const sentIds = unique
    .filter((ref) => ref.kind === "sent")
    .map((ref) => ref.id);

  const byRef = new Map<string, ConversationSource & { inbox: string }>();

  for (let start = 0; start < receivedIds.length; start += LOOKUP_BATCH_SIZE) {
    const batch = receivedIds.slice(start, start + LOOKUP_BATCH_SIZE);
    const rows = await db
      .select({
        id: emails.id,
        inbox: emails.recipient,
        conversationId: emails.conversationId,
        personId: emails.personId,
      })
      .from(emails)
      .where(inArray(emails.id, batch));
    for (const row of rows) byRef.set(`received:${row.id}`, row);
  }

  for (let start = 0; start < sentIds.length; start += LOOKUP_BATCH_SIZE) {
    const batch = sentIds.slice(start, start + LOOKUP_BATCH_SIZE);
    const rows = await db
      .select({
        id: sentEmails.id,
        inbox: sentEmails.fromAddress,
        conversationId: sentEmails.conversationId,
        personId: sentEmails.personId,
      })
      .from(sentEmails)
      .where(inArray(sentEmails.id, batch));
    for (const row of rows) byRef.set(`sent:${row.id}`, row);
  }

  const distinct = new Map<string, ResolvedConversation>();
  for (const ref of unique) {
    const row = byRef.get(refKey(ref));
    if (!row || !isInboxAllowed(allowed, row.inbox)) {
      throw new MessageStateAccessError();
    }
    const conversationKey = conversationKeyOf(row);
    if (!conversationKey) {
      throw new InvalidMessageStateError(
        "Message has no conversation and cannot be snoozed",
      );
    }
    distinct.set(`${row.inbox}\u0000${conversationKey}`, {
      inbox: row.inbox,
      conversationKey,
    });
  }

  return [...distinct.values()];
}

export async function snoozeConversations(
  db: DrizzleD1Database<any>,
  allowed: AllowedInboxes,
  userId: string | null,
  refs: MessageRef[],
  until: number | null,
): Promise<number> {
  const now = Math.floor(Date.now() / 1000);
  if (
    until !== null &&
    (!Number.isInteger(until) ||
      until <= now ||
      until > now + MAX_SNOOZE_SECONDS)
  ) {
    throw new InvalidMessageStateError(
      "Snooze time must be in the future and no more than 366 days away",
    );
  }

  const conversations = await resolveConversationRefs(db, allowed, refs);
  for (const conversation of conversations) {
    await db
      .insert(inboxConversationState)
      .values({
        inbox: conversation.inbox,
        conversationKey: conversation.conversationKey,
        snoozedUntil: until,
        snoozedBy: userId,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [
          inboxConversationState.inbox,
          inboxConversationState.conversationKey,
        ],
        set: {
          snoozedUntil: until,
          snoozedBy: userId,
          updatedAt: now,
        },
      });
  }

  return conversations.length;
}

export async function assignConversations(
  db: DrizzleD1Database<any>,
  allowed: AllowedInboxes,
  _actorUserId: string | null,
  refs: MessageRef[],
  userId: string | null,
): Promise<number> {
  const conversations = await resolveConversationRefs(db, allowed, refs);
  if (userId !== null) {
    const [user] = await db
      .select({ id: users.id, role: users.role })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    if (!user) throw new MessageStateAccessError();

    const assigneeAllowed = await resolveAllowedInboxes(db, user);
    for (const conversation of conversations) {
      if (!isInboxAllowed(assigneeAllowed, conversation.inbox)) {
        throw new MessageStateAccessError();
      }
    }
  }

  const now = Math.floor(Date.now() / 1000);
  for (const conversation of conversations) {
    await db
      .insert(inboxConversationState)
      .values({
        inbox: conversation.inbox,
        conversationKey: conversation.conversationKey,
        assignedUserId: userId,
        assignedAt: userId === null ? null : now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [
          inboxConversationState.inbox,
          inboxConversationState.conversationKey,
        ],
        set: {
          assignedUserId: userId,
          assignedAt: userId === null ? null : now,
          updatedAt: now,
        },
      });
  }

  return conversations.length;
}

export async function wakeConversation(
  db: DrizzleD1Database<any>,
  inbox: string,
  conversationKey: string,
): Promise<void> {
  await db
    .update(inboxConversationState)
    .set({
      snoozedUntil: null,
      updatedAt: Math.floor(Date.now() / 1000),
    })
    .where(
      and(
        eq(inboxConversationState.inbox, inbox),
        eq(inboxConversationState.conversationKey, conversationKey),
      ),
    );
}

export type PersonGroupConversation = {
  inbox: string;
  conversationId: string;
};

export async function collectPersonGroupConversations(
  db: DrizzleD1Database<any>,
  personId: string,
): Promise<PersonGroupConversation[]> {
  const rows = await db.all<{ inbox: string; conversation_id: string }>(sql`
    SELECT DISTINCT recipient AS inbox, conversation_id
    FROM ${emails}
    WHERE person_id = ${personId} AND conversation_id IS NOT NULL
    UNION
    SELECT DISTINCT from_address AS inbox, conversation_id
    FROM ${sentEmails}
    WHERE person_id = ${personId} AND conversation_id IS NOT NULL
  `);
  return rows.map((row) => ({
    inbox: row.inbox,
    conversationId: row.conversation_id,
  }));
}

export async function deletePersonConversationState(
  db: DrizzleD1Database<any>,
  personId: string,
  groupConversations: PersonGroupConversation[] = [],
): Promise<void> {
  await db
    .delete(inboxConversationState)
    .where(eq(inboxConversationState.conversationKey, `p:${personId}`));

  const byInbox = new Map<string, Set<string>>();
  for (const conversation of groupConversations) {
    const ids = byInbox.get(conversation.inbox) ?? new Set<string>();
    ids.add(conversation.conversationId);
    byInbox.set(conversation.inbox, ids);
  }

  for (const [inbox, ids] of byInbox) {
    const allIds = [...ids];
    for (let start = 0; start < allIds.length; start += LOOKUP_BATCH_SIZE) {
      const chunk = allIds.slice(start, start + LOOKUP_BATCH_SIZE);
      // Each conversation id is bound once in each UNION arm, so 40 ids
      // consume ~82 parameters including the two inbox binds — under D1's
      // per-statement cap while checking received and sent mail together.
      const remaining = await db.all<{ conversation_id: string }>(sql`
        SELECT conversation_id FROM ${emails}
        WHERE recipient = ${inbox} AND conversation_id IN ${chunk}
        UNION
        SELECT conversation_id FROM ${sentEmails}
        WHERE from_address = ${inbox} AND conversation_id IN ${chunk}
      `);
      const live = new Set(remaining.map((row) => row.conversation_id));
      const orphaned = chunk.filter(
        (conversationId) => !live.has(conversationId),
      );
      if (orphaned.length === 0) continue;
      await db
        .delete(inboxConversationState)
        .where(
          and(
            eq(inboxConversationState.inbox, inbox),
            inArray(inboxConversationState.conversationKey, orphaned),
          ),
        );
    }
  }
}
