import { and, eq, sql } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { nanoid } from "nanoid";
import { asyncJobs } from "../db/async-jobs.schema";
import { listMembers } from "../db/list-members.schema";
import { findOrCreateContact } from "./contacts";
import { parseCsv, readCsvHeader } from "./parse-csv";

export interface ListImportMessage {
  type: "list_import";
  jobId: string;
}

/** Upload cap. Bounds both the R2 object and the parse cost. */
export const MAX_IMPORT_BYTES = 10 * 1024 * 1024;
/** Row cap, matching the per-list member cap. */
export const MAX_IMPORT_ROWS = 10_000;
/** Members written per coordinator invocation, bounding D1 work per page. */
export const IMPORT_PAGE_SIZE = 100;
/** Error entries kept on the job row; the count is always exact. */
export const MAX_ERROR_SUMMARY = 50;
/**
 * How long a finished job's R2 objects survive, so a failed or cancelled import
 * can still be inspected before the data goes away.
 */
export const IMPORT_RETENTION_SECONDS = 24 * 3600;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type StagedRow = { row: number; email: string; name: string | null };
export type SkippedRow = { row: number; reason: string };

export function sourceKey(jobId: string) {
  return `imports/${jobId}.csv`;
}
export function stagedKey(jobId: string) {
  return `imports/${jobId}.staged.json`;
}

/**
 * Parse the uploaded CSV once into normalized, de-duplicated rows.
 *
 * Validation and in-file de-duplication happen here rather than per page, so
 * each later page is a straight insert and "first occurrence wins" needs no
 * cross-page state.
 */
export function stageCsv(text: string): {
  rows: StagedRow[];
  skipped: SkippedRow[];
  totalRows: number;
} {
  const parsed = parseCsv(text);
  if (parsed.length === 0) {
    return { rows: [], skipped: [], totalRows: 0 };
  }

  const header = readCsvHeader(parsed[0]);
  if (!header) {
    throw new Error("CSV must have an `email` column");
  }

  const rows: StagedRow[] = [];
  const skipped: SkippedRow[] = [];
  const seen = new Set<string>();

  for (let i = 1; i < parsed.length; i++) {
    // 1-based and counting the header, so the number matches what a
    // spreadsheet shows the operator.
    const rowNumber = i + 1;
    const cells = parsed[i];

    // A trailing blank line is not an error worth reporting.
    if (cells.length === 1 && cells[0].trim() === "") continue;

    const email = (cells[header.email] ?? "").trim().toLowerCase();
    if (!EMAIL_RE.test(email) || email.length > 320) {
      skipped.push({ row: rowNumber, reason: "invalid_email" });
      continue;
    }
    if (seen.has(email)) {
      skipped.push({ row: rowNumber, reason: "duplicate_in_file" });
      continue;
    }
    seen.add(email);

    const rawName =
      header.name === null ? null : (cells[header.name] ?? "").trim();
    rows.push({
      row: rowNumber,
      email,
      name: rawName === "" ? null : rawName,
    });
  }

  return { rows, skipped, totalRows: parsed.length - 1 };
}

async function finish(
  db: DrizzleD1Database<any>,
  jobId: string,
  status: "completed" | "failed",
  extra: Partial<typeof asyncJobs.$inferInsert> = {},
) {
  await db
    .update(asyncJobs)
    .set({ status, updatedAt: Math.floor(Date.now() / 1000), ...extra })
    .where(eq(asyncJobs.id, jobId));
}

/**
 * Process one page of an import job, then re-enqueue itself if more remain.
 *
 * The first invocation stages the R2 object; later ones page through the staged
 * rows by index. Cancellation is checked before every re-enqueue, so a
 * cancelled job stops after at most one more page.
 */
export async function runListImportPage(
  db: DrizzleD1Database<any>,
  env: CloudflareBindings,
  jobId: string,
): Promise<void> {
  const jobs = await db
    .select()
    .from(asyncJobs)
    .where(eq(asyncJobs.id, jobId))
    .limit(1);
  const job = jobs[0];
  if (!job) throw new Error(`Import job ${jobId} not found`);

  // Cancelled or already finished: stop without touching anything.
  if (job.status !== "running") return;

  const now = Math.floor(Date.now() / 1000);

  // --- First invocation: stage ---
  if (job.cursor === null) {
    const object = await env.R2.get(job.storageKey ?? sourceKey(jobId));
    if (!object) {
      await finish(db, jobId, "failed", {
        errorSummary: JSON.stringify([
          { row: 0, reason: "uploaded_file_missing" },
        ]),
      });
      return;
    }

    let staged;
    try {
      staged = stageCsv(await object.text());
    } catch (err) {
      await finish(db, jobId, "failed", {
        errorSummary: JSON.stringify([
          {
            row: 0,
            reason: err instanceof Error ? err.message : "parse_error",
          },
        ]),
      });
      return;
    }

    if (staged.rows.length > MAX_IMPORT_ROWS) {
      await finish(db, jobId, "failed", {
        errorSummary: JSON.stringify([
          { row: 0, reason: `more than ${MAX_IMPORT_ROWS} rows` },
        ]),
      });
      return;
    }

    await env.R2.put(stagedKey(jobId), JSON.stringify(staged.rows));
    await db
      .update(asyncJobs)
      .set({
        cursor: "0",
        totalRows: staged.totalRows,
        skippedCount: staged.skipped.length,
        errorSummary: JSON.stringify(
          staged.skipped.slice(0, MAX_ERROR_SUMMARY),
        ),
        updatedAt: now,
      })
      .where(eq(asyncJobs.id, jobId));
  }

  // --- Page through the staged rows ---
  const stagedObject = await env.R2.get(stagedKey(jobId));
  if (!stagedObject) {
    await finish(db, jobId, "failed", {
      errorSummary: JSON.stringify([{ row: 0, reason: "staged_file_missing" }]),
    });
    return;
  }
  const rows = JSON.parse(await stagedObject.text()) as StagedRow[];

  const fresh = await db
    .select()
    .from(asyncJobs)
    .where(eq(asyncJobs.id, jobId))
    .limit(1);
  const cursor = Number.parseInt(fresh[0]?.cursor ?? "0", 10);
  const page = rows.slice(cursor, cursor + IMPORT_PAGE_SIZE);

  let imported = 0;
  for (const staged of page) {
    const contact = await findOrCreateContact(
      db,
      staged.email,
      staged.name,
      now,
    );

    const existing = await db
      .select({ id: listMembers.id })
      .from(listMembers)
      .where(
        and(
          eq(listMembers.listId, job.refId),
          eq(listMembers.contactId, contact.id),
        ),
      )
      .limit(1);

    if (existing[0]) {
      // Upsert semantics: an existing membership keeps its status — an import
      // must not silently resurrect someone who unsubscribed. The contact's
      // name is filled in by findOrCreateContact when it was previously unknown.
      continue;
    }

    await db
      .insert(listMembers)
      .values({
        id: nanoid(),
        listId: job.refId,
        contactId: contact.id,
        email: contact.email,
        status: "subscribed",
        source: "import",
        formId: null,
        submittedIp: null,
        consentSource: "import",
        consentAt: job.createdAt,
        importJobId: jobId,
        subscribedAt: now,
        confirmedAt: null,
        unsubscribedAt: null,
        unsubscribeReason: null,
        createdAt: now,
      })
      // Concurrent pages or a replayed message must not throw here.
      .onConflictDoNothing();
    imported++;
  }

  const nextCursor = cursor + page.length;
  await db
    .update(asyncJobs)
    .set({
      cursor: String(nextCursor),
      processedRows: nextCursor,
      importedCount: sql`${asyncJobs.importedCount} + ${imported}`,
      updatedAt: Math.floor(Date.now() / 1000),
    })
    .where(eq(asyncJobs.id, jobId));

  if (nextCursor >= rows.length) {
    await finish(db, jobId, "completed");
    return;
  }

  // Re-check cancellation immediately before re-enqueuing: this is the point
  // where a cancel actually takes effect.
  const check = await db
    .select({ status: asyncJobs.status })
    .from(asyncJobs)
    .where(eq(asyncJobs.id, jobId))
    .limit(1);
  if (check[0]?.status !== "running") return;

  const message: ListImportMessage = { type: "list_import", jobId };
  await env.EMAIL_QUEUE.send(message);
}

/**
 * Delete the R2 objects of jobs that finished more than the retention window
 * ago. Called from the hourly cron.
 */
export async function purgeFinishedImports(
  db: DrizzleD1Database<any>,
  env: CloudflareBindings,
  now: number,
): Promise<void> {
  const stale = await db
    .select({ id: asyncJobs.id, storageKey: asyncJobs.storageKey })
    .from(asyncJobs)
    .where(
      and(
        eq(asyncJobs.jobType, "list_import"),
        sql`${asyncJobs.status} != 'running'`,
        sql`${asyncJobs.updatedAt} < ${now - IMPORT_RETENTION_SECONDS}`,
        sql`${asyncJobs.storageKey} IS NOT NULL`,
      ),
    );

  for (const job of stale) {
    await env.R2.delete(job.storageKey!);
    await env.R2.delete(stagedKey(job.id));
    // Null the key so the same job is not swept again on every later tick.
    await db
      .update(asyncJobs)
      .set({ storageKey: null, updatedAt: now })
      .where(eq(asyncJobs.id, job.id));
  }
}
