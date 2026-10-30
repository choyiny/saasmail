import { WorkflowEntrypoint } from "cloudflare:workers";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";
import { schema } from "../../db/schema";
import { gmailAccounts } from "../../db/gmail-accounts.schema";
import { outlookAccounts } from "../../db/outlook-accounts.schema";
import { outlookAuthConfig } from "../outlook/token";
import { runOutlookBackfillChunk } from "../outlook/sync";
import { NO_PERSONAL_INBOX_ERROR } from "./error-codes";
import {
  gmailAuthConfig,
  hasBackfillJob,
  runBackfillChunk,
  type BackfillChunkResult,
} from "./sync";

/**
 * The one-year import as its own job, separate from the hourly sync.
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
 * ONE IMPORT AT A TIME, across every mailbox. `gmail_accounts.backfill_job_id`
 * names the job that owns a mailbox's import, and a job can only be claimed
 * while no unfinished import holds one — in a single conditional UPDATE, so
 * a cron tick and an inbox mapping racing each other cannot both win. Other
 * mailboxes wait their turn; the job that finishes one starts the next. A
 * chunk run by any instance the row does not name stops without touching
 * anything, and a reconnect or disconnect both clears the claim and
 * terminates the job holding it.
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

/**
 * Which mailbox to import. `provider` was added with Outlook; an instance
 * started before that carries none and is a Gmail import.
 */
export type BackfillJobParams = {
  accountId: string;
  provider?: ImportProvider;
};

/** The providers whose mailboxes this job imports. */
export type ImportProvider = "google" | "microsoft";

/**
 * The columns the claim logic touches. `gmail_accounts` and
 * `outlook_accounts` both carry them under the same names, so the one table
 * object stands in for either — `tableFor` is the only place that relies on
 * that.
 */
function tableFor(provider: ImportProvider): typeof gmailAccounts {
  return (provider === "google"
    ? gmailAccounts
    : outlookAccounts) as unknown as typeof gmailAccounts;
}

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
      undefined,
      event.payload.provider ?? "google",
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
  /** Smaller sizes for tests, so a hand-off needs a few messages, not 251. */
  sizes: { chunkSize: number; chunksPerJob: number } = {
    chunkSize: CHUNK_SIZE,
    chunksPerJob: CHUNKS_PER_JOB,
  },
  provider: ImportProvider = "google",
) {
  for (let i = 0; i < sizes.chunksPerJob; i++) {
    // A throw — Gmail down, a token refresh failing — is retried by the
    // step. It resumes from the last saved point; anything the failed
    // attempt stored before throwing is deduped on the way past.
    const result: BackfillChunkResult = await step.do(
      `chunk ${i}`,
      {
        retries: { limit: 3, delay: "30 seconds", backoff: "exponential" },
        timeout: "10 minutes",
      },
      async (): Promise<BackfillChunkResult> => {
        const db = drizzle(env.DB, { schema });
        // Read per chunk, inside the step: an admin can change the provider
        // settings while a job runs.
        if (provider === "microsoft") {
          const cfg = await outlookAuthConfig(db, env);
          if (!cfg) {
            return { status: "stopped", handled: 0, reason: "not_configured" };
          }
          return runOutlookBackfillChunk(
            db,
            env,
            ctx,
            cfg,
            accountId,
            jobId,
            sizes.chunkSize,
          );
        }
        const cfg = await gmailAuthConfig(db, env);
        if (!cfg) {
          return { status: "stopped", handled: 0, reason: "not_configured" };
        }
        return runBackfillChunk(
          db,
          env,
          ctx,
          cfg,
          accountId,
          jobId,
          sizes.chunkSize,
        );
      },
    );
    if (result.status === "done") {
      // Finished, and so no longer holding the claim: hand the turn to the
      // next mailbox now rather than at the next cron tick.
      await step.do("start next", async () =>
        ensureBackfillJobs(drizzle(env.DB, { schema }), env),
      );
    }
    if (result.status !== "continue") return result;
  }

  const successor = await step.do("hand off", async () =>
    handOff(drizzle(env.DB, { schema }), env, provider, accountId, jobId),
  );
  return { status: "handed_off", successor } as const;
}

/** A fresh instance id. Unique per start, and within the 100-char limit. */
function newJobId(provider: ImportProvider, accountId: string): string {
  const prefix = provider === "google" ? "gmail" : "outlook";
  return `${prefix}-backfill-${accountId}-${Date.now()}`;
}

/**
 * True while no unfinished import, of either provider, holds a claim. The
 * one-at-a-time rule spans both tables.
 */
const NO_IMPORT_HOLDS_THE_TURN = sql`NOT EXISTS (SELECT 1 FROM gmail_accounts AS other WHERE other.backfill_job_id IS NOT NULL AND other.backfill_completed_at IS NULL) AND NOT EXISTS (SELECT 1 FROM outlook_accounts AS other WHERE other.backfill_job_id IS NOT NULL AND other.backfill_completed_at IS NULL)`;

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
  provider: ImportProvider,
  accountId: string,
  fromJobId: string,
): Promise<string | null> {
  const table = tableFor(provider);
  const next = newJobId(provider, accountId);
  const moved = await db
    .update(table)
    .set({ backfillJobId: next })
    .where(
      and(
        eq(table.id, accountId),
        eq(table.backfillJobId, fromJobId),
        isNull(table.backfillCompletedAt),
      ),
    )
    .returning({ id: table.id });
  if (moved.length === 0) return null;
  // If this throws after the update, the account names an instance that does
  // not exist; `ensureBackfillJobs` treats that as dead and starts another.
  await env.GMAIL_BACKFILL!.create({
    id: next,
    params: { accountId, provider },
  });
  return next;
}

/**
 * Claim the import turn for `accountId` and start its job — only if no other
 * unfinished import holds a claim. One statement, so it is atomic: of two
 * callers racing, exactly one sees the NOT EXISTS hold. Returns the new job's
 * id, or null when another import has the turn.
 */
async function claimAndStart(
  db: DrizzleD1Database<typeof schema>,
  env: CloudflareBindings,
  provider: ImportProvider,
  accountId: string,
): Promise<string | null> {
  const table = tableFor(provider);
  const id = newJobId(provider, accountId);
  const claimed = await db
    .update(table)
    .set({ backfillJobId: id })
    .where(
      and(
        eq(table.id, accountId),
        isNull(table.backfillJobId),
        isNull(table.backfillCompletedAt),
        NO_IMPORT_HOLDS_THE_TURN,
      ),
    )
    .returning({ id: table.id });
  if (claimed.length === 0) return null;
  try {
    await env.GMAIL_BACKFILL!.create({ id, params: { accountId, provider } });
  } catch (err) {
    // Give the turn back, or it is held by an instance that never existed
    // until the next tick notices.
    await release(db, provider, accountId, id);
    throw err;
  }
  return id;
}

/** Drop `jobId`'s claim on the account, if it still holds it. */
async function release(
  db: DrizzleD1Database<typeof schema>,
  provider: ImportProvider,
  accountId: string,
  jobId: string,
): Promise<void> {
  const table = tableFor(provider);
  await db
    .update(table)
    .set({ backfillJobId: null })
    .where(and(eq(table.id, accountId), eq(table.backfillJobId, jobId)));
}

/**
 * Stop a job whose claim was just taken away (a reconnect or disconnect), so
 * it does not finish its current chunk alongside the next mailbox's job.
 * Best effort: a job that outlives this still stops at its next chunk.
 */
export async function stopBackfillJob(
  env: CloudflareBindings,
  jobId: string | null,
): Promise<void> {
  if (!jobId || !hasBackfillJob(env)) return;
  try {
    const instance = await env.GMAIL_BACKFILL!.get(jobId);
    await instance.terminate();
  } catch {
    // Already finished, or never existed.
  }
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
 * Give the import turn to the next mailbox, if no import holds it.
 *
 * Runs on every cron tick after the live sync, when a job finishes, and when
 * an inbox is mapped. First it releases any claim whose job has died — a
 * message that threw, an outage past the step's retries — and stops if a
 * live job still holds one: one import at a time. Then it claims the next
 * mailbox, healthy ones first and oldest connection first, so a mailbox
 * stuck on a bad message is retried only when nothing else is waiting.
 *
 * A mailbox with no inbox mapped is skipped (the live sync has just recorded
 * that, and its job would stop at once) — except `justMapped`, the one an
 * inbox was mapped to a moment ago, before any sync could clear the error.
 *
 * A no-op on a deployment that does not bind `GMAIL_BACKFILL`: the cron sync
 * imports inline there instead, still one mailbox at a time.
 */
export async function ensureBackfillJobs(
  db: DrizzleD1Database<typeof schema>,
  env: CloudflareBindings,
  justMapped?: string,
): Promise<void> {
  if (!hasBackfillJob(env)) return;

  type Pending = {
    provider: ImportProvider;
    id: string;
    emailAddress: string;
    jobId: string | null;
    lastError: string | null;
    createdAt: number;
  };
  const pending: Pending[] = [];
  // A provider that is not set up contributes nothing: its jobs would stop
  // at once. Both tables are read either way for live claims, below.
  const providers: Array<[ImportProvider, boolean]> = [
    ["google", (await gmailAuthConfig(db, env)) !== null],
    ["microsoft", (await outlookAuthConfig(db, env)) !== null],
  ];
  for (const [provider, configured] of providers) {
    const table = tableFor(provider);
    const rows = await db
      .select({
        id: table.id,
        emailAddress: table.emailAddress,
        jobId: table.backfillJobId,
        lastError: table.lastError,
        createdAt: table.createdAt,
      })
      .from(table)
      .where(isNull(table.backfillCompletedAt));
    for (const row of rows) {
      if (configured || row.jobId) pending.push({ provider, ...row });
    }
  }
  pending.sort((a, b) => a.createdAt - b.createdAt);

  for (const account of pending) {
    if (!account.jobId) continue;
    if (await isLive(env, account.jobId)) return;
    await release(db, account.provider, account.id, account.jobId);
  }

  const configured = new Set(
    providers.filter(([, ok]) => ok).map(([provider]) => provider),
  );
  const candidates = pending
    .filter((a) => configured.has(a.provider))
    .filter(
      (a) => a.id === justMapped || a.lastError !== NO_PERSONAL_INBOX_ERROR,
    )
    .sort(
      (a, b) =>
        Number(b.id === justMapped) - Number(a.id === justMapped) ||
        Number(a.lastError !== null) - Number(b.lastError !== null),
    );

  for (const account of candidates) {
    const label = account.provider === "google" ? "Gmail" : "Outlook";
    try {
      const id = await claimAndStart(db, env, account.provider, account.id);
      if (id) {
        console.log(
          `${label} backfill for ${account.emailAddress}: started job ${id}.`,
        );
      }
      // Claimed, or someone else claimed first: either way the turn is taken.
      return;
    } catch (err) {
      const reason = err instanceof Error ? err.message : "unknown error";
      console.error(
        `${label} backfill for ${account.emailAddress}: could not start a job: ${reason}`,
      );
    }
  }
}
