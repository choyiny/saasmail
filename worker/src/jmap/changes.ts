import { inArray, sql } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { mailboxes } from "../db/mailboxes.schema";
import { inboxScopeSql, type AllowedInboxes } from "../lib/inbox-permissions";
import { SYSTEM_MAILBOX_ROLES } from "./constants";
import { customMailboxId, systemMailboxId } from "./ids";
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

const JMAP_CHANGE_INBOX_CHUNK_SIZE = 40;

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

function maxChanges(value: unknown): number | JmapMethodError {
  if (value === undefined || value === null) return JMAP_MAX_CHANGES;
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    return { type: "invalidArguments", properties: ["maxChanges"] };
  }
  return Math.min(value, JMAP_MAX_CHANGES);
}

function allowedChunks(allowed: AllowedInboxes): AllowedInboxes[] {
  if (!("inboxes" in allowed)) return [allowed];
  if (allowed.inboxes.length === 0) return [allowed];

  const inboxes = [
    ...new Set(allowed.inboxes.map((inbox) => inbox.toLowerCase())),
  ];
  const chunks: AllowedInboxes[] = [];
  for (
    let start = 0;
    start < inboxes.length;
    start += JMAP_CHANGE_INBOX_CHUNK_SIZE
  ) {
    chunks.push({
      isAdmin: false,
      inboxes: inboxes.slice(start, start + JMAP_CHANGE_INBOX_CHUNK_SIZE),
    });
  }
  return chunks;
}

function scopedChangesSql(
  allowed: AllowedInboxes,
  userId: string,
  sinceSeq: number,
  objectType?: "email" | "mailbox",
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
  let total = 0;
  for (const chunk of allowedChunks(allowed)) {
    const scoped = scopedChangesSql(chunk, userId, sinceSeq);
    const rows = await db.all<{ count: number }>(sql`
      SELECT COUNT(*) AS count
      FROM (
        SELECT 1
        FROM (${scoped}) scoped
        LIMIT ${JMAP_CHANGE_WINDOW_LIMIT + 1}
      )
    `);
    total += Number(rows[0]?.count ?? 0);
    if (total > JMAP_CHANGE_WINDOW_LIMIT) return total;
  }
  return total;
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
  objectType: "email" | "mailbox",
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
  objectType: "email" | "mailbox",
  limit?: number,
): Promise<ChangeRow[]> {
  const rows: ChangeRow[] = [];
  for (const chunk of allowedChunks(allowed)) {
    rows.push(
      ...(await db.all<ChangeRow>(
        groupedChangesSql(chunk, userId, sinceSeq, objectType, limit),
      )),
    );
  }
  rows.sort((left, right) => left.last_seq - right.last_seq);
  return limit === undefined ? rows : rows.slice(0, limit);
}

async function changedEmailInboxes(
  db: DrizzleD1Database<any>,
  allowed: AllowedInboxes,
  userId: string,
  sinceSeq: number,
): Promise<string[]> {
  const inboxes = new Set<string>();
  for (const chunk of allowedChunks(allowed)) {
    const scoped = scopedChangesSql(chunk, userId, sinceSeq, "email");
    const rows = await db.all<{ inbox: string }>(sql`
      SELECT DISTINCT inbox
      FROM (${scoped}) scoped
      WHERE inbox IS NOT NULL
    `);
    for (const row of rows) inboxes.add(row.inbox);
  }
  return [...inboxes].sort();
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
    created: sets.created,
    updated: sets.updated,
    destroyed: sets.destroyed,
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
  const created = new Set(sets.created);
  const destroyed = new Set(sets.destroyed);
  const updated = new Set(sets.updated);

  const changedInboxes = await changedEmailInboxes(
    db,
    allowed,
    userId,
    validation.since.seq,
  );
  const currentMailboxes: (typeof mailboxes.$inferSelect)[] = [];
  for (
    let start = 0;
    start < changedInboxes.length;
    start += JMAP_CHANGE_INBOX_CHUNK_SIZE
  ) {
    currentMailboxes.push(
      ...(await db
        .select()
        .from(mailboxes)
        .where(
          inArray(
            mailboxes.inbox,
            changedInboxes.slice(start, start + JMAP_CHANGE_INBOX_CHUNK_SIZE),
          ),
        )),
    );
  }
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
