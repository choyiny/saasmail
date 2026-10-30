import { eq, sql, type SQL } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { nanoid } from "nanoid";
import { senderIdentities } from "../../db/sender-identities.schema";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = DrizzleD1Database<any>;

/**
 * How an inbox groups its mail into conversations:
 * - `relationship` (the default): one conversation per customer (or group
 *   of participants), as the customer view shows it.
 * - `headers`: threads by In-Reply-To and References, like a mail client.
 *   Its mail carries a `thread_key`, which comes first in the conversation
 *   key; a relationship inbox's mail has none.
 */
export type ThreadingMode = "relationship" | "headers";

/** How many cited Message-IDs a message is matched against. */
const MAX_CITED = 20;

/** A Message-ID without its angle brackets. */
export function bareMessageId(id: string): string {
  return id.trim().replace(/^<|>$/g, "");
}

/**
 * The Message-IDs a message cites, nearest first: In-Reply-To, then
 * References from the last (the direct parent) back to the root. Each once,
 * at most 20.
 */
export function citedIdsOf(
  inReplyTo: string | null | undefined,
  references: string | null | undefined,
): string[] {
  const ids = (value: string | null | undefined) =>
    [...(value ?? "").matchAll(/<([^<>\s]+)>/g)].map((match) => match[1]!);
  // An In-Reply-To without brackets (some senders, and our own stored ids)
  // is the bare id itself.
  const parent = ids(inReplyTo);
  if (parent.length === 0 && inReplyTo?.trim()) {
    parent.push(bareMessageId(inReplyTo));
  }
  const ordered = [...parent, ...ids(references).reverse()];
  return [...new Set(ordered)].slice(0, MAX_CITED);
}

async function sha256Hex(text: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)),
  );
  return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * The key of a thread rooted at this Message-ID: `t:` and its SHA-256. A
 * message without one roots its thread at a random id (its `message_id`
 * stays as received).
 */
export async function threadKeyOf(
  messageId: string | null | undefined,
): Promise<string> {
  const root = messageId?.trim() ? bareMessageId(messageId) : nanoid();
  return `t:${await sha256Hex(root)}`;
}

/**
 * The thread of the first message `citedIds` names (nearest first) that is
 * in the inbox and has a thread: as received mail, as sent mail, or as a JMAP
 * send by its content's own Message-ID (the provider may have delivered it
 * under another). A scalar subquery, NULL when none is; the ids are bound as
 * one JSON value per arm.
 */
export function citedThreadKeySql(
  inbox: string,
  citedIds: string[],
): SQL<string | null> {
  const cited = citedIds.slice(0, MAX_CITED).map(bareMessageId);
  if (cited.length === 0) return sql<null>`NULL`;
  const json = JSON.stringify(cited);
  const box = inbox.trim().toLowerCase();
  return sql<string | null>`(SELECT thread_key FROM (
      SELECT c.key AS pos, e.thread_key AS thread_key
      FROM json_each(${json}) c
      JOIN emails e
        ON e.message_id IN (c.value, '<' || c.value || '>')
       AND e.recipient = ${box}
      WHERE e.thread_key IS NOT NULL
      UNION ALL
      SELECT c.key AS pos, se.thread_key AS thread_key
      FROM json_each(${json}) c
      JOIN sent_emails se
        ON se.message_id IN (c.value, '<' || c.value || '>')
       AND se.from_address = ${box}
      WHERE se.thread_key IS NOT NULL
      UNION ALL
      SELECT c.key AS pos, se.thread_key AS thread_key
      FROM json_each(${json}) c
      JOIN jmap_message_content jc ON jc.message_id = c.value
      JOIN sent_emails se
        ON se.jmap_content_id = jc.id
       AND se.from_address = ${box}
      WHERE se.thread_key IS NOT NULL
    )
    ORDER BY pos
    LIMIT 1)`;
}

/**
 * The thread a message belongs to in a `headers` inbox: the thread of the
 * first message it cites that is in the inbox already (`citedThreadKeySql`);
 * else a new thread rooted at its own Message-ID. One statement. No subject
 * matching.
 */
export async function resolveThreadKey(
  db: Db,
  input: {
    inbox: string;
    messageId: string | null | undefined;
    citedIds: string[];
  },
): Promise<string> {
  if (input.citedIds.length > 0) {
    const [found] = await db.all<{ thread_key: string | null }>(
      sql`SELECT ${citedThreadKeySql(input.inbox, input.citedIds)} AS thread_key`,
    );
    if (found?.thread_key) return found.thread_key;
  }
  return threadKeyOf(input.messageId);
}

/** An inbox's threading mode (`relationship` when it has no identity row). */
export async function threadingModeOf(
  db: Db,
  inbox: string,
): Promise<ThreadingMode> {
  const [row] = await db
    .select({ mode: senderIdentities.threadingMode })
    .from(senderIdentities)
    .where(eq(senderIdentities.email, inbox.trim().toLowerCase()))
    .limit(1);
  return row?.mode === "headers" ? "headers" : "relationship";
}

/**
 * The `thread_key` a new message of `inbox` is stored with: null in a
 * relationship inbox; else its resolved thread (or a new one when it cites
 * nothing known).
 */
export async function threadKeyForNewMessage(
  db: Db,
  input: {
    inbox: string;
    messageId: string | null | undefined;
    citedIds?: string[];
    /** The inbox's mode, when the caller already read it. */
    mode?: ThreadingMode;
  },
): Promise<string | null> {
  const mode = input.mode ?? (await threadingModeOf(db, input.inbox));
  if (mode !== "headers") return null;
  return resolveThreadKey(db, {
    inbox: input.inbox,
    messageId: input.messageId,
    citedIds: input.citedIds ?? [],
  });
}
