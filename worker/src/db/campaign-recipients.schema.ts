import {
  sqliteTable,
  text,
  integer,
  index,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

/**
 * Per-recipient delivery ledger — the authoritative record of who was sent
 * what, and the state machine that makes delivery at-least-once with duplicate
 * suppression rather than a racy pre-send check.
 *
 * The claim is a single conditional `UPDATE ... RETURNING`, never a read
 * followed by a write: two duplicate queue deliveries can both pass a
 * read-then-check before either writes.
 *
 * Failure is split deliberately. `retryable_failed` exhausted the outbox's
 * transient retries and an operator may retry it; `permanent_failed` was
 * rejected outright and is never retried, automatically or manually. Collapsing
 * them into one `failed` would either resend to addresses the provider already
 * refused, or strand recoverable ones.
 */
export const campaignRecipients = sqliteTable(
  "campaign_recipients",
  {
    id: text("id").primaryKey(),
    /** FK campaigns.id */
    campaignId: text("campaign_id").notNull(),
    /** FK contacts.id */
    contactId: text("contact_id").notNull(),
    email: text("email").notNull(),
    status: text("status", {
      enum: [
        "queued",
        "processing",
        "sent",
        "suppressed",
        "retrying",
        "retryable_failed",
        "permanent_failed",
        "unknown",
      ],
    })
      .notNull()
      .default("queued"),
    /**
     * Stable `${campaignId}:${contactId}`. Persisted for audit only in v1 — no
     * provider adapter accepts an idempotency parameter, so storing it does not
     * by itself make sends provider-idempotent. Duplicate suppression comes
     * from the atomic claim above.
     */
    idempotencyKey: text("idempotency_key").notNull(),
    /** Set while a send attempt is in flight. FK outbox_emails.id */
    outboxId: text("outbox_id"),
    /** FK sent_emails.id — null until the transport succeeds. */
    sentEmailId: text("sent_email_id"),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    queuedAt: integer("queued_at").notNull(),
    processedAt: integer("processed_at"),
  },
  (table) => [
    uniqueIndex("campaign_recipients_campaign_contact_unique").on(
      table.campaignId,
      table.contactId,
    ),
    // Completion checks and retry scans filter on (campaign, status).
    index("campaign_recipients_campaign_status_idx").on(
      table.campaignId,
      table.status,
    ),
  ],
);

export type CampaignRecipient = typeof campaignRecipients.$inferSelect;
export type NewCampaignRecipient = typeof campaignRecipients.$inferInsert;
