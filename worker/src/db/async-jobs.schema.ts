import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core";

/**
 * A durable, resumable job record for work that cannot finish inside one
 * request: CSV import and campaign fan-out.
 *
 * Both are cursor-paged rather than all-in-one — a 10,000-recipient fan-out
 * would blow past D1's per-invocation query budget, and Cloudflare Queues caps
 * `sendBatch()` at 100 messages / 256 KB. Each coordinator invocation handles
 * one bounded page, advances `cursor`, and re-enqueues itself.
 *
 * Named domain-neutrally (not `campaign_jobs`) because `list_members.import_job_id`
 * references it, and the list-import migration necessarily lands before the
 * campaigns one.
 */
export const asyncJobs = sqliteTable(
  "async_jobs",
  {
    id: text("id").primaryKey(),
    jobType: text("job_type", {
      enum: ["campaign_fan_out", "list_import"],
    }).notNull(),
    /** FK lists.id for list_import, campaigns.id for campaign_fan_out. */
    refId: text("ref_id").notNull(),
    status: text("status", {
      enum: ["running", "completed", "failed", "cancelled"],
    })
      .notNull()
      .default("running"),
    /**
     * Resume point. For campaign_fan_out this is the last processed
     * `list_members.id`. For list_import it is a *staged-row* cursor, never a
     * raw byte offset — a byte offset cannot be resumed safely across a
     * multiline RFC 4180 field without persisting parser state.
     */
    cursor: text("cursor"),
    /** list_import only: R2 object key on the existing `R2` binding. */
    storageKey: text("storage_key"),
    /** list_import only: total rows, for progress reporting. */
    totalRows: integer("total_rows"),
    processedRows: integer("processed_rows").notNull().default(0),
    importedCount: integer("imported_count").notNull().default(0),
    skippedCount: integer("skipped_count").notNull().default(0),
    /** JSON array of {row, reason}, capped at the first 50 entries. */
    errorSummary: text("error_summary"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    index("async_jobs_ref_idx").on(table.jobType, table.refId),
    index("async_jobs_status_idx").on(table.status),
  ],
);

export type AsyncJob = typeof asyncJobs.$inferSelect;
export type NewAsyncJob = typeof asyncJobs.$inferInsert;
