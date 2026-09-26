import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core";
import type { BlockDocument } from "../lib/blocks/schema";

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
 * the `*Snapshot` columns are what actually gets sent, so editing the campaign
 * afterwards cannot change mail already in flight.
 *
 * **A campaign owns its content.** `bodyHtml` (and `bodyJson` when the campaign
 * is block-authored) live here, not on a template. A newsletter needs its own
 * words every time, so pointing every campaign at a template made "template"
 * mean "one throwaway per campaign" and stopped it being reusable at all.
 * `templateSlug` is now only a *starting point*: its content is copied in at
 * creation and the reference is provenance, never read when rendering.
 *
 * Templates keep their original job for the transactional and sequence paths,
 * where a template genuinely is the content and carries a `{{variable}}` send
 * contract.
 */
export const campaigns = sqliteTable(
  "campaigns",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    /** Draft-editable; frozen into `subjectSnapshot` on leaving draft. */
    subject: text("subject").notNull(),
    /**
     * The template this campaign was seeded from, if any. Advisory only — the
     * content was copied at creation and is never re-read from here, so
     * editing or deleting that template cannot change this campaign.
     */
    templateSlug: text("template_slug"),
    /** How the operator edits this campaign's body. */
    format: text("format", { enum: ["html", "block"] })
      .notNull()
      .default("html"),
    /** The block document, for `format = 'block'`. Null for HTML campaigns. */
    bodyJson: text("body_json", { mode: "json" }).$type<BlockDocument>(),
    /**
     * The editable body. Compiled from `bodyJson` on write for a block
     * campaign. Frozen into `htmlSnapshot` on leaving draft — this column is
     * what the operator edits, that one is what actually ships.
     */
    bodyHtml: text("body_html").notNull().default(""),
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
     * Provenance string, advisory only and never read when rendering. Now that
     * content lives on the campaign, this records the campaign row it was
     * frozen from rather than a template revision.
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
