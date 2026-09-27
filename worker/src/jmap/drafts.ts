import { and, desc, eq, inArray, sql, type SQL } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { jmapDrafts } from "../db/jmap-drafts.schema";
import { jmapMessageContent } from "../db/jmap-message-content.schema";
import { escapeLike } from "../lib/helpers";
import {
  inboxScopeSql,
  isInboxAllowed,
  type AllowedInboxes,
} from "../lib/inbox-permissions";
import {
  contentEmailObject,
  deleteContentIfUnreferenced,
  type JmapContentRow,
} from "./content";
import { systemMailboxId } from "./ids";
import { publicDraftEmailId } from "./public-ids";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = DrizzleD1Database<any>;

export type JmapDraftRow = typeof jmapDrafts.$inferSelect;
export type DraftWithContent = { draft: JmapDraftRow; content: JmapContentRow };

const DRAFT_ID_CHUNK = 90;

/** The caller's drafts in allowed inboxes, keyed by internal draft id. */
export async function loadDraftsByIds(
  db: Db,
  allowed: AllowedInboxes,
  userId: string,
  draftIds: string[],
): Promise<Map<string, DraftWithContent>> {
  const unique = [...new Set(draftIds)];
  const result = new Map<string, DraftWithContent>();
  for (let start = 0; start < unique.length; start += DRAFT_ID_CHUNK) {
    const rows = await db
      .select({ draft: jmapDrafts, content: jmapMessageContent })
      .from(jmapDrafts)
      .innerJoin(
        jmapMessageContent,
        eq(jmapMessageContent.id, jmapDrafts.contentId),
      )
      .where(
        and(
          eq(jmapDrafts.userId, userId),
          inArray(jmapDrafts.id, unique.slice(start, start + DRAFT_ID_CHUNK)),
        ),
      );
    for (const row of rows) {
      if (isInboxAllowed(allowed, row.draft.inbox))
        result.set(row.draft.id, row);
    }
  }
  return result;
}

/** The caller's drafts in allowed inboxes, newest first. */
export async function listDrafts(
  db: Db,
  allowed: AllowedInboxes,
  userId: string,
  limit: number,
): Promise<DraftWithContent[]> {
  return db
    .select({ draft: jmapDrafts, content: jmapMessageContent })
    .from(jmapDrafts)
    .innerJoin(
      jmapMessageContent,
      eq(jmapMessageContent.id, jmapDrafts.contentId),
    )
    .where(
      and(
        eq(jmapDrafts.userId, userId),
        sql`1 = 1 ${inboxScopeSql(allowed, sql`${jmapDrafts.inbox}`)}`,
      ),
    )
    .orderBy(desc(jmapDrafts.receivedAt), desc(jmapDrafts.id))
    .limit(limit);
}

export function draftKeywords(draft: JmapDraftRow): Record<string, true> {
  const keywords: Record<string, true> = { $draft: true };
  if (draft.seen) keywords.$seen = true;
  if (draft.flagged) keywords.$flagged = true;
  return keywords;
}

export function draftMailboxIds(draft: JmapDraftRow): Record<string, true> {
  const role = draft.mailboxRole === "trash" ? "trash" : "drafts";
  return { [systemMailboxId(draft.inbox, role)]: true };
}

export function draftEmailObject(
  item: DraftWithContent,
  args: Record<string, unknown>,
): Record<string, unknown> | null {
  return contentEmailObject(
    item.content,
    {
      id: publicDraftEmailId(item.draft.id),
      mailboxIds: draftMailboxIds(item.draft),
      keywords: draftKeywords(item.draft),
      receivedAt: item.draft.receivedAt,
    },
    args,
  );
}

export async function updateDraftState(
  db: Db,
  draft: JmapDraftRow,
  next: { mailboxRole: "drafts" | "trash"; seen: boolean; flagged: boolean },
  now: number,
): Promise<void> {
  const seen = next.seen ? 1 : 0;
  const flagged = next.flagged ? 1 : 0;
  if (
    next.mailboxRole === draft.mailboxRole &&
    seen === draft.seen &&
    flagged === draft.flagged
  ) {
    return;
  }
  await db
    .update(jmapDrafts)
    .set({ mailboxRole: next.mailboxRole, seen, flagged, updatedAt: now })
    .where(
      and(eq(jmapDrafts.id, draft.id), eq(jmapDrafts.userId, draft.userId)),
    );
}

/** Delete the draft row, then its content if nothing else references it. */
export async function destroyDraft(
  db: Db,
  env: CloudflareBindings,
  draft: JmapDraftRow,
): Promise<void> {
  await db
    .delete(jmapDrafts)
    .where(
      and(eq(jmapDrafts.id, draft.id), eq(jmapDrafts.userId, draft.userId)),
    );
  try {
    await deleteContentIfUnreferenced(db, env, draft.contentId);
  } catch (error) {
    // The draft is gone either way; content GC retries the cleanup.
    console.error(
      `[jmap] content cleanup for draft ${draft.id} failed:`,
      error,
    );
  }
}

export type DraftFilter = {
  inbox?: string;
  role?: "drafts" | "trash";
  text?: string;
  from?: string;
  after?: number;
  before?: number;
  seen?: boolean;
  flagged?: boolean;
  threadKeys?: string[];
};

/** WHERE clause over `jmap_drafts d JOIN jmap_message_content c`. */
export function draftWhereSql(
  allowed: AllowedInboxes,
  userId: string,
  filter: DraftFilter,
): SQL {
  const text = filter.text?.trim();
  const textPattern = text ? `%${escapeLike(text)}%` : null;
  return sql`d.user_id = ${userId}
    ${inboxScopeSql(allowed, sql`d.inbox`)}
    ${filter.inbox === undefined ? sql`` : sql`AND d.inbox = ${filter.inbox.toLowerCase()}`}
    ${filter.role === undefined ? sql`` : sql`AND d.mailbox_role = ${filter.role}`}
    ${
      textPattern === null
        ? sql``
        : sql`AND (c.subject LIKE ${textPattern} ESCAPE '\\' OR EXISTS (SELECT 1 FROM json_each(c.body_values_json) bv WHERE bv.value LIKE ${textPattern} ESCAPE '\\'))`
    }
    ${
      filter.from === undefined
        ? sql``
        : sql`AND lower(json_extract(c.from_json, '$[0].email')) LIKE ${`%${escapeLike(filter.from.toLowerCase())}%`} ESCAPE '\\'`
    }
    ${filter.after === undefined ? sql`` : sql`AND d.received_at >= ${filter.after}`}
    ${filter.before === undefined ? sql`` : sql`AND d.received_at <= ${filter.before}`}
    ${filter.seen === undefined ? sql`` : filter.seen ? sql`AND d.seen = 1` : sql`AND d.seen = 0`}
    ${filter.flagged === undefined ? sql`` : filter.flagged ? sql`AND d.flagged = 1` : sql`AND d.flagged = 0`}
    ${
      filter.threadKeys === undefined
        ? sql``
        : filter.threadKeys.length === 0
          ? sql`AND 0`
          : sql`AND c.thread_key IN ${filter.threadKeys}`
    }`;
}

/** One UNION ALL arm with the same shape as the message query: kind, id, occurred_at. */
export function draftArmSql(
  allowed: AllowedInboxes,
  userId: string,
  filter: DraftFilter,
  limit: number,
): SQL {
  return sql`SELECT * FROM (
    SELECT 'draft' AS kind, d.id AS id, d.received_at AS occurred_at
      FROM jmap_drafts d
      JOIN jmap_message_content c ON c.id = d.content_id
     WHERE ${draftWhereSql(allowed, userId, filter)}
     ORDER BY d.received_at DESC, d.id DESC
     LIMIT ${limit}
  )`;
}

export async function countDrafts(
  db: Db,
  allowed: AllowedInboxes,
  userId: string,
  filter: DraftFilter,
): Promise<number> {
  const rows = await db.all<{ count: number }>(sql`
    SELECT COUNT(*) AS count
      FROM jmap_drafts d
      JOIN jmap_message_content c ON c.id = d.content_id
     WHERE ${draftWhereSql(allowed, userId, filter)}
  `);
  return Number(rows[0]?.count ?? 0);
}

export function draftThreadKeySql(
  allowed: AllowedInboxes,
  userId: string,
  filter: DraftFilter,
): SQL {
  return sql`SELECT c.thread_key AS thread_key
      FROM jmap_drafts d
      JOIN jmap_message_content c ON c.id = d.content_id
     WHERE ${draftWhereSql(allowed, userId, filter)}`;
}

const THREAD_KEY_CHUNK = 20;

export async function draftThreadMembers(
  db: Db,
  allowed: AllowedInboxes,
  userId: string,
  threadKeys: string[],
): Promise<{ threadKey: string; id: string; receivedAt: number }[]> {
  const members: { threadKey: string; id: string; receivedAt: number }[] = [];
  for (let start = 0; start < threadKeys.length; start += THREAD_KEY_CHUNK) {
    const rows = await db.all<{
      thread_key: string;
      id: string;
      received_at: number;
    }>(sql`
      SELECT c.thread_key AS thread_key, d.id AS id, d.received_at AS received_at
        FROM jmap_drafts d
        JOIN jmap_message_content c ON c.id = d.content_id
       WHERE ${draftWhereSql(allowed, userId, {
         threadKeys: threadKeys.slice(start, start + THREAD_KEY_CHUNK),
       })}
    `);
    for (const row of rows) {
      members.push({
        threadKey: row.thread_key,
        id: row.id,
        receivedAt: row.received_at,
      });
    }
  }
  return members;
}

export async function listDraftThreadKeys(
  db: Db,
  allowed: AllowedInboxes,
  userId: string,
  limit: number,
): Promise<string[]> {
  const rows = await db.all<{ thread_key: string }>(sql`
    SELECT DISTINCT thread_key FROM (${draftThreadKeySql(allowed, userId, {})})
     ORDER BY thread_key
     LIMIT ${limit}
  `);
  return rows.map((row) => row.thread_key);
}
