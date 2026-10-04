import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * One database backup: a logical dump of D1 into the backup bucket, one
 * gzipped NDJSON file per table and a manifest, written in resumable steps
 * on the queue. Rows stay after their files are pruned, for the history.
 */
export const backupRuns = sqliteTable(
  "backup_runs",
  {
    id: text("id").primaryKey(),
    startedAt: integer("started_at").notNull(),
    finishedAt: integer("finished_at"),
    status: text("status", {
      enum: ["running", "completed", "failed"],
    }).notNull(),
    /** Where its files are in the bucket: `backups/<stamp>-<id>/`. */
    prefix: text("prefix").notNull(),
    /** JSON: the step it waits for, the table it is on, the tables done. */
    progress: text("progress").notNull(),
    /** Bytes written. */
    bytes: integer("bytes").notNull().default(0),
    error: text("error"),
    /** Who pressed "Back up now"; null for the schedule. */
    requestedBy: text("requested_by"),
    /** When its files were deleted by retention. */
    prunedAt: integer("pruned_at"),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [index("backup_runs_started_idx").on(table.startedAt)],
);

export type BackupRun = typeof backupRuns.$inferSelect;
