import { WorkflowEntrypoint } from "cloudflare:workers";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import { and, eq, isNull } from "drizzle-orm";
import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";
import { schema } from "../../db/schema";
import { gmailAccounts } from "../../db/gmail-accounts.schema";
import { NO_PERSONAL_INBOX_ERROR } from "./error-codes";
import {
  gmailAuthConfig,
  hasBackfillJob,
  runBackfillChunk,
  type BackfillChunkResult,
} from "./sync";

/**
 * The one-year import as its own job, separate from the 15-minute sync.
 *
 * The cron sync keeps its 50-message budget for live mail. The import runs
 * here instead, as a Cloudflare Workflow that pages through the mailbox
 * newest first, back to back, with no cron tick between pages. Each step is
 * one chunk: a fresh read of the account row, then `CHUNK_SIZE` messages
 * through the same `backfillAccount` the cron used to call, which saves the
 * resume point after every chunk.
 *
 * It PAGINATES ITSELF: after `CHUNKS_PER_JOB` chunks the job hands the account
 * to a successor instance and ends. That keeps every instance far below the
 * per-instance step and subrequest limits however big the mailbox is, and a
 * mailbox's whole year is a chain of short instances rather than one long
 * one.
 *
 * Exactly one job owns an account at a time: `gmail_accounts.backfill_job_id`
 * names it, and a chunk run by any other instance stops without touching
 * anything. A reconnect clears the column; a hand-off moves it to the
 * successor.
 *
 * Nothing here ever gives up on mail. A job that stops early — a message
 * that threw (recorded as `message_failed:<id>`), no inbox mapped yet, a
 * Gmail outage that outlasts the step's retries — leaves the resume point
 * where it was, and `ensureBackfillJobs` on the next cron tick starts a new
 * job from there.
 */

/** Messages per step: small enough that one step is cheap to retry. */
export const CHUNK_SIZE = 25;

/** Steps before handing off to a fresh instance: 250 messages per instance. */
export const CHUNKS_PER_JOB = 10;

export type BackfillJobParams = { accountId: string };

/** Instance statuses that mean the job is alive and will make progress. */
const LIVE_STATUSES = new Set([
  "queued",
  "running",
  "waiting",
  "paused",
  "waitingForPause",
]);

export class GmailBackfillWorkflow extends WorkflowEntrypoint<
  CloudflareBindings,
  BackfillJobParams
> {
  async run(event: WorkflowEvent<BackfillJobParams>, step: WorkflowStep) {
    return runBackfillJob(
      this.env,
      this.ctx,
      step,
      event.payload.accountId,
      event.instanceId,
    );
  }
}

/** The steps a job needs — `WorkflowStep`, or a stand-in in tests. */
type JobStep = Pick<WorkflowStep, "do">;

/**
 * One job's run: up to `CHUNKS_PER_JOB` chunks, then a hand-off. Outside the
 * class so it can be exercised without the Workflows runtime.
 */
export async function runBackfillJob(
  env: CloudflareBindings,
  ctx: ExecutionContext,
  step: JobStep,
  accountId: string,
  jobId: string,
) {
  const cfg = gmailAuthConfig(env);
  if (!cfg) return { status: "stopped", reason: "not_configured" } as const;

  for (let i = 0; i < CHUNKS_PER_JOB; i++) {
    // A throw — Gmail down, a token refresh failing — is retried by the
    // step. It resumes from the last saved point; anything the failed
    // attempt stored before throwing is deduped on the way past.
    const result: BackfillChunkResult = await step.do(
      `chunk ${i}`,
      {
        retries: { limit: 3, delay: "30 seconds", backoff: "exponential" },
        timeout: "10 minutes",
      },
      async () =>
        runBackfillChunk(
          drizzle(env.DB, { schema }),
          env,
          ctx,
          cfg,
          accountId,
          jobId,
          CHUNK_SIZE,
        ),
    );
    if (result.status !== "continue") return result;
  }

  const successor = await step.do("hand off", async () =>
    handOff(drizzle(env.DB, { schema }), env, accountId, jobId),
  );
  return { status: "handed_off", successor } as const;
}

/** A fresh instance id. Unique per start, and within the 100-char limit. */
function newJobId(accountId: string): string {
  return `gmail-backfill-${accountId}-${Date.now()}`;
}

/**
 * Move the account from `fromJobId` to a new instance and start it.
 *
 * The update is conditional on `fromJobId` still owning the account, so a
 * reconnect that happened mid-job wins and nothing is started. Returns the
 * successor's id, or null when there was none to start.
 */
async function handOff(
  db: DrizzleD1Database<typeof schema>,
  env: CloudflareBindings,
  accountId: string,
  fromJobId: string,
): Promise<string | null> {
  const next = newJobId(accountId);
  const moved = await db
    .update(gmailAccounts)
    .set({ backfillJobId: next })
    .where(
      and(
        eq(gmailAccounts.id, accountId),
        eq(gmailAccounts.backfillJobId, fromJobId),
        isNull(gmailAccounts.backfillCompletedAt),
      ),
    )
    .returning({ id: gmailAccounts.id });
  if (moved.length === 0) return null;
  // If this throws after the update, the account names an instance that does
  // not exist; `ensureBackfillJobs` treats that as dead and starts another.
  await env.GMAIL_BACKFILL!.create({ id: next, params: { accountId } });
  return next;
}

/** Start a job for the account and record it as the owner. */
async function startJob(
  db: DrizzleD1Database<typeof schema>,
  env: CloudflareBindings,
  accountId: string,
): Promise<string> {
  const id = newJobId(accountId);
  await db
    .update(gmailAccounts)
    .set({ backfillJobId: id })
    .where(eq(gmailAccounts.id, accountId));
  await env.GMAIL_BACKFILL!.create({ id, params: { accountId } });
  return id;
}

/** Whether the instance named on the row is still going to make progress. */
async function isLive(
  env: CloudflareBindings,
  jobId: string | null,
): Promise<boolean> {
  if (!jobId) return false;
  try {
    const instance = await env.GMAIL_BACKFILL!.get(jobId);
    const { status } = await instance.status();
    return LIVE_STATUSES.has(status);
  } catch {
    // Unknown id: never created, or past its retention. Either way, dead.
    return false;
  }
}

/**
 * Make sure every mailbox with an unfinished import has a live job.
 *
 * Runs on every cron tick, after the live sync, and is the one place a
 * stopped job is restarted. Skips a mailbox with no inbox mapped — the live
 * sync has just recorded that, and a job would stop at once — so an unmapped
 * mailbox costs nothing until someone maps it. `accountId` narrows it to one
 * mailbox, for a caller that has just made it importable.
 *
 * A no-op on a deployment that does not bind `GMAIL_BACKFILL`: the cron sync
 * imports inline there instead.
 */
export async function ensureBackfillJobs(
  db: DrizzleD1Database<typeof schema>,
  env: CloudflareBindings,
  accountId?: string,
): Promise<void> {
  if (!hasBackfillJob(env) || !gmailAuthConfig(env)) return;

  const pending = await db
    .select({
      id: gmailAccounts.id,
      emailAddress: gmailAccounts.emailAddress,
      jobId: gmailAccounts.backfillJobId,
      lastError: gmailAccounts.lastError,
    })
    .from(gmailAccounts)
    .where(
      accountId
        ? and(
            eq(gmailAccounts.id, accountId),
            isNull(gmailAccounts.backfillCompletedAt),
          )
        : isNull(gmailAccounts.backfillCompletedAt),
    );

  for (const account of pending) {
    if (!accountId && account.lastError === NO_PERSONAL_INBOX_ERROR) continue;
    if (await isLive(env, account.jobId)) continue;
    try {
      const id = await startJob(db, env, account.id);
      console.log(
        `Gmail backfill for ${account.emailAddress}: started job ${id}.`,
      );
    } catch (err) {
      const reason = err instanceof Error ? err.message : "unknown error";
      console.error(
        `Gmail backfill for ${account.emailAddress}: could not start a job: ${reason}`,
      );
    }
  }
}
