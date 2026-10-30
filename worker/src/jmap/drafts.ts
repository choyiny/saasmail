import { and, desc, eq, inArray, sql, type SQL } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { jmapDrafts } from "../db/jmap-drafts.schema";
import { jmapMessageContent } from "../db/jmap-message-content.schema";
import { escapeLike } from "../lib/helpers";
import {
  inboxScopeSql,
  isInboxAllowed,
  jsonList,
  type AllowedInboxes,
} from "../lib/inbox-permissions";
import {
  contentEmailObject,
  deleteContentIfUnreferenced,
  type JmapContentRow,
} from "./content";
import { systemMailboxId } from "./ids";
import { publicCustomMailboxId, publicDraftEmailId } from "./public-ids";

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

/** The custom folders (internal `mailboxes.id`) a draft is filed in. */
export function draftFolderIds(
  draft: Pick<JmapDraftRow, "folderIds">,
): string[] {
  try {
    const parsed = JSON.parse(draft.folderIds ?? "[]") as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((id): id is string => typeof id === "string")
      : [];
  } catch {
    return [];
  }
}

export function draftMailboxIds(draft: JmapDraftRow): Record<string, true> {
  const role = draft.mailboxRole === "trash" ? "trash" : "drafts";
  const ids: Record<string, true> = {
    [systemMailboxId(draft.inbox, role)]: true,
  };
  for (const folder of draftFolderIds(draft)) {
    ids[publicCustomMailboxId(folder)] = true;
  }
  return ids;
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
  next: {
    mailboxRole: "drafts" | "trash";
    seen: boolean;
    flagged: boolean;
    folderIds?: string[];
  },
  now: number,
): Promise<void> {
  const seen = next.seen ? 1 : 0;
  const flagged = next.flagged ? 1 : 0;
  const folderIds = JSON.stringify(
    [...new Set(next.folderIds ?? draftFolderIds(draft))].sort(),
  );
  if (
    next.mailboxRole === draft.mailboxRole &&
    seen === draft.seen &&
    flagged === draft.flagged &&
    folderIds === JSON.stringify([...draftFolderIds(draft)].sort())
  ) {
    return;
  }
  await db
    .update(jmapDrafts)
    .set({
      mailboxRole: next.mailboxRole,
      seen,
      flagged,
      folderIds,
      updatedAt: now,
    })
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
  /** A custom folder (internal `mailboxes.id`) the draft is filed in. */
  mailboxId?: string;
  /** Subject or any body value contains (JMAP `text`). */
  text?: string;
  /** Subject contains. */
  subject?: string;
  /** A text body value contains (never the JSON around the values). */
  body?: string;
  from?: string;
  after?: number;
  before?: number;
  seen?: boolean;
  flagged?: boolean;
  threadKeys?: string[];
  /** In none of these mailboxes (JMAP `inMailboxOtherThan`). */
  exclude?: DraftExclusion[];
};

/** A mailbox a draft can be in: its system role, or a custom folder. */
export type DraftExclusion = {
  inbox: string;
  role?: "drafts" | "trash";
  mailboxId?: string;
};

function likePattern(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? `%${escapeLike(trimmed)}%` : null;
}

/**
 * `DraftFilter.exclude`, in a fixed number of bound parameters however many
 * mailboxes it names (D1 takes at most 100 per statement): one JSON list of
 * inboxes per system role, one JSON list of [inbox, folder id] pairs.
 */
function draftExclusionSql(exclusions: DraftExclusion[] | undefined): SQL {
  if (!exclusions || exclusions.length === 0) return sql``;
  const roleInboxes = new Map<string, Set<string>>();
  const folderPairs: [string, string][] = [];
  for (const exclusion of exclusions) {
    const inbox = exclusion.inbox.toLowerCase();
    if (exclusion.mailboxId !== undefined) {
      folderPairs.push([inbox, exclusion.mailboxId]);
    } else if (exclusion.role !== undefined) {
      const inboxes = roleInboxes.get(exclusion.role) ?? new Set<string>();
      inboxes.add(inbox);
      roleInboxes.set(exclusion.role, inboxes);
    }
  }
  const clauses: SQL[] = [];
  for (const [role, inboxes] of roleInboxes) {
    clauses.push(
      sql`AND NOT (d.mailbox_role = ${role} AND d.inbox IN ${jsonList([...inboxes])})`,
    );
  }
  if (folderPairs.length > 0) {
    clauses.push(sql`AND NOT EXISTS (
      SELECT 1 FROM json_each(d.folder_ids) jf
      JOIN json_each(${JSON.stringify(folderPairs)}) excluded
        ON json_extract(excluded.value, '$[0]') = d.inbox
        AND json_extract(excluded.value, '$[1]') = jf.value
    )`);
  }
  return sql.join(clauses, sql` `);
}

/** WHERE clause over `jmap_drafts d JOIN jmap_message_content c`. */
export function draftWhereSql(
  allowed: AllowedInboxes,
  userId: string,
  filter: DraftFilter,
): SQL {
  const textPattern = likePattern(filter.text);
  const subjectPattern = likePattern(filter.subject);
  const bodyPattern = likePattern(filter.body);
  return sql`d.user_id = ${userId}
    ${inboxScopeSql(allowed, sql`d.inbox`)}
    ${filter.inbox === undefined ? sql`` : sql`AND d.inbox = ${filter.inbox.toLowerCase()}`}
    ${filter.role === undefined ? sql`` : sql`AND d.mailbox_role = ${filter.role}`}
    ${
      filter.mailboxId === undefined
        ? sql``
        : sql`AND EXISTS (SELECT 1 FROM json_each(d.folder_ids) jf WHERE jf.value = ${filter.mailboxId})`
    }
    ${
      textPattern === null
        ? sql``
        : sql`AND (c.subject LIKE ${textPattern} ESCAPE '\\' OR EXISTS (SELECT 1 FROM json_each(c.body_values_json) bv WHERE bv.value LIKE ${textPattern} ESCAPE '\\'))`
    }
    ${
      subjectPattern === null
        ? sql``
        : sql`AND c.subject LIKE ${subjectPattern} ESCAPE '\\'`
    }
    ${
      bodyPattern === null
        ? sql``
        : sql`AND EXISTS (SELECT 1 FROM json_each(c.body_values_json) bv WHERE bv.key IN (SELECT tb.value FROM json_each(c.text_body_json) tb) AND bv.value LIKE ${bodyPattern} ESCAPE '\\')`
    }
    ${draftExclusionSql(filter.exclude)}
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
          : sql`AND c.thread_key IN ${jsonList(filter.threadKeys)}`
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
