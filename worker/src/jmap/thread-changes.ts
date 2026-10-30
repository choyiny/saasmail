import { sql } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { createDb } from "../db/client";
import {
  inboxScopeSql,
  isInboxAllowed,
  jsonList,
  type AllowedInboxes,
} from "../lib/inbox-permissions";
import { conversationKeySql } from "../lib/messages/conversation-state";
import { jmapHiddenSentSql } from "../lib/messages/jmap-visibility";
import {
  buildMessageQuerySql,
  THREAD_KEYS_PER_QUERY,
} from "../lib/messages/query";
import { emailChangesSince, maxChanges } from "./changes";
import { draftThreadMembers } from "./drafts";
import type { JmapMethodError } from "./emails";
import {
  parseAnyEmailId,
  publicDraftEmailId,
  publicEmailId,
  publicThreadId,
} from "./public-ids";

/**
 * The most D1 queries one `Thread/changes` call may use, well under the 50 a
 * Workers free-plan invocation allows (the request's other calls need some).
 * A change set that would need more is `cannotCalculateChanges`.
 */
export const THREAD_CHANGES_QUERY_BUDGET = 30;

/**
 * Ids per lookup statement. Each list is bound once, as JSON (D1 caps a
 * statement at 100 bound parameters), so this only bounds the parameter's size.
 */
const IDS_PER_QUERY = 1000;

class QueryBudgetExceeded extends Error {}

/**
 * A database whose D1 statements are counted: past `budget` a statement throws
 * before it runs, so the method can never use more.
 */
function budgetedDb(
  db: DrizzleD1Database<any>,
  budget: number,
): DrizzleD1Database<any> {
  const client = (db as unknown as { $client: D1Database }).$client;
  let used = 0;
  const counted = new Proxy(client, {
    get(target, prop) {
      const value = (target as any)[prop];
      if (typeof value !== "function") return value;
      if (prop === "prepare" || prop === "exec") {
        return (...args: unknown[]) => {
          used += 1;
          if (used > budget) throw new QueryBudgetExceeded();
          return value.apply(target, args);
        };
      }
      return value.bind(target);
    },
  });
  return createDb({ DB: counted });
}

function chunks<T>(values: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let start = 0; start < values.length; start += size) {
    result.push(values.slice(start, start + size));
  }
  return result;
}

/** A row's JMAP thread key, as `jmapThreadKey` computes it for a message. */
type KeyRow = { id: string; inbox: string; thread_key: string };

/**
 * Public Email id -> internal thread key for the changed Emails that still
 * exist and are visible, in a few statements (no Email/get projection).
 */
async function changedThreadKeys(
  db: DrizzleD1Database<any>,
  allowed: AllowedInboxes,
  userId: string,
  publicIds: string[],
): Promise<Map<string, string>> {
  const received: string[] = [];
  const sent: string[] = [];
  const drafts: string[] = [];
  for (const publicId of publicIds) {
    const ref = parseAnyEmailId(publicId);
    if (!ref) continue;
    if (ref.kind === "received") received.push(ref.id);
    else if (ref.kind === "sent") sent.push(ref.id);
    else drafts.push(ref.id);
  }

  const keys = new Map<string, string>();
  const keep = (rows: KeyRow[], toPublic: (id: string) => string) => {
    for (const row of rows) {
      if (isInboxAllowed(allowed, row.inbox)) {
        keys.set(toPublic(row.id), row.thread_key);
      }
    }
  };

  for (const chunk of chunks(received, IDS_PER_QUERY)) {
    const naturalKey = conversationKeySql({
      threadKey: sql`e.thread_key`,
      conversationId: sql`e.conversation_id`,
      personId: sql`e.person_id`,
    });
    keep(
      await db.all<KeyRow>(sql`
        SELECT e.id AS id, e.recipient AS inbox,
          COALESCE(${naturalKey}, 'received:' || e.id) AS thread_key
        FROM emails e
        WHERE e.id IN ${jsonList(chunk)}
      `),
      (id) => publicEmailId({ kind: "received", id }),
    );
  }

  // A headers-mode inbox's sent row carries its thread; JMAP content keeps
  // the same key, and a relationship inbox's sent row has none.
  const sentKey = sql`COALESCE(se.thread_key, jmc.thread_key, ${conversationKeySql(
    {
      conversationId: sql`se.conversation_id`,
      personId: sql`se.person_id`,
    },
  )}, 'sent:' || se.id)`;
  for (const chunk of chunks(sent, IDS_PER_QUERY)) {
    keep(
      await db.all<KeyRow>(sql`
        SELECT se.id AS id, se.from_address AS inbox, ${sentKey} AS thread_key
        FROM sent_emails se
        LEFT JOIN jmap_message_content jmc ON jmc.id = se.jmap_content_id
        WHERE se.id IN ${jsonList(chunk)}
          AND NOT ${jmapHiddenSentSql(sql`se.id`)}
      `),
      (id) => publicEmailId({ kind: "sent", id }),
    );
  }

  // A `D…` id is the caller's draft, or the Sent row a submission aliased it
  // onto (spec §3.3).
  for (const chunk of chunks(drafts, IDS_PER_QUERY)) {
    // The ids are bound once and shared by both arms.
    keep(
      await db.all<KeyRow>(sql`
        WITH draft_ids(value) AS (SELECT value FROM json_each(${JSON.stringify(chunk)}))
        SELECT d.id AS id, d.inbox AS inbox, c.thread_key AS thread_key
        FROM jmap_drafts d
        JOIN jmap_message_content c ON c.id = d.content_id
        WHERE d.user_id = ${userId}
          AND d.id IN (SELECT value FROM draft_ids)
        UNION ALL
        SELECT se.jmap_email_id AS id, se.from_address AS inbox,
          ${sentKey} AS thread_key
        FROM sent_emails se
        LEFT JOIN jmap_message_content jmc ON jmc.id = se.jmap_content_id
        WHERE se.jmap_email_id IN (SELECT value FROM draft_ids)
          AND NOT ${jmapHiddenSentSql(sql`se.id`)}
      `),
      publicDraftEmailId,
    );
  }
  return keys;
}

/**
 * Internal thread key -> the public ids of every Email in it: the same three
 * sources as Thread/get (conversation members, the caller's drafts, and
 * JMAP-sent mail under its content's key), ids only.
 */
async function threadMembers(
  db: DrizzleD1Database<any>,
  allowed: AllowedInboxes,
  userId: string,
  threadKeys: string[],
): Promise<Map<string, Set<string>>> {
  const members = new Map<string, Set<string>>();
  const add = (key: string, publicId: string) => {
    const set = members.get(key) ?? new Set<string>();
    set.add(publicId);
    members.set(key, set);
  };
  const messageId = (row: {
    kind: string;
    id: string;
    jmap_email_id: string | null;
  }) =>
    row.jmap_email_id
      ? publicDraftEmailId(row.jmap_email_id)
      : publicEmailId({
          kind: row.kind === "sent" ? "sent" : "received",
          id: row.id,
        });

  for (const chunk of chunks(threadKeys, THREAD_KEYS_PER_QUERY)) {
    const built = buildMessageQuerySql(allowed, {
      threadKeys: chunk,
      limit: null,
      withState: true,
      withJmap: true,
      ignoreSnooze: true,
    });
    if (built) {
      const rows = await db.all<{
        kind: string;
        id: string;
        jmap_email_id: string | null;
        jmap_thread_key: string | null;
        conversation_key: string | null;
      }>(sql`
        SELECT kind, id, jmap_email_id, jmap_thread_key, conversation_key
        FROM (${built.statement})
      `);
      for (const row of rows) {
        add(
          row.jmap_thread_key ??
            row.conversation_key ??
            `${row.kind}:${row.id}`,
          messageId(row),
        );
      }
    }

    const contentRows = await db.all<{
      id: string;
      jmap_email_id: string | null;
      thread_key: string;
    }>(sql`
      SELECT se.id AS id, se.jmap_email_id AS jmap_email_id,
        jmc.thread_key AS thread_key
      FROM sent_emails se
      JOIN jmap_message_content jmc ON jmc.id = se.jmap_content_id
      WHERE jmc.thread_key IN ${jsonList(chunk)}
        AND NOT ${jmapHiddenSentSql(sql`se.id`)}
      ${inboxScopeSql(allowed, sql`se.from_address`)}
    `);
    for (const row of contentRows) {
      add(row.thread_key, messageId({ kind: "sent", ...row }));
    }
  }

  for (const member of await draftThreadMembers(
    db,
    allowed,
    userId,
    threadKeys,
  )) {
    add(member.threadKey, publicDraftEmailId(member.id));
  }
  return members;
}

/**
 * `Thread/changes`. Threads aren't in the change log: they are derived from
 * the Emails changed since the state. A thread is `created` when every Email in
 * it was created since, otherwise `updated`. `destroyed` is always empty: the
 * change log keeps no thread key for a destroyed Email, so a thread whose last
 * Email was destroyed is not reported (Thread/get answers `notFound` for it).
 * The whole method stays within `THREAD_CHANGES_QUERY_BUDGET` queries; a change
 * set that needs more is `cannotCalculateChanges`, and the client refetches.
 */
export async function threadChanges(
  db: DrizzleD1Database<any>,
  allowed: AllowedInboxes,
  userId: string,
  accountId: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown> | JmapMethodError> {
  const requestedMax = maxChanges(args.maxChanges);
  if (typeof requestedMax !== "number") return requestedMax;

  const budgeted = budgetedDb(db, THREAD_CHANGES_QUERY_BUDGET);
  try {
    const changes = await emailChangesSince(
      budgeted,
      allowed,
      userId,
      args.sinceState,
    );
    if (changes.error) return changes.error;
    const since = changes.changes as NonNullable<typeof changes.changes>;

    // Destroyed Emails no longer exist, so only these can name a thread.
    const keyById = await changedThreadKeys(budgeted, allowed, userId, [
      ...new Set([...since.createdIds, ...since.updatedIds]),
    ]);
    const threadKeys = [...new Set(keyById.values())];
    if (threadKeys.length > requestedMax) {
      // Paging would need a thread-level position in the change log.
      return { type: "cannotCalculateChanges" };
    }

    const members = await threadMembers(budgeted, allowed, userId, threadKeys);
    const created = new Set(since.createdIds);
    const createdThreads: string[] = [];
    const updatedThreads: string[] = [];
    for (const key of threadKeys) {
      const emailIds = members.get(key);
      if (!emailIds || emailIds.size === 0) continue;
      const threadId = publicThreadId(key);
      if ([...emailIds].every((id) => created.has(id))) {
        createdThreads.push(threadId);
      } else {
        updatedThreads.push(threadId);
      }
    }

    return {
      accountId,
      oldState: args.sinceState as string,
      newState: since.newState,
      hasMoreChanges: false,
      created: createdThreads,
      updated: updatedThreads,
      destroyed: [],
    };
  } catch (error) {
    // Drizzle wraps what the driver threw; look through the causes.
    for (let cause: unknown = error; cause; cause = (cause as Error).cause) {
      if (cause instanceof QueryBudgetExceeded) {
        return { type: "cannotCalculateChanges" };
      }
    }
    throw error;
  }
}
