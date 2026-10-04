import { and, eq, isNull, lt, sql } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { nanoid } from "nanoid";
import { asyncJobs, type AsyncJob } from "../../db/async-jobs.schema";
import { mailboxes } from "../../db/mailboxes.schema";
import { AUDIT_ACTIONS } from "../audit/events";
import { recordAudit } from "../audit/record";
import { jsonList } from "../inbox-permissions";
import { isDemoMode } from "../is-dev";
import { PART_BYTES, PartWriter } from "../jobs/part-writer";
import { encodeCursor } from "../messages/cursor";
import { queryMessages } from "../messages/query";
import type { UnifiedMessage } from "../messages/types";
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
import {
  loadRenderHints,
  mboxEntry,
  renderHintKey,
  renderMessageBytes,
} from "./render-message";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = DrizzleD1Database<any>;

export { PART_BYTES };

/** A queued slice of a mailbox export: the slice the job is waiting for. */
export type MailExportMessage = {
  type: "mail_export";
  jobId: string;
  slice: number;
};

/** What a person asked to export. */
export interface MailExportRequest {
  inbox: string;
  /** Unix seconds; inclusive bounds on the message date. */
  from?: number | null;
  to?: number | null;
  includeTrash?: boolean;
  includeCampaignSends?: boolean;
}

/** The job's `params`: the request, and where the upload is. */
export interface ExportParams extends SliceState {
  inbox: string;
  from: number | null;
  to: number | null;
  includeTrash: boolean;
  includeCampaignSends: boolean;
  uploadId: string;
  /** Uploaded parts, each exactly PART_BYTES. */
  parts: { partNumber: number; etag: string }[];
  /** Bytes carried to the next slice, less than a part. */
  pendingKey: string | null;
  /** Bytes written so far (uploaded and carried); the file's size at the end. */
  bytes: number;
  /** Every message is rendered; only the last part and completion are left. */
  finishing: boolean;
}

/** Limits of one slice, checked after each message. */
const SLICE_MESSAGES = 200;
const SLICE_BYTES = 8 * 1024 * 1024;
const SLICE_MS = 20_000;
const PAGE_SIZE = 50;
/** How long a finished export can be downloaded. */
export const EXPORT_TTL_SECONDS = 7 * 24 * 60 * 60;

const objectKey = (jobId: string, inbox: string) =>
  `exports/${jobId}/${inbox}.mbox`;
const exportPrefix = (jobId: string) => `exports/${jobId}/`;

export class ExportRunningError extends Error {
  readonly code = "EXPORT_RUNNING";
  constructor() {
    super("An export of this inbox is already running");
  }
}

export function exportParams(job: AsyncJob): ExportParams {
  return paramsOf<ExportParams>(job);
}

/** Deletes every object under an export's prefix but `keep`. Best-effort. */
async function deleteExportObjects(
  env: CloudflareBindings,
  jobId: string,
  keep: string | null = null,
): Promise<void> {
  try {
    let cursor: string | undefined;
    do {
      const listed = await env.R2.list({
        prefix: exportPrefix(jobId),
        cursor,
        limit: 100,
      });
      const keys = listed.objects
        .map((object) => object.key)
        .filter((key) => key !== keep);
      if (keys.length > 0) await env.R2.delete(keys);
      cursor = listed.truncated ? listed.cursor : undefined;
    } while (cursor);
  } catch (error) {
    console.warn(`[export] objects of ${jobId} not deleted:`, error);
  }
}

/**
 * Starts exporting an inbox: the R2 multipart upload and the job row. The
 * caller queues slice 0 (or runs the slices inline where there is no
 * queue). One running export per inbox: the row is only inserted when no
 * other is running, so two requests at once cannot both start one.
 */
export async function startMailExport(
  db: Db,
  env: CloudflareBindings,
  input: MailExportRequest & { userId: string },
): Promise<AsyncJob> {
  const inbox = input.inbox.trim().toLowerCase();
  const id = nanoid();
  const key = objectKey(id, inbox);
  const upload = await env.R2.createMultipartUpload(key, {
    httpMetadata: { contentType: "application/mbox" },
  });
  const now = Math.floor(Date.now() / 1000);
  const params: ExportParams = {
    inbox,
    from: input.from ?? null,
    to: input.to ?? null,
    includeTrash: input.includeTrash === true,
    includeCampaignSends: input.includeCampaignSends === true,
    uploadId: upload.uploadId,
    slice: 0,
    parts: [],
    pendingKey: null,
    bytes: 0,
    finishing: false,
    lease: null,
    leaseUntil: null,
  };
  const job: AsyncJob = {
    id,
    jobType: "mail_export",
    refId: inbox,
    status: "running",
    cursor: null,
    storageKey: key,
    totalRows: null,
    processedRows: 0,
    importedCount: 0,
    skippedCount: 0,
    errorSummary: null,
    params: JSON.stringify(params),
    requestedBy: input.userId,
    createdAt: now,
    updatedAt: now,
  };
  const result = await db.run(sql`
    INSERT INTO async_jobs (id, job_type, ref_id, status, storage_key, processed_rows, imported_count, skipped_count, params, requested_by, created_at, updated_at)
    SELECT ${id}, 'mail_export', ${inbox}, 'running', ${key}, 0, 0, 0, ${job.params}, ${input.userId}, ${now}, ${now}
    WHERE NOT EXISTS (
      SELECT 1 FROM async_jobs
      WHERE job_type = 'mail_export' AND ref_id = ${inbox} AND status = 'running'
    )
  `);
  if (changesOf(result) !== 1) {
    await upload.abort().catch(() => {});
    throw new ExportRunningError();
  }
  await recordAudit(db, {
    action: AUDIT_ACTIONS.exportStarted,
    targetType: "export",
    targetId: id,
    inbox,
    summary: `Started exporting ${inbox}`,
    details: {
      from: params.from,
      to: params.to,
      includeTrash: params.includeTrash,
      includeCampaignSends: params.includeCampaignSends,
    },
  });
  return job;
}

const encoder = new TextEncoder();

/** A label as header text: quoted when it has a comma, RFC 2047 if not ASCII. */
function labelText(name: string): string {
  if (/^[\x20-\x7e]*$/.test(name)) {
    return /[,"\\]/.test(name) ? `"${name.replace(/["\\]/g, "\\$&")}"` : name;
  }
  let binary = "";
  for (const byte of encoder.encode(name)) binary += String.fromCharCode(byte);
  return `=?UTF-8?B?${btoa(binary)}?=`;
}

/**
 * What saasmail knows about a message beyond its bytes, as headers an import
 * can read back (other clients ignore them). Labels follow Gmail's
 * `X-Gmail-Labels`: the system folder (none for archived mail), Starred,
 * then custom folders. Seen and Starred are the requester's.
 */
export function statusHeaders(
  message: UnifiedMessage,
  folderNames: Map<string, string>,
): string[] {
  const state = message.state;
  const labels: string[] = [];
  if (message.direction === "outbound") labels.push("Sent");
  if (state?.trashedAt) labels.push("Trash");
  else if (state?.spamAt) labels.push("Junk");
  else if (!state?.archivedAt && message.direction === "inbound") {
    labels.push("Inbox");
  }
  if (state?.starredAt) labels.push("Starred");
  for (const id of state?.mailboxIds ?? []) {
    const name = folderNames.get(id);
    if (name) labels.push(labelText(name));
  }
  const headers = [`X-Saasmail-Labels: ${labels.join(", ")}`];
  if (message.direction === "inbound") {
    headers.push(`X-Saasmail-Seen: ${state?.seen ? "yes" : "no"}`);
  }
  if (message.personId) headers.push(`X-Saasmail-Person: ${message.personId}`);
  if (state?.conversationKey && /^[\x21-\x7e]+$/.test(state.conversationKey)) {
    headers.push(`X-Saasmail-Conversation: ${state.conversationKey}`);
  }
  return headers;
}

async function customFolderNames(
  db: Db,
  messages: UnifiedMessage[],
): Promise<Map<string, string>> {
  const ids = [
    ...new Set(messages.flatMap((message) => message.state?.mailboxIds ?? [])),
  ];
  if (ids.length === 0) return new Map();
  const rows = await db
    .select({ id: mailboxes.id, name: mailboxes.name })
    .from(mailboxes)
    .where(
      and(sql`${mailboxes.id} IN ${jsonList(ids)}`, isNull(mailboxes.role)),
    );
  return new Map(rows.map((row) => [row.id, row.name]));
}

/**
 * One slice of an export. Renders the next messages (at most 200, about
 * 8 MiB, or 20 seconds' worth) as mbox entries after what the last slice
 * carried over, uploads every whole part, and carries the rest. Returns the
 * next slice to queue, or null when there is none.
 *
 * Safe to run twice: a delivery for a slice the job has moved past does
 * nothing, two deliveries of one slice cannot both claim it, and a retry
 * after a failure re-uploads the same part numbers with the same bytes
 * (rendering is deterministic).
 */
export async function runMailExportSlice(
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
  if (!job || job.jobType !== "mail_export" || job.status !== "running") {
    return null;
  }
  const claim = await claimSlice<ExportParams>(db, job, slice, now());
  if (claim === "stale") return null;
  if (claim === "busy") throw new SliceBusyError(jobId);
  const { params, raw } = claim;

  try {
    if (params.finishing) {
      await completeExport(db, env, job, params, raw);
      return null;
    }
    return await renderSlice(db, env, job, params, raw, now);
  } catch (error) {
    await releaseClaim(db, jobId, params, raw);
    throw error;
  }
}

async function renderSlice(
  db: Db,
  env: CloudflareBindings,
  job: AsyncJob,
  params: ExportParams,
  claimedRaw: string,
  now: () => number,
): Promise<number | null> {
  const started = now();
  const writer = new PartWriter(
    env.R2.resumeMultipartUpload(job.storageKey!, params.uploadId),
    [...params.parts],
  );
  if (params.pendingKey) {
    const pending = await env.R2.get(params.pendingKey);
    if (!pending) throw new Error(`export ${job.id}: carried bytes missing`);
    await writer.write(new Uint8Array(await pending.arrayBuffer()));
  }

  // Oldest first, every folder; Trash and campaign sends only when asked.
  // Each entry goes into the current part as it is rendered, and the slice
  // stops after the message that reaches one of its limits.
  const scope = { isAdmin: false as const, inboxes: [params.inbox] };
  let cursor = job.cursor;
  let processed = 0;
  let written = 0;
  let more = true;
  let full = false;
  while (!full) {
    const page = await queryMessages(db, scope, {
      inboxes: [params.inbox],
      order: "asc",
      limit: Math.min(PAGE_SIZE, SLICE_MESSAGES - processed),
      ...(cursor ? { cursor } : {}),
      ...(params.from !== null ? { after: params.from } : {}),
      ...(params.to !== null ? { before: params.to } : {}),
      ignoreSnooze: true,
      includeTrashed: params.includeTrash,
      excludeCampaignSends: !params.includeCampaignSends,
      withAttachments: true,
      withReplyTo: true,
      withState: true,
      ...(job.requestedBy ? { viewer: { userId: job.requestedBy } } : {}),
    });
    const [names, hints] = await Promise.all([
      customFolderNames(db, page.messages),
      loadRenderHints(db, page.messages),
    ]);
    for (const [index, message] of page.messages.entries()) {
      const entry = mboxEntry(
        await renderMessageBytes(
          db,
          env,
          message,
          hints.get(renderHintKey(message)) ?? null,
        ),
        statusHeaders(message, names),
      );
      await writer.write(entry);
      written += entry.length;
      processed++;
      cursor = encodeCursor({
        v: 1,
        occurredAt: message.occurredAt,
        id: message.ref.id,
        kind: message.ref.kind,
      });
      if (
        processed >= SLICE_MESSAGES ||
        written >= SLICE_BYTES ||
        now() - started >= SLICE_MS
      ) {
        full = true;
        more = index < page.messages.length - 1 || page.hasMore;
        break;
      }
    }
    if (!full && !page.hasMore) {
      more = false;
      break;
    }
  }

  // What did not fill a part waits for the next slice; after the last
  // slice it is the last part.
  const rest = writer.rest();
  let pendingKey: string | null = null;
  if (rest.length > 0) {
    pendingKey = `exports/${job.id}/pending-${nanoid()}`;
    await env.R2.put(pendingKey, rest);
  }

  const next: ExportParams = {
    ...params,
    slice: params.slice + 1,
    parts: writer.parts,
    pendingKey,
    bytes: params.bytes + written,
    finishing: !more,
    lease: null,
    leaseUntil: null,
  };
  let committed = false;
  try {
    const result = await db
      .update(asyncJobs)
      .set({
        cursor,
        processedRows: job.processedRows + processed,
        params: JSON.stringify(next),
        updatedAt: Math.floor(now() / 1000),
      })
      .where(stillClaimed(job.id, claimedRaw));
    committed = changesOf(result) === 1;
  } finally {
    // Not committed (cancelled meanwhile, or the write failed): leave
    // nothing behind. A retry carries the previous bytes again.
    if (!committed && pendingKey) {
      await env.R2.delete(pendingKey).catch(() => {});
    }
  }
  if (!committed) return null;
  if (params.pendingKey) {
    await env.R2.delete(params.pendingKey).catch(() => {});
  }
  return next.slice;
}

/**
 * The last part and completion. A retry after `complete` succeeded finds
 * the object and only marks the job done.
 */
async function completeExport(
  db: Db,
  env: CloudflareBindings,
  job: AsyncJob,
  params: ExportParams,
  claimedRaw: string,
): Promise<void> {
  const key = job.storageKey!;
  let size: number;
  const existing = await env.R2.head(key);
  if (existing) {
    size = existing.size;
  } else {
    const pending = params.pendingKey
      ? await env.R2.get(params.pendingKey)
      : null;
    if (params.pendingKey && !pending) {
      throw new Error(`export ${job.id}: carried bytes missing`);
    }
    const last = pending
      ? new Uint8Array(await pending.arrayBuffer())
      : new Uint8Array(0);
    const upload = env.R2.resumeMultipartUpload(key, params.uploadId);
    if (params.parts.length === 0) {
      // Smaller than a part: one put, and the upload is not needed.
      const object = await env.R2.put(key, last, {
        httpMetadata: { contentType: "application/mbox" },
      });
      size = object?.size ?? last.length;
      await upload.abort().catch(() => {});
    } else {
      const parts = [...params.parts];
      if (last.length > 0) {
        const part = await upload.uploadPart(parts.length + 1, last);
        parts.push({ partNumber: part.partNumber, etag: part.etag });
      }
      size = (await upload.complete(parts)).size;
    }
  }

  const done: ExportParams = {
    ...params,
    pendingKey: null,
    bytes: size,
    lease: null,
    leaseUntil: null,
  };
  const result = await db
    .update(asyncJobs)
    .set({
      status: "completed",
      totalRows: job.processedRows,
      params: JSON.stringify(done),
      updatedAt: Math.floor(Date.now() / 1000),
    })
    .where(stillClaimed(job.id, claimedRaw));
  if (changesOf(result) !== 1) {
    // Cancelled or failed while completing: nothing to keep.
    await deleteExportObjects(env, job.id);
    return;
  }
  await deleteExportObjects(env, job.id, key);
  const total = job.processedRows;
  await recordAudit(db, {
    action: AUDIT_ACTIONS.exportCompleted,
    targetType: "export",
    targetId: job.id,
    inbox: params.inbox,
    summary: `Exported ${total} ${total === 1 ? "message" : "messages"} from ${params.inbox}`,
    details: { messages: total, bytes: size },
  });
  await notifyExportReady(env, job, params.inbox);
}

/** Ends an export that cannot finish, and gives its upload back. */
export async function failMailExport(
  db: Db,
  env: CloudflareBindings,
  jobId: string,
  reason: string,
): Promise<void> {
  const [job] = await db
    .select()
    .from(asyncJobs)
    .where(eq(asyncJobs.id, jobId))
    .limit(1);
  if (!job || job.status !== "running") return;
  const result = await db
    .update(asyncJobs)
    .set({
      status: "failed",
      errorSummary: JSON.stringify([
        { row: job.processedRows, reason: reason.slice(0, 500) },
      ]),
      updatedAt: Math.floor(Date.now() / 1000),
    })
    .where(and(eq(asyncJobs.id, jobId), eq(asyncJobs.status, "running")));
  if (changesOf(result) !== 1) return;
  await abortUpload(env, job);
  await deleteExportObjects(env, job.id);
}

async function abortUpload(env: CloudflareBindings, job: AsyncJob) {
  try {
    await env.R2.resumeMultipartUpload(
      job.storageKey!,
      exportParams(job).uploadId,
    ).abort();
  } catch (error) {
    console.warn(`[export] upload of ${job.id} not aborted:`, error);
  }
}

/** Cancels a running export, or deletes a finished one and its file. */
export async function deleteMailExport(
  db: Db,
  env: CloudflareBindings,
  job: AsyncJob,
): Promise<void> {
  await db.delete(asyncJobs).where(eq(asyncJobs.id, job.id));
  if (job.status === "running") await abortUpload(env, job);
  // The file, and bytes a slice running meanwhile may have carried.
  await deleteExportObjects(env, job.id);
}

/** Queues the slice an export is waiting for, or runs it here in demo mode. */
async function resumeMailExport(
  db: Db,
  env: CloudflareBindings,
  jobId: string,
  slice: number,
): Promise<void> {
  if (isDemoMode(env)) {
    await runMailExportInline(db, env, jobId, slice);
    return;
  }
  const message: MailExportMessage = { type: "mail_export", jobId, slice };
  await env.EMAIL_QUEUE.send(message);
}

/**
 * Hourly. A finished export's file goes after 7 days (the row stays,
 * `expired`). A running export that has not moved for 15 minutes and whose
 * claim has run out lost its queue message (a crash, a failed send): it is
 * queued again, up to three times, and then failed.
 */
export async function reapMailExports(
  db: Db,
  env: CloudflareBindings,
  nowSeconds: number,
): Promise<{ expired: number; resumed: number; failed: number }> {
  const finished = await db
    .select()
    .from(asyncJobs)
    .where(
      and(
        eq(asyncJobs.jobType, "mail_export"),
        eq(asyncJobs.status, "completed"),
        lt(asyncJobs.updatedAt, nowSeconds - EXPORT_TTL_SECONDS),
      ),
    )
    .limit(100);
  for (const job of finished) {
    await db
      .update(asyncJobs)
      .set({ status: "expired", updatedAt: nowSeconds })
      .where(and(eq(asyncJobs.id, job.id), eq(asyncJobs.status, "completed")));
    await deleteExportObjects(env, job.id);
  }

  const idle = await db
    .select()
    .from(asyncJobs)
    .where(
      and(
        eq(asyncJobs.jobType, "mail_export"),
        eq(asyncJobs.status, "running"),
        lt(asyncJobs.updatedAt, nowSeconds - IDLE_SECONDS),
      ),
    )
    .limit(100);
  let resumed = 0;
  let failed = 0;
  for (const job of idle) {
    const recovery = await recoverIdleJob<ExportParams>(db, job, nowSeconds);
    if (recovery.action === "fail") {
      await failMailExport(db, env, job.id, "stalled");
      failed++;
    } else if (recovery.action === "resume") {
      await resumeMailExport(db, env, job.id, recovery.params.slice);
      resumed++;
    }
  }
  return { expired: finished.length, resumed, failed };
}

/**
 * Runs an export's slices one after another, for deployments without a
 * queue consumer (DEMO_MODE). The first error fails the export.
 */
export async function runMailExportInline(
  db: Db,
  env: CloudflareBindings,
  jobId: string,
  from = 0,
): Promise<void> {
  let slice: number | null = from;
  try {
    while (slice !== null) {
      slice = await runMailExportSlice(db, env, jobId, slice);
    }
  } catch (error) {
    console.error(`[export] ${jobId} failed:`, error);
    await failMailExport(
      db,
      env,
      jobId,
      error instanceof Error ? error.message : "export failed",
    );
  }
}

/** Tells the requester the export is ready: open tabs and Web Push. */
async function notifyExportReady(
  env: CloudflareBindings,
  job: AsyncJob,
  inbox: string,
): Promise<void> {
  if (!job.requestedBy) return;
  try {
    await env.NOTIFICATIONS_HUB.get(
      env.NOTIFICATIONS_HUB.idFromName(job.requestedBy),
    ).fetch(
      new Request("http://do/realtime", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "export_ready", inbox, jobId: job.id }),
      }),
    );
  } catch (error) {
    console.warn("[export] ready notice not sent:", error);
  }
}
