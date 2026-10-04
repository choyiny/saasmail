import { SQL, and, desc, eq, inArray, lt, sql } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { nanoid } from "nanoid";
import { asyncJobs, type AsyncJob } from "../../db/async-jobs.schema";
import { inboxConversationState } from "../../db/inbox-conversation-state.schema";
import { bumpJmapEpoch } from "../../jmap/epoch";
import { AUDIT_ACTIONS } from "../audit/events";
import { recordAudit } from "../audit/record";
import { isDemoMode } from "../is-dev";
import {
  IDLE_SECONDS,
  SliceBusyError,
  changesOf,
  claimSlice,
  paramsOf,
  recoverIdleJob,
  releaseClaim,
  stillClaimed,
  type SliceState,
} from "../jobs/slices";
import { notifyMailRefresh } from "../triage/ai-file";
import { queryMessages } from "./query";
import {
  citedIdsOf,
  citedThreadKeySql,
  threadKeyOf,
  threadingModeOf,
  type ThreadingMode,
} from "./thread-key";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = DrizzleD1Database<any>;

/** The D1 binding behind a drizzle database (drizzle sets `$client`). */
const d1Of = (db: Db) => (db as Db & { $client: D1Database }).$client;

/** A queued slice of an inbox's thread backfill. */
export type ThreadBackfillMessage = {
  type: "thread_backfill";
  jobId: string;
  slice: number;
};

export interface BackfillParams extends SliceState {
  inbox: string;
  mode: ThreadingMode;
  /** `headers`: the walk (1), then the walk again for late parents (2). */
  pass: 1 | 2;
  /** `queryMessages` cursor of the walk, null at its start. */
  cursor: string | null;
  /**
   * Why it runs: an admin switched the mode (the default), or an import into
   * a headers inbox finished and its mail needs the late-parent pass.
   */
  rethread?: "switch" | "import";
}

export const BACKFILL_LIMITS = {
  /** Messages read per page. */
  pageSize: 200,
  /** Row statements per slice (D1 allows 1,000 queries an invocation). */
  sliceStatements: 400,
  /** Wall time per slice. */
  sliceMs: 20_000,
  /** Rows cleared per statement when going back to `relationship`. */
  clearBatch: 500,
};

/**
 * A D1 statement for `$client.batch`: drizzle's own batch takes builders
 * only, and the row updates here are raw SQL.
 */
function prepared(
  db: Db,
  statement: SQL | { toSQL(): { sql: string; params: unknown[] } },
): D1PreparedStatement {
  const query =
    statement instanceof SQL
      ? // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (db as any).dialect.sqlToQuery(statement)
      : statement.toSQL();
  return d1Of(db)
    .prepare(query.sql)
    .bind(...query.params);
}

/** The newest backfill of an inbox, running or not. */
export async function latestThreadBackfill(
  db: Db,
  inbox: string,
): Promise<AsyncJob | null> {
  const [job] = await db
    .select()
    .from(asyncJobs)
    .where(
      and(eq(asyncJobs.jobType, "thread_backfill"), eq(asyncJobs.refId, inbox)),
    )
    .orderBy(desc(asyncJobs.createdAt), desc(sql`rowid`))
    .limit(1);
  return job ?? null;
}

/**
 * Claims the inbox for a backfill to `mode`: inserts the job unless one is
 * running for it already (then null). Nothing else has changed yet, so a
 * caller that gets null can answer 409.
 */
export async function insertThreadBackfill(
  db: Db,
  input: {
    inbox: string;
    mode: ThreadingMode;
    requestedBy: string | null;
    /** An import's re-thread starts at the late-parent pass. */
    rethread?: "import";
  },
): Promise<AsyncJob | null> {
  const id = nanoid();
  const now = Math.floor(Date.now() / 1000);
  const params: BackfillParams = {
    slice: 0,
    lease: null,
    leaseUntil: null,
    inbox: input.inbox,
    mode: input.mode,
    pass: input.rethread === "import" ? 2 : 1,
    cursor: null,
    ...(input.rethread ? { rethread: input.rethread } : {}),
  };
  const result = await db.run(sql`
    INSERT INTO async_jobs
      (id, job_type, ref_id, status, params, requested_by, processed_rows,
       imported_count, skipped_count, created_at, updated_at)
    SELECT ${id}, 'thread_backfill', ${input.inbox}, 'running',
      ${JSON.stringify(params)}, ${input.requestedBy}, 0, 0, 0, ${now}, ${now}
    WHERE NOT EXISTS (
      SELECT 1 FROM async_jobs
      WHERE job_type = 'thread_backfill' AND ref_id = ${input.inbox}
        AND status = 'running'
    )
  `);
  if (changesOf(result) !== 1) return null;
  const [job] = await db
    .select()
    .from(asyncJobs)
    .where(eq(asyncJobs.id, id))
    .limit(1);
  return job ?? null;
}

/**
 * After the mode is saved: clears the inbox's snoozes and assignments (they
 * were keyed by conversations that no longer exist; not for an import's
 * re-thread), counts the work for the progress bar, and starts the job.
 * Returns how many states were cleared. In demo mode the slices run through
 * `waitUntil`, or here when there is none.
 */
export async function startThreadBackfill(
  db: Db,
  env: CloudflareBindings,
  job: AsyncJob,
  waitUntil?: (promise: Promise<unknown>) => void,
): Promise<number> {
  const { inbox, mode, pass, rethread } = paramsOf<BackfillParams>(job);
  const cleared =
    rethread === "import"
      ? 0
      : changesOf(
          await db
            .delete(inboxConversationState)
            .where(eq(inboxConversationState.inbox, inbox)),
        );
  const passes = pass === 2 ? 1 : 2;
  const [counted] = await db.all<{ total: number }>(
    mode === "headers"
      ? sql`SELECT ${passes} * (
          (SELECT COUNT(*) FROM emails WHERE recipient = ${inbox}) +
          (SELECT COUNT(*) FROM sent_emails WHERE from_address = ${inbox})
        ) AS total`
      : sql`SELECT
          (SELECT COUNT(*) FROM emails
            WHERE recipient = ${inbox} AND thread_key IS NOT NULL) +
          (SELECT COUNT(*) FROM sent_emails
            WHERE from_address = ${inbox} AND thread_key IS NOT NULL)
        AS total`,
  );
  await db
    .update(asyncJobs)
    .set({ totalRows: counted?.total ?? 0 })
    .where(eq(asyncJobs.id, job.id));
  if (isDemoMode(env)) {
    // No queue consumer: run the slices after the response (the hourly run
    // finishes one that outlives it).
    const run = runThreadBackfillInline(db, env, job.id);
    if (waitUntil) waitUntil(run);
    else await run;
  } else {
    await resumeThreadBackfill(db, env, job.id, 0);
  }
  return cleared;
}

/**
 * After an import into a `headers` inbox: mail imported out of date order
 * stored replies before the messages they answer, each in a thread of its
 * own. The late-parent pass over the inbox, oldest first, joins them. A
 * backfill already running for the inbox is left to do it.
 */
export async function rethreadAfterImport(
  db: Db,
  env: CloudflareBindings,
  inbox: string,
  requestedBy: string | null,
): Promise<void> {
  if ((await threadingModeOf(db, inbox)) !== "headers") return;
  const job = await insertThreadBackfill(db, {
    inbox,
    mode: "headers",
    requestedBy,
    rethread: "import",
  });
  if (job) await startThreadBackfill(db, env, job);
}

/** Queues the slice a backfill is waiting for, or runs it here in demo mode. */
export async function resumeThreadBackfill(
  db: Db,
  env: CloudflareBindings,
  jobId: string,
  slice: number,
): Promise<void> {
  if (isDemoMode(env)) {
    await runThreadBackfillInline(db, env, jobId, slice);
    return;
  }
  const message: ThreadBackfillMessage = {
    type: "thread_backfill",
    jobId,
    slice,
  };
  await env.EMAIL_QUEUE.send(message);
}

/** Runs a backfill's slices one after another (DEMO_MODE). */
export async function runThreadBackfillInline(
  db: Db,
  env: CloudflareBindings,
  jobId: string,
  from = 0,
): Promise<void> {
  let slice: number | null = from;
  try {
    while (slice !== null) {
      slice = await runThreadBackfillSlice(db, env, jobId, slice);
    }
  } catch (error) {
    console.error(`[threads] backfill ${jobId} failed:`, error);
    await failThreadBackfill(
      db,
      jobId,
      error instanceof Error ? error.message : "backfill failed",
    );
  }
}

/**
 * One slice of a backfill: up to `sliceStatements` rows or `sliceMs`,
 * saving progress after every page. Returns the next slice, or null when
 * the job is done (or no longer this run's). Re-running a page is safe: each
 * row's key is computed from the rows around it, not from its own.
 */
export async function runThreadBackfillSlice(
  db: Db,
  env: CloudflareBindings,
  jobId: string,
  slice: number,
  now: () => number = Date.now,
): Promise<number | null> {
  const [job] = await db
    .select()
    .from(asyncJobs)
    .where(eq(asyncJobs.id, jobId))
    .limit(1);
  if (!job || job.status !== "running") return null;
  const claim = await claimSlice<BackfillParams>(db, job, slice, now());
  if (claim === "stale") return null;
  if (claim === "busy") throw new SliceBusyError(jobId);
  const { params, raw } = claim;
  if ((await threadingModeOf(db, params.inbox)) !== params.mode) {
    // The mode moved under the job (its save failed after the job was
    // claimed, or the inbox went): keys for the old mode would be wrong.
    await failThreadBackfill(
      db,
      jobId,
      "the inbox's conversation mode changed",
    );
    return null;
  }
  let state = { raw, params };
  try {
    const started = now();
    let statements = 0;
    for (;;) {
      // Every row write is conditional on this run still holding the job, so
      // a run that lost it (a stall past its lease) writes nothing.
      const claimed = sql`EXISTS (
        SELECT 1 FROM async_jobs
        WHERE id = ${job.id} AND status = 'running' AND params = ${state.raw}
      )`;
      const step =
        params.mode === "headers"
          ? await headersPage(db, state.params, claimed)
          : await clearPage(db, state.params, claimed);
      const next: BackfillParams = { ...state.params, ...step.progress };
      const nextRaw = JSON.stringify(next);
      // One transaction: the rows and the progress that covers them.
      const saved = await d1Of(db).batch([
        ...step.statements.map((statement) => prepared(db, statement)),
        prepared(
          db,
          db
            .update(asyncJobs)
            .set({
              params: nextRaw,
              processedRows: sql`${asyncJobs.processedRows} + ${step.rows}`,
              updatedAt: Math.floor(now() / 1000),
            })
            .where(stillClaimed(job.id, state.raw)),
        ),
      ]);
      if (changesOf(saved[saved.length - 1]) !== 1) return null;
      state = { raw: nextRaw, params: next };
      if (step.done) {
        await completeThreadBackfill(db, env, job, state.raw);
        return null;
      }
      // The page read and the progress write count too: a page whose rows
      // cite nothing (pass 2) still costs two queries.
      statements += step.statements.length + 2;
      if (
        statements >= BACKFILL_LIMITS.sliceStatements ||
        now() - started >= BACKFILL_LIMITS.sliceMs
      ) {
        break;
      }
    }
    const released = await db
      .update(asyncJobs)
      .set({
        params: JSON.stringify({
          ...state.params,
          slice: state.params.slice + 1,
          lease: null,
          leaseUntil: null,
        }),
        updatedAt: Math.floor(now() / 1000),
      })
      .where(stillClaimed(job.id, state.raw));
    return changesOf(released) === 1 ? state.params.slice + 1 : null;
  } catch (error) {
    await releaseClaim(db, jobId, state.params, state.raw);
    throw error;
  }
}

type Step = {
  statements: SQL[];
  rows: number;
  progress: Partial<BackfillParams>;
  done: boolean;
};

/**
 * A page of the `headers` walk, oldest first, both directions, every folder.
 * Each row takes the thread of the nearest message it cites that has one;
 * on the first pass a row citing nothing known roots its own thread, on the
 * second it keeps the thread it has. A statement per row, in one batch, so
 * a reply sees the key its parent got earlier in the page.
 */
async function headersPage(
  db: Db,
  params: BackfillParams,
  claimed: SQL,
): Promise<Step> {
  const page = await queryMessages(
    db,
    { isAdmin: true },
    {
      inboxes: [params.inbox],
      order: "asc",
      limit: BACKFILL_LIMITS.pageSize,
      ...(params.cursor ? { cursor: params.cursor } : {}),
      ignoreSnooze: true,
    },
  );
  const statements: SQL[] = [];
  const sentIds: string[] = [];
  for (const message of page.messages) {
    const cited = citedIdsOf(message.inReplyTo, message.references ?? null);
    if (params.pass === 2 && cited.length === 0) continue;
    const { kind, id } = message.ref;
    const table = kind === "received" ? sql`emails` : sql`sent_emails`;
    const fallback =
      params.pass === 1
        ? sql`${await threadKeyOf(
            message.messageId?.trim() ? message.messageId : `${kind}:${id}`,
          )}`
        : sql`${table}.thread_key`;
    statements.push(sql`
      UPDATE ${table} SET thread_key = x.k
      FROM (SELECT COALESCE(${citedThreadKeySql(params.inbox, cited)}, ${fallback}) AS k
            FROM ${table} WHERE id = ${id}) AS x
      WHERE ${table}.id = ${id} AND ${table}.thread_key IS NOT x.k
        AND ${claimed}
    `);
    if (kind === "sent") sentIds.push(id);
  }
  if (sentIds.length > 0) {
    // A JMAP send's thread is its content's: keep the two the same.
    statements.push(sql`
      UPDATE jmap_message_content
      SET thread_key = (
        SELECT se.thread_key FROM sent_emails se
        WHERE se.jmap_content_id = jmap_message_content.id
          AND se.thread_key IS NOT NULL
        LIMIT 1
      )
      WHERE id IN (
        SELECT jmap_content_id FROM sent_emails
        WHERE id IN (SELECT value FROM json_each(${JSON.stringify(sentIds)}))
          AND jmap_content_id IS NOT NULL AND thread_key IS NOT NULL
      )
      AND ${claimed}
    `);
  }
  const walked = page.nextCursor === null;
  return {
    statements,
    rows: page.messages.length,
    progress: walked
      ? params.pass === 1
        ? { pass: 2, cursor: null }
        : { cursor: null }
      : { cursor: page.nextCursor },
    done: walked && params.pass === 2,
  };
}

/**
 * Back to `relationship`: clears `thread_key` a batch at a time. A JMAP
 * send's content goes back to the conversation its Sent row is in, as a
 * draft written in a relationship inbox would have.
 */
async function clearPage(
  db: Db,
  params: BackfillParams,
  claimed: SQL,
): Promise<Step> {
  const inbox = params.inbox;
  const batch = BACKFILL_LIMITS.clearBatch;
  const [left] = await db.all<{ received: number; sent: number }>(sql`
    SELECT
      (SELECT COUNT(*) FROM (SELECT 1 FROM emails
        WHERE recipient = ${inbox} AND thread_key IS NOT NULL
        LIMIT ${batch})) AS received,
      (SELECT COUNT(*) FROM (SELECT 1 FROM sent_emails
        WHERE from_address = ${inbox} AND thread_key IS NOT NULL
        LIMIT ${batch})) AS sent
  `);
  const received = left?.received ?? 0;
  const sent = left?.sent ?? 0;
  const sentRows = sql`
    SELECT rowid FROM sent_emails
    WHERE from_address = ${inbox} AND thread_key IS NOT NULL
    ORDER BY rowid LIMIT ${batch}
  `;
  const statements: SQL[] = [];
  if (received > 0) {
    statements.push(sql`
      UPDATE emails SET thread_key = NULL
      WHERE rowid IN (
        SELECT rowid FROM emails
        WHERE recipient = ${inbox} AND thread_key IS NOT NULL
        ORDER BY rowid LIMIT ${batch}
      )
      AND ${claimed}
    `);
  }
  if (sent > 0) {
    // The same rows in both statements: the batch is one transaction.
    statements.push(
      sql`
        UPDATE jmap_message_content
        SET thread_key = (
          SELECT COALESCE(se.conversation_id, 'p:' || se.person_id, 'sent:' || se.id)
          FROM sent_emails se WHERE se.jmap_content_id = jmap_message_content.id
          LIMIT 1
        )
        WHERE id IN (
          SELECT jmap_content_id FROM sent_emails
          WHERE rowid IN (${sentRows}) AND jmap_content_id IS NOT NULL
        )
        AND ${claimed}
      `,
      sql`UPDATE sent_emails SET thread_key = NULL
          WHERE rowid IN (${sentRows}) AND ${claimed}`,
    );
  }
  return {
    statements,
    rows: received + sent,
    progress: {},
    done: received < batch && sent < batch,
  };
}

async function completeThreadBackfill(
  db: Db,
  env: CloudflareBindings,
  job: AsyncJob,
  claimedRaw: string,
): Promise<void> {
  const params = paramsOf<BackfillParams>(job);
  // Thread ids changed under every JMAP account: clients resync once. First,
  // so a crash before the status write can't leave them unannounced (a retry
  // bumps again, which costs one more resync).
  await bumpJmapEpoch(db, job.requestedBy);
  const result = await db
    .update(asyncJobs)
    .set({
      status: "completed",
      params: JSON.stringify({
        ...JSON.parse(claimedRaw),
        lease: null,
        leaseUntil: null,
      }),
      updatedAt: Math.floor(Date.now() / 1000),
    })
    .where(stillClaimed(job.id, claimedRaw));
  if (changesOf(result) !== 1) return;
  const [done] = await db
    .select({ processedRows: asyncJobs.processedRows })
    .from(asyncJobs)
    .where(eq(asyncJobs.id, job.id))
    .limit(1);
  await notifyMailRefresh(db, env, params.inbox);
  await recordAudit(db, {
    action: AUDIT_ACTIONS.inboxUpdated,
    targetType: "inbox",
    targetId: params.inbox,
    inbox: params.inbox,
    summary:
      params.rethread === "import"
        ? `Threaded the mail imported into ${params.inbox}`
        : params.mode === "headers"
          ? `Grouped the mail of ${params.inbox} into threads`
          : `Grouped the mail of ${params.inbox} by customer`,
    details: {
      threadingMode: params.mode,
      backfill: "completed",
      rows: done?.processedRows ?? 0,
      ...(params.rethread === "import" ? { rethread: "import" } : {}),
    },
  });
}

/** Ends a backfill that cannot finish; mail stays as far as it got. */
export async function failThreadBackfill(
  db: Db,
  jobId: string,
  reason: string,
): Promise<void> {
  const [job] = await db
    .select()
    .from(asyncJobs)
    .where(eq(asyncJobs.id, jobId))
    .limit(1);
  if (!job || job.status !== "running") return;
  const params = paramsOf<BackfillParams>(job);
  // Some threads may have moved already: clients resync (before the status
  // write, as on completion).
  await bumpJmapEpoch(db, job.requestedBy);
  const result = await db
    .update(asyncJobs)
    .set({
      status: "failed",
      errorSummary: JSON.stringify([
        { row: job.processedRows, reason: reason.slice(0, 300) },
      ]),
      updatedAt: Math.floor(Date.now() / 1000),
    })
    .where(and(eq(asyncJobs.id, jobId), eq(asyncJobs.status, "running")));
  if (changesOf(result) !== 1) return;
  await recordAudit(db, {
    action: AUDIT_ACTIONS.inboxUpdated,
    targetType: "inbox",
    targetId: params.inbox,
    inbox: params.inbox,
    summary: `Regrouping the mail of ${params.inbox} stopped: ${reason.slice(0, 120)}`,
    details: {
      threadingMode: params.mode,
      backfill: "failed",
      rows: job.processedRows,
      reason: reason.slice(0, 300),
    },
  });
}

/** Hourly: a backfill that stopped moving is queued again (three times). */
export async function reapThreadBackfills(
  db: Db,
  env: CloudflareBindings,
  nowSeconds: number,
): Promise<{ resumed: number; failed: number }> {
  const idle = await db
    .select()
    .from(asyncJobs)
    .where(
      and(
        eq(asyncJobs.jobType, "thread_backfill"),
        eq(asyncJobs.status, "running"),
        lt(asyncJobs.updatedAt, nowSeconds - IDLE_SECONDS),
      ),
    )
    .limit(100);
  let resumed = 0;
  let failed = 0;
  for (const job of idle) {
    const recovery = await recoverIdleJob<BackfillParams>(db, job, nowSeconds);
    if (recovery.action === "fail") {
      await failThreadBackfill(db, job.id, "stalled");
      failed++;
    } else if (recovery.action === "resume") {
      await resumeThreadBackfill(db, env, job.id, recovery.params.slice);
      resumed++;
    }
  }
  return { resumed, failed };
}

/** What the inbox list shows of a backfill. */
export function backfillStatus(job: AsyncJob | null) {
  if (!job) return null;
  const params = paramsOf<BackfillParams>(job);
  return {
    id: job.id,
    mode: params.mode,
    status: job.status as "running" | "completed" | "failed",
    processed: job.processedRows,
    // Mail that arrived during the walk is counted as it is visited.
    total: Math.max(job.totalRows ?? 0, job.processedRows),
  };
}

/** Running backfills of these inboxes, newest per inbox. */
export async function latestThreadBackfills(
  db: Db,
  inboxes: string[],
): Promise<Map<string, AsyncJob>> {
  const latest = new Map<string, AsyncJob>();
  if (inboxes.length === 0) return latest;
  const rows = await db
    .select()
    .from(asyncJobs)
    .where(
      and(
        eq(asyncJobs.jobType, "thread_backfill"),
        inArray(
          asyncJobs.refId,
          sql`(SELECT value FROM json_each(${JSON.stringify(inboxes)}))`,
        ),
      ),
    )
    .orderBy(desc(asyncJobs.createdAt), desc(sql`rowid`));
  for (const row of rows) {
    if (!latest.has(row.refId)) latest.set(row.refId, row);
  }
  return latest;
}
