import { sql } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { mailboxes } from "../db/mailboxes.schema";
import {
  inboxScopeSql,
  jsonList,
  type AllowedInboxes,
} from "../lib/inbox-permissions";
import { SYSTEM_MAILBOX_ROLES } from "./constants";
import { customMailboxId, systemMailboxId } from "./ids";
import { publicIdForChangeObject } from "./public-ids";
import {
  currentJmapState,
  formatJmapState,
  parseJmapState,
  type ParsedJmapState,
} from "./state";
import type { JmapMethodError } from "./emails";

export const JMAP_CHANGE_RETENTION_SECONDS = 30 * 24 * 60 * 60;
export const JMAP_CHANGE_STATE_MAX_AGE_SECONDS = 29 * 24 * 60 * 60;
export const JMAP_CHANGE_PRUNE_LIMIT = 5000;
export const JMAP_CHANGE_WINDOW_LIMIT = 10_000;
export const JMAP_MAX_CHANGES = 256;

type ChangeRow = {
  object_id: string;
  first_seq: number;
  first_op: string;
  last_seq: number;
  last_op: string;
};

type ChangeSets = {
  created: string[];
  updated: string[];
  destroyed: string[];
};

function classify(rows: ChangeRow[]): ChangeSets {
  const result: ChangeSets = { created: [], updated: [], destroyed: [] };
  for (const row of rows) {
    if (row.first_op === "c" && row.last_op === "d") continue;
    if (row.first_op === "c") result.created.push(row.object_id);
    else if (row.last_op === "d") result.destroyed.push(row.object_id);
    else result.updated.push(row.object_id);
  }
  return result;
}

export function maxChanges(value: unknown): number | JmapMethodError {
  if (value === undefined || value === null) return JMAP_MAX_CHANGES;
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    return { type: "invalidArguments", properties: ["maxChanges"] };
  }
  return Math.min(value, JMAP_MAX_CHANGES);
}

/** Every object type a client can name in a change set. */
type ChangeObjectType = "email" | "mailbox" | "submission";

function scopedChangesSql(
  allowed: AllowedInboxes,
  userId: string,
  sinceSeq: number,
  objectType?: ChangeObjectType,
) {
  const sharedInboxScope = inboxScopeSql(allowed, sql`jc.inbox`);
  const personalInboxScope = inboxScopeSql(allowed, sql`jc.inbox`);
  const sharedObjectScope =
    objectType === undefined ? sql`` : sql`AND jc.object_type = ${objectType}`;
  const personalObjectScope =
    objectType === undefined ? sql`` : sql`AND jc.object_type = ${objectType}`;

  return sql`
    SELECT jc.seq, jc.object_id, jc.op, jc.inbox
    FROM jmap_changes jc
    WHERE jc.user_id IS NULL
      AND jc.seq > ${sinceSeq}
      AND (jc.exclude_user_id IS NULL OR jc.exclude_user_id <> ${userId})
      ${sharedInboxScope}
      ${sharedObjectScope}
    UNION ALL
    SELECT jc.seq, jc.object_id, jc.op, jc.inbox
    FROM jmap_changes jc
    WHERE jc.user_id = ${userId}
      AND jc.seq > ${sinceSeq}
      ${personalInboxScope}
      ${personalObjectScope}
  `;
}

async function scopedWindowCount(
  db: DrizzleD1Database<any>,
  allowed: AllowedInboxes,
  userId: string,
  sinceSeq: number,
): Promise<number> {
  const scoped = scopedChangesSql(allowed, userId, sinceSeq);
  const rows = await db.all<{ count: number }>(sql`
    SELECT COUNT(*) AS count
    FROM (
      SELECT 1
      FROM (${scoped}) scoped
      LIMIT ${JMAP_CHANGE_WINDOW_LIMIT + 1}
    )
  `);
  return Number(rows[0]?.count ?? 0);
}

async function validateSinceState(
  db: DrizzleD1Database<any>,
  allowed: AllowedInboxes,
  userId: string,
  value: unknown,
  now: number,
): Promise<
  | {
      since: ParsedJmapState;
      current: Awaited<ReturnType<typeof currentJmapState>>;
    }
  | JmapMethodError
> {
  const since = parseJmapState(value);
  if (!since) return { type: "cannotCalculateChanges" };

  const current = await currentJmapState(db, allowed, userId, now);
  if (
    since.fp !== current.parts.fp ||
    since.issuedAt < now - JMAP_CHANGE_STATE_MAX_AGE_SECONDS
  ) {
    return { type: "cannotCalculateChanges" };
  }

  if (
    (await scopedWindowCount(db, allowed, userId, since.seq)) >
    JMAP_CHANGE_WINDOW_LIMIT
  ) {
    return { type: "cannotCalculateChanges" };
  }

  return { since, current };
}

function groupedChangesSql(
  allowed: AllowedInboxes,
  userId: string,
  sinceSeq: number,
  objectType: ChangeObjectType,
  limit?: number,
) {
  const scoped = scopedChangesSql(allowed, userId, sinceSeq, objectType);
  const limitSql = limit === undefined ? sql`` : sql`LIMIT ${limit}`;
  return sql`
    WITH scoped AS (${scoped}),
    grouped AS (
      SELECT
        object_id,
        MIN(seq) AS first_seq,
        MAX(seq) AS last_seq
      FROM scoped
      GROUP BY object_id
    )
    SELECT
      g.object_id,
      g.first_seq,
      (SELECT s.op FROM scoped s WHERE s.seq = g.first_seq) AS first_op,
      g.last_seq,
      (SELECT s.op FROM scoped s WHERE s.seq = g.last_seq) AS last_op
    FROM grouped g
    ORDER BY g.last_seq
    ${limitSql}
  `;
}

async function loadGroupedChanges(
  db: DrizzleD1Database<any>,
  allowed: AllowedInboxes,
  userId: string,
  sinceSeq: number,
  objectType: ChangeObjectType,
  limit?: number,
): Promise<ChangeRow[]> {
  return db.all<ChangeRow>(
    groupedChangesSql(allowed, userId, sinceSeq, objectType, limit),
  );
}

async function changedEmailInboxes(
  db: DrizzleD1Database<any>,
  allowed: AllowedInboxes,
  userId: string,
  sinceSeq: number,
): Promise<string[]> {
  const scoped = scopedChangesSql(allowed, userId, sinceSeq, "email");
  const rows = await db.all<{ inbox: string }>(sql`
    SELECT DISTINCT inbox
    FROM (${scoped}) scoped
    WHERE inbox IS NOT NULL
  `);
  return rows.map((row) => row.inbox).sort();
}

export async function emailChanges(
  db: DrizzleD1Database<any>,
  allowed: AllowedInboxes,
  userId: string,
  accountId: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown> | JmapMethodError> {
  const requestedMax = maxChanges(args.maxChanges);
  if (typeof requestedMax !== "number") return requestedMax;
  const now = Math.floor(Date.now() / 1000);
  const validation = await validateSinceState(
    db,
    allowed,
    userId,
    args.sinceState,
    now,
  );
  if ("type" in validation) return validation;

  const rows = await loadGroupedChanges(
    db,
    allowed,
    userId,
    validation.since.seq,
    "email",
    requestedMax + 1,
  );
  const hasMoreChanges = rows.length > requestedMax;
  const page = hasMoreChanges ? rows.slice(0, requestedMax) : rows;
  const sets = classify(page);
  const lastSeq = page.at(-1)?.last_seq ?? validation.since.seq;
  const newState = hasMoreChanges
    ? formatJmapState(lastSeq, validation.since.issuedAt, validation.since.fp)
    : validation.current.state;

  return {
    accountId,
    oldState: args.sinceState as string,
    newState,
    hasMoreChanges,
    created: sets.created.map(publicIdForChangeObject),
    updated: sets.updated.map(publicIdForChangeObject),
    destroyed: sets.destroyed.map(publicIdForChangeObject),
    updatedProperties: null,
  };
}

export type EmailChangeSet = {
  /** The state read before anything else: the response's new state. */
  newState: string;
  /** Public ids of the Emails created since (and not destroyed again). */
  createdIds: string[];
  updatedIds: string[];
  destroyedIds: string[];
  /** Every other changed id: updated or destroyed. */
  touchedIds: string[];
};

/**
 * Every Email change since `sinceState`, unpaged, for `Email/queryChanges` and
 * `Thread/changes`. The current state is read first, so a write that lands
 * while the caller assembles its answer shows up again next time. Strict mode
 * is off: `error` is null on success.
 */
export async function emailChangesSince(
  db: DrizzleD1Database<any>,
  allowed: AllowedInboxes,
  userId: string,
  sinceState: unknown,
): Promise<{ changes: EmailChangeSet | null; error: JmapMethodError | null }> {
  const now = Math.floor(Date.now() / 1000);
  const validation = await validateSinceState(
    db,
    allowed,
    userId,
    sinceState,
    now,
  );
  if ("type" in validation) {
    return { changes: null, error: validation as JmapMethodError };
  }

  const rows = await loadGroupedChanges(
    db,
    allowed,
    userId,
    validation.since.seq,
    "email",
  );
  const sets = classify(rows);
  const updatedIds = sets.updated.map(publicIdForChangeObject);
  const destroyedIds = sets.destroyed.map(publicIdForChangeObject);
  return {
    changes: {
      newState: validation.current.state,
      createdIds: sets.created.map(publicIdForChangeObject),
      updatedIds,
      destroyedIds,
      touchedIds: [...updatedIds, ...destroyedIds],
    },
    error: null,
  };
}

export async function submissionChanges(
  db: DrizzleD1Database<any>,
  allowed: AllowedInboxes,
  userId: string,
  accountId: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown> | JmapMethodError> {
  const requestedMax = maxChanges(args.maxChanges);
  if (typeof requestedMax !== "number") return requestedMax;
  const now = Math.floor(Date.now() / 1000);
  const validation = await validateSinceState(
    db,
    allowed,
    userId,
    args.sinceState,
    now,
  );
  if ("type" in validation) return validation;

  const rows = await loadGroupedChanges(
    db,
    allowed,
    userId,
    validation.since.seq,
    "submission",
    requestedMax + 1,
  );
  const hasMoreChanges = rows.length > requestedMax;
  const page = hasMoreChanges ? rows.slice(0, requestedMax) : rows;
  const sets = classify(page);
  const lastSeq = page.at(-1)?.last_seq ?? validation.since.seq;
  return {
    accountId,
    oldState: args.sinceState as string,
    newState: hasMoreChanges
      ? formatJmapState(lastSeq, validation.since.issuedAt, validation.since.fp)
      : validation.current.state,
    hasMoreChanges,
    created: sets.created.map(publicIdForChangeObject),
    updated: sets.updated.map(publicIdForChangeObject),
    destroyed: sets.destroyed.map(publicIdForChangeObject),
    updatedProperties: null,
  };
}

export async function mailboxChanges(
  db: DrizzleD1Database<any>,
  allowed: AllowedInboxes,
  userId: string,
  accountId: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown> | JmapMethodError> {
  const requestedMax = maxChanges(args.maxChanges);
  if (typeof requestedMax !== "number") return requestedMax;
  const now = Math.floor(Date.now() / 1000);
  const validation = await validateSinceState(
    db,
    allowed,
    userId,
    args.sinceState,
    now,
  );
  if ("type" in validation) return validation;

  const mailboxRows = await loadGroupedChanges(
    db,
    allowed,
    userId,
    validation.since.seq,
    "mailbox",
  );
  const sets = classify(mailboxRows);
  const created = new Set(sets.created.map(publicIdForChangeObject));
  const destroyed = new Set(sets.destroyed.map(publicIdForChangeObject));
  const updated = new Set(sets.updated.map(publicIdForChangeObject));

  const changedInboxes = await changedEmailInboxes(
    db,
    allowed,
    userId,
    validation.since.seq,
  );
  const currentMailboxes: (typeof mailboxes.$inferSelect)[] =
    changedInboxes.length === 0
      ? []
      : await db
          .select()
          .from(mailboxes)
          .where(sql`${mailboxes.inbox} IN ${jsonList(changedInboxes)}`);
  const customByInbox = new Map<string, (typeof mailboxes.$inferSelect)[]>();
  for (const mailbox of currentMailboxes) {
    const inbox = mailbox.inbox.toLowerCase();
    const rows = customByInbox.get(inbox) ?? [];
    rows.push(mailbox);
    customByInbox.set(inbox, rows);
  }

  for (const changedInbox of changedInboxes) {
    const inbox = changedInbox.toLowerCase();
    for (const role of SYSTEM_MAILBOX_ROLES) {
      updated.add(systemMailboxId(inbox, role));
    }
    for (const mailbox of customByInbox.get(inbox) ?? []) {
      updated.add(customMailboxId(mailbox.id));
    }
  }

  for (const id of created) updated.delete(id);
  for (const id of destroyed) updated.delete(id);

  const total = created.size + updated.size + destroyed.size;
  if (total > requestedMax) return { type: "cannotCalculateChanges" };

  return {
    accountId,
    oldState: args.sinceState as string,
    newState: validation.current.state,
    hasMoreChanges: false,
    created: [...created],
    updated: [...updated],
    destroyed: [...destroyed],
    updatedProperties:
      mailboxRows.length === 0
        ? ["totalEmails", "unreadEmails", "totalThreads", "unreadThreads"]
        : null,
  };
}

export function pruneJmapChangesCandidatesSql(cutoff: number) {
  return sql`
    SELECT seq
    FROM jmap_changes
    WHERE created_at < ${cutoff}
    ORDER BY created_at, seq
    LIMIT ${JMAP_CHANGE_PRUNE_LIMIT}
  `;
}

export async function pruneJmapChanges(
  db: DrizzleD1Database<any>,
  now: number,
): Promise<void> {
  const cutoff = now - JMAP_CHANGE_RETENTION_SECONDS;
  await db.run(sql`
    DELETE FROM jmap_changes
    WHERE seq IN (${pruneJmapChangesCandidatesSql(cutoff)})
  `);
}
