import { eq, inArray, sql } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { jmapMessageContent } from "../db/jmap-message-content.schema";
import { sentEmails } from "../db/sent-emails.schema";
import {
  inboxScopeSql,
  isInboxAllowed,
  type AllowedInboxes,
} from "../lib/inbox-permissions";
import type { MessageRef } from "../lib/messages/types";
import type { JmapContentRow } from "./content";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = DrizzleD1Database<any>;

/** SQLite binds far more, but a statement this wide is already slow to parse. */
const CHUNK = 40;

/** `contentPartBlob` lives beside the other blob resolvers so drafts and `S…` Emails share it. */
export { contentPartBlob } from "./blobs";

export async function loadContentRows(
  db: Db,
  contentIds: string[],
): Promise<Map<string, JmapContentRow>> {
  const unique = [...new Set(contentIds)];
  const byId = new Map<string, JmapContentRow>();
  for (let start = 0; start < unique.length; start += CHUNK) {
    const rows = await db
      .select()
      .from(jmapMessageContent)
      .where(
        inArray(jmapMessageContent.id, unique.slice(start, start + CHUNK)),
      );
    for (const row of rows) byId.set(row.id, row);
  }
  return byId;
}

/** Sent rows whose content thread key is one of `threadKeys`. */
export async function loadContentKeyedSentRefs(
  db: Db,
  allowed: AllowedInboxes,
  threadKeys: string[],
): Promise<MessageRef[]> {
  const scope = inboxScopeSql(allowed, sql`se.from_address`);
  const unique = [...new Set(threadKeys)];
  const refs: MessageRef[] = [];
  for (let start = 0; start < unique.length; start += CHUNK) {
    const rows = await db.all<{ id: string }>(sql`
      SELECT se.id AS id
      FROM sent_emails se
      JOIN jmap_message_content jmc ON jmc.id = se.jmap_content_id
      WHERE jmc.thread_key IN ${unique.slice(start, start + CHUNK)}
      ${scope}
    `);
    refs.push(...rows.map((row) => ({ kind: "sent" as const, id: row.id })));
  }
  return refs;
}

/** Distinct content thread keys of visible JMAP-sent mail (Thread/get, no ids). */
export async function listContentThreadKeys(
  db: Db,
  allowed: AllowedInboxes,
  limit: number,
): Promise<string[]> {
  const scope = inboxScopeSql(allowed, sql`se.from_address`);
  const rows = await db.all<{ thread_key: string }>(sql`
    SELECT DISTINCT jmc.thread_key AS thread_key
    FROM sent_emails se
    JOIN jmap_message_content jmc ON jmc.id = se.jmap_content_id
    WHERE 1 = 1 ${scope}
    ORDER BY thread_key
    LIMIT ${limit}
  `);
  return rows.map((row) => row.thread_key);
}

/** The content, when some Sent row that references it is in an allowed inbox. */
export async function readableSentContent(
  db: Db,
  allowed: AllowedInboxes,
  contentId: string,
): Promise<JmapContentRow | null> {
  const rows = await db
    .select({ inbox: sentEmails.fromAddress })
    .from(sentEmails)
    .where(eq(sentEmails.jmapContentId, contentId));
  if (!rows.some((row) => isInboxAllowed(allowed, row.inbox))) return null;
  const [content] = await db
    .select()
    .from(jmapMessageContent)
    .where(eq(jmapMessageContent.id, contentId))
    .limit(1);
  return content ?? null;
}

/** The content behind a JMAP-sent message the caller may read, or null. */
export async function sentMessageContent(
  db: Db,
  allowed: AllowedInboxes,
  sentEmailId: string,
): Promise<JmapContentRow | null> {
  const [row] = await db
    .select({
      inbox: sentEmails.fromAddress,
      contentId: sentEmails.jmapContentId,
    })
    .from(sentEmails)
    .where(eq(sentEmails.id, sentEmailId))
    .limit(1);
  if (!row || !row.contentId || !isInboxAllowed(allowed, row.inbox))
    return null;
  const [content] = await db
    .select()
    .from(jmapMessageContent)
    .where(eq(jmapMessageContent.id, row.contentId))
    .limit(1);
  return content ?? null;
}
