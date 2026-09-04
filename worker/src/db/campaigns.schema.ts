import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core";

/**
 * A broadcast campaign.
 *
 * **Stats are not the source of truth.** Only `statsTargeted` is written once
 * and trusted; every other `stats*` column is an advisory cache refreshed by
 * the hourly rollup or computed live on read. Completion is decided from
 * `campaign_recipients` terminal states, never from counters reaching equality
 * — a counter race would either strand a finished campaign in `sending` or
 * declare it done early.
 *
 * **Content is snapshotted, not referenced.** Once a campaign leaves `draft`
 * the `*Snapshot` columns are what actually gets sent, so editing or deleting
 * the source template afterwards cannot change mail already in flight.
 */
export const campaigns = sqliteTable(
  "campaigns",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    /** Draft-editable; frozen into `subjectSnapshot` on leaving draft. */
    subject: text("subject").notNull(),
    /** Source template reference, only consulted while status = 'draft'. */
    templateSlug: text("template_slug").notNull(),
    fromAddress: text("from_address").notNull(),
    /** FK lists.id */
    listId: text("list_id").notNull(),
    status: text("status", {
      enum: [
        "draft",
        "scheduled",
        "overdue",
        "preparing",
        "sending",
        "sent",
        "completed_with_failures",
        "cancelled",
        "stalled",
      ],
    })
      .notNull()
      .default("draft"),
    /** Unix epoch; null means send immediately when triggered. */
    scheduledAt: integer("scheduled_at"),

    // --- content snapshot: written once, when status leaves 'draft' ---
    contentSnapshotAt: integer("content_snapshot_at"),
    subjectSnapshot: text("subject_snapshot"),
    /** Rendered base HTML, before per-recipient variables and tracking. */
    htmlSnapshot: text("html_snapshot"),
    /** Optional admin-authored plain text; null means derive from the HTML. */
    textBodyOverride: text("text_body_override"),
    /** Frozen text/plain part. Override if set, else htmlToText of the HTML. */
    textSnapshot: text("text_snapshot"),
    fromAddressSnapshot: text("from_address_snapshot"),
    /**
     * Provenance string `"{templateId}@{updatedAt}"`, not an FK —
     * `email_templates` has no revision history. Advisory only; never read
     * when rendering.
     */
    templateRevision: text("template_revision"),
    /**
     * Which generation of the token-domain key signed this campaign's v2
     * unsubscribe links, so a future key rotation can still verify tokens
     * already sitting in delivered mail.
     */
    unsubscribeDomainKeyVersion: integer("unsubscribe_domain_key_version")
      .notNull()
      .default(1),

    // --- resumable fan-out ---
    /** Last processed list_members.id; null before fan-out starts. */
    fanOutCursor: text("fan_out_cursor"),
    /** FK async_jobs.id */
    fanOutJobId: text("fan_out_job_id"),

    sentAt: integer("sent_at"),

    /** Authoritative: set once at fan-out start. */
    statsTargeted: integer("stats_targeted").notNull().default(0),
    // Everything below is an advisory cache — never read for a correctness
    // decision. See the note above.
    statsDelivered: integer("stats_delivered").notNull().default(0),
    statsSuppressed: integer("stats_suppressed").notNull().default(0),
    statsRetryableFailed: integer("stats_retryable_failed")
      .notNull()
      .default(0),
    statsPermanentFailed: integer("stats_permanent_failed")
      .notNull()
      .default(0),
    statsUniqueOpeners: integer("stats_unique_openers").notNull().default(0),
    statsUniqueClicks: integer("stats_unique_clicks").notNull().default(0),
    statsUnsubscribes: integer("stats_unsubscribes").notNull().default(0),

    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    index("campaigns_list_idx").on(table.listId),
    index("campaigns_from_address_idx").on(table.fromAddress),
    // The hourly pass scans by status and schedule.
    index("campaigns_status_scheduled_idx").on(table.status, table.scheduledAt),
  ],
);

export type Campaign = typeof campaigns.$inferSelect;
export type NewCampaign = typeof campaigns.$inferInsert;
