import { and, eq } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { nanoid } from "nanoid";
import { asyncJobs, type AsyncJob } from "../../db/async-jobs.schema";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = DrizzleD1Database<any>;

/**
 * The part of a sliced job's `params` that keeps two runs of one slice
 * apart. A queued message names the slice it is for; a run claims it with a
 * lease before doing anything.
 */
export interface SliceState {
  /** The slice that runs next; a queued message for another is stale. */
  slice: number;
  /** The run holding the slice now, and until when (Unix ms). */
  lease: string | null;
  leaseUntil: number | null;
  /** Times the hourly run queued the job again after it stopped moving. */
  recoveries?: number;
}

/** Long enough for a slice; a crashed run frees its claim after this. */
export const LEASE_MS = 120_000;
/** A running job not touched for this long has lost its queue message. */
export const IDLE_SECONDS = 15 * 60;
/** Queued again at most this often before it counts as failed. */
export const MAX_RECOVERIES = 3;

/** Another delivery of this slice holds the claim; try again later. */
export class SliceBusyError extends Error {
  constructor(jobId: string) {
    super(`job ${jobId}: the slice is claimed by another run`);
    this.name = "SliceBusyError";
  }
}

export const changesOf = (result: unknown) =>
  Number((result as D1Result).meta?.changes ?? 0);

export function paramsOf<T>(job: AsyncJob): T {
  return JSON.parse(job.params ?? "{}") as T;
}

/** This run's claim on the job: still current, and the job still running. */
export const stillClaimed = (jobId: string, claimedRaw: string) =>
  and(
    eq(asyncJobs.id, jobId),
    eq(asyncJobs.status, "running"),
    eq(asyncJobs.params, claimedRaw),
  );

/**
 * Claims the slice for this run, or says why not: `stale` when the job has
 * moved past it (a duplicate or old delivery), `busy` while another run of
 * it holds the claim.
 */
export async function claimSlice<T extends SliceState>(
  db: Db,
  job: AsyncJob,
  slice: number,
  nowMs: number,
): Promise<{ params: T; raw: string } | "stale" | "busy"> {
  const params = paramsOf<T>(job);
  if (params.slice !== slice) return "stale";
  if (params.lease && (params.leaseUntil ?? 0) > nowMs) return "busy";
  const claimed: T = {
    ...params,
    lease: nanoid(),
    leaseUntil: nowMs + LEASE_MS,
  };
  const raw = JSON.stringify(claimed);
  const result = await db
    .update(asyncJobs)
    .set({ params: raw, updatedAt: Math.floor(nowMs / 1000) })
    .where(
      and(
        eq(asyncJobs.id, job.id),
        eq(asyncJobs.status, "running"),
        eq(asyncJobs.params, job.params ?? ""),
      ),
    );
  return changesOf(result) === 1 ? { params: claimed, raw } : "busy";
}

/** Gives a claim back, so a retry can run at once. Best-effort. */
export async function releaseClaim<T extends SliceState>(
  db: Db,
  jobId: string,
  params: T,
  claimedRaw: string,
): Promise<void> {
  await db
    .update(asyncJobs)
    .set({
      params: JSON.stringify({ ...params, lease: null, leaseUntil: null }),
    })
    .where(stillClaimed(jobId, claimedRaw))
    .catch(() => {});
}

/**
 * For the hourly run: whether a running job that stopped moving should be
 * queued again (`resume`, its params already updated), has failed (`fail`),
 * or is being worked on (`skip`).
 */
export async function recoverIdleJob<T extends SliceState>(
  db: Db,
  job: AsyncJob,
  nowSeconds: number,
): Promise<{ action: "resume"; params: T } | { action: "fail" | "skip" }> {
  const params = paramsOf<T>(job);
  if (params.lease && (params.leaseUntil ?? 0) > nowSeconds * 1000) {
    return { action: "skip" };
  }
  const recoveries = params.recoveries ?? 0;
  if (recoveries >= MAX_RECOVERIES) return { action: "fail" };
  const next: T = {
    ...params,
    lease: null,
    leaseUntil: null,
    recoveries: recoveries + 1,
  };
  const result = await db
    .update(asyncJobs)
    .set({ params: JSON.stringify(next), updatedAt: nowSeconds })
    .where(
      and(
        eq(asyncJobs.id, job.id),
        eq(asyncJobs.status, "running"),
        eq(asyncJobs.params, job.params ?? ""),
      ),
    );
  return changesOf(result) === 1
    ? { action: "resume", params: next }
    : { action: "skip" };
}
