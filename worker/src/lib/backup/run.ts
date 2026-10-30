import { and, desc, eq, isNull, lt, ne, or, sql } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { nanoid } from "nanoid";
import { backupRuns, type BackupRun } from "../../db/backup-runs.schema";
import { AUDIT_ACTIONS } from "../audit/events";
import { recordAudit } from "../audit/record";
import { isDemoMode } from "../is-dev";
import { LEASE_MS, SliceBusyError, changesOf } from "../jobs/slices";
import { PartWriter, type WrittenPart } from "../jobs/part-writer";
import { backupKey, backupKeyId, encryptFrame, sha256Hex } from "./crypto";
import {
  markBackupStarted,
  nextBackupDue,
  readBackupSettings,
} from "./settings";
import { EXCLUDED_TABLES, backupTables } from "./tables";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = DrizzleD1Database<any>;

/** A queued step of a backup: the step the run is waiting for. */
export type BackupStepMessage = {
  type: "backup_step";
  runId: string;
  step: number;
};

/** The table a run is on. */
interface TableProgress {
  name: string;
  /** The last rowid written. */
  rowid: number;
  rows: number;
  /** Bytes of the file so far. */
  bytes: number;
  uploadId: string;
  parts: WrittenPart[];
  /** Bytes short of a part, carried to the next step. */
  pendingKey: string | null;
  /** Encrypted frames written so far (each frame's index is bound to it). */
  frames: number;
  /** Every row is written; only the last part and completion are left. */
  finishing: boolean;
  /** The last part's size and hash, once finishing. */
  last: { bytes: number; sha256: string } | null;
}

/** A finished table, as the manifest lists it. */
export interface BackupFile {
  name: string;
  file: string;
  rows: number;
  bytes: number;
  /** Byte ranges of the file in order, each with its SHA-256. */
  parts: { bytes: number; sha256: string }[];
  columns: string[];
  primaryKey: string[];
  foreignKeys: { columns: string[]; table: string; references: string[] }[];
  /** Encrypted files: how many frames (a restore checks none is missing). */
  frames: number | null;
}

interface BackupProgress {
  /** The step the run waits for; a queued message for another is stale. */
  step: number;
  lease: string | null;
  leaseUntil: number | null;
  /** The tables to dump, in order (fixed when the run started). */
  tables: string[];
  tableIndex: number;
  current: TableProgress | null;
  done: BackupFile[];
  encrypted: boolean;
  /** Which key encrypts it (see `backupKeyId`); every step checks it. */
  keyId: string | null;
  /** The bucket it was written to, so retention finds it there. */
  bucket: "BACKUPS" | "R2";
  /** The hourly run queued it again once after it stopped moving. */
  resumed?: boolean;
}

export interface BackupManifest {
  format: 1;
  app: "saasmail";
  startedAt: number;
  finishedAt: number;
  /** The last migration the database had applied: a restore target needs it. */
  lastMigration: string | null;
  compression: "gzip";
  /** `aes-256-gcm-frames` when the files are encrypted (see crypto.ts). */
  encryption: "aes-256-gcm-frames" | null;
  /** Which key encrypted it: a restore refuses another. */
  keyId: string | null;
  tables: BackupFile[];
  /** Tables left out on purpose. */
  excluded: string[];
  /** R2 prefixes a move must copy with the bucket: not in this backup. */
  r2Prefixes: string[];
}

/** How much one step does. Mutable for tests. */
export const BACKUP_LIMITS = {
  stepRows: 50_000,
  stepBytes: 16 * 1024 * 1024,
  stepMs: 20_000,
  /** Text gathered before it is compressed into one gzip member. */
  chunkBytes: 2 * 1024 * 1024,
  /** Rows per page at most, and their stored size at most. */
  pageSize: 500,
  pageBytes: 4 * 1024 * 1024,
};
/** A run not touched for this long is queued again (once). */
const STUCK_SECONDS = 2 * 60 * 60;
/** A run not touched for this long has failed. */
const DEAD_SECONDS = 24 * 60 * 60;
/** Runs pruned per hourly pass. */
const PRUNE_RUNS = 5;

/** What else is in the bucket: everything outside `backups/`. */
export const R2_PREFIXES = [
  "attachments/",
  "inbound-raw/",
  "jmap-content/",
  "jmap-uploads/",
  "newsletter-assets/",
  "exports/",
  "imports/",
];

export class BackupRunningError extends Error {
  readonly code = "BACKUP_RUNNING";
  constructor() {
    super("A backup is already running");
  }
}

/** The bucket backups go to: `BACKUPS` when bound, else `R2`. */
export function backupBucket(env: CloudflareBindings): R2Bucket {
  return env.BACKUPS ?? env.R2;
}

/** The bucket a run was written to (an older run may predate `BACKUPS`). */
function runBucket(env: CloudflareBindings, run: BackupRun): R2Bucket {
  const which = backupProgress(run).bucket;
  return which === "R2" ? env.R2 : (env.BACKUPS ?? env.R2);
}

export function backupProgress(run: BackupRun): BackupProgress {
  return JSON.parse(run.progress) as BackupProgress;
}

const fileName = (table: string, encrypted: boolean) =>
  `${table}.ndjson.gz${encrypted ? ".enc" : ""}`;

/** `backups/2026-10-04T0300Z-<id>/`. */
function prefixFor(id: string, at: number): string {
  const iso = new Date(at * 1000).toISOString();
  return `backups/${iso.slice(0, 10)}T${iso.slice(11, 13)}${iso.slice(14, 16)}Z-${id}/`;
}

/**
 * Starts a backup: the run row (only when none is running). The caller
 * queues step 0, or runs the steps inline where there is no queue.
 */
export async function startBackup(
  db: Db,
  env: CloudflareBindings,
  requestedBy: string | null,
  now = Math.floor(Date.now() / 1000),
): Promise<BackupRun> {
  const id = nanoid();
  const progress: BackupProgress = {
    step: 0,
    lease: null,
    leaseUntil: null,
    tables: backupTables().map((table) => table.name),
    tableIndex: 0,
    current: null,
    done: [],
    encrypted: (await backupKey(env)) !== null,
    keyId: await backupKeyId(env),
    bucket: env.BACKUPS ? "BACKUPS" : "R2",
  };
  const run: BackupRun = {
    id,
    startedAt: now,
    finishedAt: null,
    status: "running",
    prefix: prefixFor(id, now),
    progress: JSON.stringify(progress),
    bytes: 0,
    error: null,
    requestedBy,
    prunedAt: null,
    updatedAt: now,
  };
  const result = await db.run(sql`
    INSERT INTO backup_runs (id, started_at, status, prefix, progress, bytes, requested_by, updated_at)
    SELECT ${run.id}, ${now}, 'running', ${run.prefix}, ${run.progress}, 0, ${requestedBy}, ${now}
    WHERE NOT EXISTS (SELECT 1 FROM backup_runs WHERE status = 'running')
  `);
  if (changesOf(result) !== 1) throw new BackupRunningError();
  await markBackupStarted(db, now);
  await recordAudit(db, {
    action: AUDIT_ACTIONS.backupStarted,
    targetType: "backup",
    targetId: id,
    summary: requestedBy ? "Started a backup" : "Started the scheduled backup",
    details: {
      prefix: run.prefix,
      tables: progress.tables.length,
      encrypted: progress.encrypted,
    },
  });
  return run;
}

async function runById(db: Db, id: string): Promise<BackupRun | null> {
  const [run] = await db
    .select()
    .from(backupRuns)
    .where(eq(backupRuns.id, id))
    .limit(1);
  return run ?? null;
}

/** A row as a JSON line: blobs as `{ "$blob": base64 }`. */
export function rowLine(row: Record<string, unknown>): string {
  const out: Record<string, unknown> = {};
  for (const [column, value] of Object.entries(row)) {
    if (column === "__saasmail_rowid") continue;
    if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
      const bytes =
        value instanceof ArrayBuffer
          ? new Uint8Array(value)
          : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
      let binary = "";
      for (const byte of bytes) binary += String.fromCharCode(byte);
      out[column] = { $blob: btoa(binary) };
    } else if (Array.isArray(value)) {
      let binary = "";
      for (const byte of value as number[]) binary += String.fromCharCode(byte);
      out[column] = { $blob: btoa(binary) };
    } else {
      out[column] = value;
    }
  }
  return `${JSON.stringify(out)}\n`;
}

const encoder = new TextEncoder();

/** One gzip member (and, with a key, frame `index` of `file`). */
async function packChunk(
  text: string,
  key: CryptoKey | null,
  file: string,
  index: number,
): Promise<Uint8Array> {
  const gzipped = new Uint8Array(
    await new Response(
      new Blob([encoder.encode(text)])
        .stream()
        .pipeThrough(new CompressionStream("gzip")),
    ).arrayBuffer(),
  );
  return key ? encryptFrame(key, gzipped, file, index) : gzipped;
}

/**
 * One step of a backup: dumps rows table after table (about 50,000 rows,
 * 16 MiB or 20 seconds' worth), each table into its own multipart upload in
 * 5 MiB parts, carrying what does not fill a part to the next step. After
 * the last table, writes the manifest. Returns the next step, or null.
 */
export async function runBackupStep(
  db: Db,
  env: CloudflareBindings,
  runId: string,
  step: number,
  now: () => number = Date.now,
): Promise<number | null> {
  const run = await runById(db, runId);
  if (!run || run.status !== "running") return null;
  const progress = backupProgress(run);
  if (progress.step !== step) return null;
  if (progress.lease && (progress.leaseUntil ?? 0) > now()) {
    throw new SliceBusyError(runId);
  }
  const claimed: BackupProgress = {
    ...progress,
    lease: nanoid(),
    leaseUntil: now() + LEASE_MS,
  };
  let raw = JSON.stringify(claimed);
  const claim = await db
    .update(backupRuns)
    .set({ progress: raw, updatedAt: Math.floor(now() / 1000) })
    .where(
      and(
        eq(backupRuns.id, runId),
        eq(backupRuns.status, "running"),
        eq(backupRuns.progress, run.progress),
      ),
    );
  if (changesOf(claim) !== 1) throw new SliceBusyError(runId);

  const bucket = runBucket(env, run);
  const state: BackupProgress = claimed;

  /** Saves `state`; false when the run was cancelled or taken meanwhile. */
  async function save(extra: Partial<BackupRun> = {}): Promise<boolean> {
    const next = JSON.stringify(state);
    const result = await db
      .update(backupRuns)
      .set({ progress: next, updatedAt: Math.floor(now() / 1000), ...extra })
      .where(
        and(
          eq(backupRuns.id, runId),
          eq(backupRuns.status, "running"),
          eq(backupRuns.progress, raw),
        ),
      );
    if (changesOf(result) !== 1) return false;
    raw = next;
    return true;
  }

  try {
    const key = await backupKey(env);
    // A key set, removed or rotated mid-run would mix keys in one file.
    if ((await backupKeyId(env)) !== state.keyId) {
      throw new Error("BACKUP_ENCRYPTION_KEY changed during the backup");
    }
    const started = now();
    let rows = 0;
    let written = 0;
    const within = () =>
      rows < BACKUP_LIMITS.stepRows &&
      written < BACKUP_LIMITS.stepBytes &&
      now() - started < BACKUP_LIMITS.stepMs;

    while (state.tableIndex < state.tables.length && within()) {
      const name = state.tables[state.tableIndex]!;
      const file = `${run.prefix}${fileName(name, state.encrypted)}`;
      if (!state.current) {
        const upload = await bucket.createMultipartUpload(file);
        state.current = {
          name,
          rowid: 0,
          rows: 0,
          bytes: 0,
          uploadId: upload.uploadId,
          parts: [],
          pendingKey: null,
          frames: 0,
          finishing: false,
          last: null,
        };
      }
      const current = state.current;
      const upload = bucket.resumeMultipartUpload(file, current.uploadId);

      if (!current.finishing) {
        const writer = new PartWriter(upload, [...current.parts], true);
        const oldPending = current.pendingKey;
        if (oldPending) {
          const pending = await bucket.get(oldPending);
          if (!pending)
            throw new Error(`backup ${runId}: carried bytes missing`);
          await writer.write(new Uint8Array(await pending.arrayBuffer()));
        }
        let text = "";
        let finished = false;
        const fileKey = fileName(name, state.encrypted);
        const flush = async () => {
          if (!text) return;
          const chunk = await packChunk(text, key, fileKey, current.frames++);
          text = "";
          await writer.write(chunk);
          current.bytes += chunk.length;
          written += chunk.length;
        };
        const table = backupTables().find((entry) => entry.name === name);
        const sizeOf = sql.join(
          (table?.columns ?? []).map(
            (column) => sql`COALESCE(LENGTH(${sql.identifier(column)}), 0)`,
          ),
          sql` + `,
        );
        while (within()) {
          // The rows ahead and their stored size: the page stops before it
          // would pass pageBytes (one wide row on its own at least), so a
          // run of message bodies never fills the Worker's memory.
          const ahead = await db.all<{ rowid: number; size: number }>(sql`
            SELECT rowid AS rowid, ${table && table.columns.length > 0 ? sizeOf : sql`0`} AS size
            FROM ${sql.identifier(name)}
            WHERE rowid > ${current.rowid}
            ORDER BY rowid
            LIMIT ${BACKUP_LIMITS.pageSize}
          `);
          if (ahead.length === 0) {
            finished = true;
            break;
          }
          let take = 0;
          let bytes = 0;
          for (const row of ahead) {
            if (
              take > 0 &&
              bytes + Number(row.size) > BACKUP_LIMITS.pageBytes
            ) {
              break;
            }
            bytes += Number(row.size);
            take++;
          }
          const lastRowid = Number(ahead[take - 1]!.rowid);
          const page = await db.all<Record<string, unknown>>(sql`
            SELECT rowid AS __saasmail_rowid, * FROM ${sql.identifier(name)}
            WHERE rowid > ${current.rowid} AND rowid <= ${lastRowid}
            ORDER BY rowid
          `);
          for (const row of page) text += rowLine(row);
          current.rowid = lastRowid;
          current.rows += page.length;
          rows += page.length;
          if (text.length >= BACKUP_LIMITS.chunkBytes) await flush();
          // Fewer rows ahead than a page: this was the table's end.
          if (take === ahead.length && ahead.length < BACKUP_LIMITS.pageSize) {
            finished = true;
            break;
          }
        }
        await flush();
        // An empty table still gets a file, so a restore empties it too.
        if (finished && current.bytes === 0) {
          const chunk = await packChunk("", key, fileKey, current.frames++);
          await writer.write(chunk);
          current.bytes += chunk.length;
        }
        const rest = writer.rest();
        let pendingKey: string | null = null;
        if (rest.length > 0) {
          pendingKey = `${run.prefix}.pending/${name}-${nanoid()}`;
          await bucket.put(pendingKey, rest);
        }
        current.parts = writer.parts;
        current.pendingKey = pendingKey;
        current.finishing = finished;
        current.last =
          finished && rest.length > 0
            ? { bytes: rest.length, sha256: await sha256Hex(rest) }
            : null;
        // An error saving may still have saved: keep the new carried bytes
        // (the manifest's sweep removes them if not). Only a definite "not
        // saved" (cancelled, or taken over) deletes them.
        if (!(await save())) {
          if (pendingKey) await bucket.delete(pendingKey).catch(() => {});
          return null;
        }
        if (oldPending) await bucket.delete(oldPending).catch(() => {});
        if (!finished) continue;
      }

      // The last part (or the whole file, when it is smaller than a part).
      // A retry after `complete` finds the file and only records it.
      if (!(await bucket.head(file))) {
        const pending = current.pendingKey
          ? await bucket.get(current.pendingKey)
          : null;
        if (current.pendingKey && !pending) {
          throw new Error(`backup ${runId}: carried bytes missing`);
        }
        const last = pending
          ? new Uint8Array(await pending.arrayBuffer())
          : new Uint8Array(0);
        if (current.parts.length === 0) {
          await bucket.put(file, last);
          await upload.abort().catch(() => {});
        } else {
          const parts = [...current.parts];
          if (last.length > 0) {
            const part = await upload.uploadPart(parts.length + 1, last);
            parts.push({ partNumber: part.partNumber, etag: part.etag });
          }
          await upload.complete(parts);
        }
      }
      const columns = backupTables().find((table) => table.name === name);
      state.done.push({
        name,
        file: fileName(name, state.encrypted),
        rows: current.rows,
        bytes: current.bytes,
        parts: [
          ...current.parts.map((part) => ({
            bytes: part.bytes!,
            sha256: part.sha256!,
          })),
          ...(current.last ? [current.last] : []),
        ],
        columns: columns?.columns ?? [],
        primaryKey: columns?.primaryKey ?? [],
        foreignKeys: columns?.foreignKeys ?? [],
        frames: state.encrypted ? current.frames : null,
      });
      const pendingKey = current.pendingKey;
      state.current = null;
      state.tableIndex++;
      if (!(await save())) return null;
      if (pendingKey) await bucket.delete(pendingKey).catch(() => {});
    }

    if (state.tableIndex < state.tables.length) {
      state.step++;
      state.lease = null;
      state.leaseUntil = null;
      return (await save()) ? state.step : null;
    }
    await finishBackup(db, env, run, state, save, now);
    return null;
  } catch (error) {
    // Free the claim so the retry can run at once, from the last state
    // saved: the one in memory may be past bytes that were never kept.
    const saved = JSON.parse(raw) as BackupProgress;
    await db
      .update(backupRuns)
      .set({
        progress: JSON.stringify({ ...saved, lease: null, leaseUntil: null }),
      })
      .where(and(eq(backupRuns.id, runId), eq(backupRuns.progress, raw)))
      .catch(() => {});
    throw error;
  }
}

/** The manifest, the run marked done, old backups pruned. */
async function finishBackup(
  db: Db,
  env: CloudflareBindings,
  run: BackupRun,
  state: BackupProgress,
  save: (extra?: Partial<BackupRun>) => Promise<boolean>,
  now: () => number,
): Promise<void> {
  const bucket = runBucket(env, run);
  const finishedAt = Math.floor(now() / 1000);
  let lastMigration: string | null = null;
  try {
    const [row] = await db.all<{ name: string }>(
      sql`SELECT name FROM d1_migrations ORDER BY id DESC LIMIT 1`,
    );
    lastMigration = row?.name ?? null;
  } catch {
    lastMigration = null;
  }
  const manifest: BackupManifest = {
    format: 1,
    app: "saasmail",
    startedAt: run.startedAt,
    finishedAt,
    lastMigration,
    compression: "gzip",
    encryption: state.encrypted ? "aes-256-gcm-frames" : null,
    keyId: state.keyId,
    tables: state.done,
    excluded: [...EXCLUDED_TABLES].sort(),
    r2Prefixes: R2_PREFIXES,
  };
  // Carried bytes a dead step left behind.
  await deletePrefix(bucket, `${run.prefix}.pending/`).catch(() => {});
  const bytes = encoder.encode(`${JSON.stringify(manifest, null, 2)}\n`);
  await bucket.put(`${run.prefix}manifest.json`, bytes, {
    httpMetadata: { contentType: "application/json" },
  });
  await bucket.put(
    `${run.prefix}manifest.sha256`,
    `${await sha256Hex(bytes)}  manifest.json\n`,
  );
  const total =
    state.done.reduce((n, table) => n + table.bytes, 0) + bytes.length;
  state.lease = null;
  state.leaseUntil = null;
  if (!(await save({ status: "completed", finishedAt, bytes: total }))) {
    return;
  }
  await recordAudit(db, {
    action: AUDIT_ACTIONS.backupCompleted,
    targetType: "backup",
    targetId: run.id,
    summary: `Backed up ${state.done.length} tables`,
    details: {
      prefix: run.prefix,
      tables: state.done.length,
      rows: state.done.reduce((n, table) => n + table.rows, 0),
      bytes: total,
      seconds: finishedAt - run.startedAt,
    },
  });
  await pruneBackups(db, env, finishedAt).catch((error) =>
    console.warn("[backup] pruning failed:", error),
  );
}

/** Deletes every object under a prefix. */
async function deletePrefix(bucket: R2Bucket, prefix: string): Promise<void> {
  let cursor: string | undefined;
  do {
    const listed = await bucket.list({ prefix, cursor, limit: 1000 });
    const keys = listed.objects.map((object) => object.key);
    if (keys.length > 0) await bucket.delete(keys);
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);
}

/** Ends a backup that cannot finish: its upload aborted, its files deleted. */
export async function failBackup(
  db: Db,
  env: CloudflareBindings,
  runId: string,
  reason: string,
): Promise<void> {
  const run = await runById(db, runId);
  if (!run || run.status !== "running") return;
  const result = await db
    .update(backupRuns)
    .set({
      status: "failed",
      error: reason.slice(0, 500),
      finishedAt: Math.floor(Date.now() / 1000),
      updatedAt: Math.floor(Date.now() / 1000),
    })
    .where(and(eq(backupRuns.id, runId), eq(backupRuns.status, "running")));
  if (changesOf(result) !== 1) return;
  const bucket = runBucket(env, run);
  const current = backupProgress(run).current;
  if (current) {
    const file = `${run.prefix}${fileName(current.name, backupProgress(run).encrypted)}`;
    await bucket
      .resumeMultipartUpload(file, current.uploadId)
      .abort()
      .catch(() => {});
  }
  await deletePrefix(bucket, run.prefix).catch(() => {});
  await recordAudit(db, {
    action: AUDIT_ACTIONS.backupFailed,
    targetType: "backup",
    targetId: runId,
    summary: "A backup failed",
    details: { reason: reason.slice(0, 500) },
  });
}

/** Queues the step a backup waits for, or runs it here in demo mode. */
export async function resumeBackup(
  db: Db,
  env: CloudflareBindings,
  runId: string,
  step: number,
): Promise<void> {
  if (isDemoMode(env)) {
    await runBackupInline(db, env, runId, step);
    return;
  }
  const message: BackupStepMessage = { type: "backup_step", runId, step };
  await env.EMAIL_QUEUE.send(message);
}

/** Runs a backup's steps one after another (DEMO_MODE has no queue). */
export async function runBackupInline(
  db: Db,
  env: CloudflareBindings,
  runId: string,
  from = 0,
): Promise<void> {
  let step: number | null = from;
  try {
    while (step !== null) {
      step = await runBackupStep(db, env, runId, step);
    }
  } catch (error) {
    console.error(`[backup] ${runId} failed:`, error);
    await failBackup(
      db,
      env,
      runId,
      error instanceof Error ? error.message : "backup failed",
    );
  }
}

/**
 * Deletes the files of backups older than the retention (the rows stay,
 * marked pruned), a few runs per pass. The newest completed backup that
 * still has its files is never deleted, however old: if backups start
 * failing, the last good one stays.
 */
export async function pruneBackups(
  db: Db,
  env: CloudflareBindings,
  nowSeconds: number,
): Promise<number> {
  const { keepDays } = await readBackupSettings(db);
  const [newest] = await db
    .select({ id: backupRuns.id })
    .from(backupRuns)
    .where(and(eq(backupRuns.status, "completed"), isNull(backupRuns.prunedAt)))
    .orderBy(desc(backupRuns.startedAt), sql`rowid DESC`)
    .limit(1);
  const old = await db
    .select()
    .from(backupRuns)
    .where(
      and(
        or(eq(backupRuns.status, "completed"), eq(backupRuns.status, "failed")),
        isNull(backupRuns.prunedAt),
        lt(backupRuns.startedAt, nowSeconds - keepDays * 24 * 60 * 60),
        ...(newest ? [ne(backupRuns.id, newest.id)] : []),
      ),
    )
    .orderBy(backupRuns.startedAt)
    .limit(PRUNE_RUNS);
  for (const run of old) {
    await deletePrefix(runBucket(env, run), run.prefix);
    await db
      .update(backupRuns)
      .set({ prunedAt: nowSeconds })
      .where(eq(backupRuns.id, run.id));
  }
  return old.length;
}

/**
 * Hourly: starts the daily backup when it is due (and turned on), queues a
 * run that stopped moving again once (failing it after a day), and prunes
 * old backups.
 */
export async function runBackupSchedule(
  db: Db,
  env: CloudflareBindings,
  nowSeconds: number,
): Promise<{ started: string | null; resumed: number; failed: number }> {
  let started: string | null = null;
  const settings = await readBackupSettings(db);
  if (settings.enabled && nowSeconds >= nextBackupDue(settings, nowSeconds)) {
    try {
      const run = await startBackup(db, env, null, nowSeconds);
      started = run.id;
      await resumeBackup(db, env, run.id, 0);
    } catch (error) {
      if (!(error instanceof BackupRunningError)) throw error;
    }
  }

  let resumed = 0;
  let failed = 0;
  const idle = await db
    .select()
    .from(backupRuns)
    .where(
      and(
        eq(backupRuns.status, "running"),
        lt(backupRuns.updatedAt, nowSeconds - STUCK_SECONDS),
      ),
    );
  for (const run of idle) {
    const progress = backupProgress(run);
    if (progress.lease && (progress.leaseUntil ?? 0) > nowSeconds * 1000) {
      continue;
    }
    if (run.updatedAt < nowSeconds - DEAD_SECONDS || progress.resumed) {
      if (run.updatedAt < nowSeconds - DEAD_SECONDS) {
        await failBackup(db, env, run.id, "stalled");
        failed++;
      }
      continue;
    }
    const next = JSON.stringify({
      ...progress,
      lease: null,
      leaseUntil: null,
      resumed: true,
    });
    const result = await db
      .update(backupRuns)
      .set({ progress: next, updatedAt: nowSeconds })
      .where(
        and(eq(backupRuns.id, run.id), eq(backupRuns.progress, run.progress)),
      );
    if (changesOf(result) !== 1) continue;
    await resumeBackup(db, env, run.id, progress.step);
    resumed++;
  }
  await pruneBackups(db, env, nowSeconds);
  return { started, resumed, failed };
}
