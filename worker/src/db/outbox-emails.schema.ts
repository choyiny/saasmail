import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core";

/**
 * Write-ahead outbox for outbound sends (issue #151). A row is inserted
 * right before every provider call and deleted on success — `sent_emails`
 * is the permanent history; this table only holds sends that are still
 * being retried (`pending`) or that terminally failed (`failed`, kept so
 * the Outbox tab can show them and offer a manual retry).
 */
export const outboxEmails = sqliteTable(
  "outbox_emails",
  {
    id: text("id").primaryKey(),
    /**
     * Pre-generated id shared with the sent_emails row the caller writes.
     * Lets the retry processor flip that row's status and reload its
     * attachments.
     */
    sentEmailId: text("sent_email_id").notNull(),
    /** Set for sequence-step sends so retries can resolve the step too. */
    sequenceEmailId: text("sequence_email_id"),
    /** Bare lowercase inbox address — the inbox-scoping key. */
    fromAddress: text("from_address").notNull(),
    toAddress: text("to_address").notNull(),
    /** JSON [{email,name}] — same shape as sent_emails.cc. NULL = no CC. */
    cc: text("cc"),
    subject: text("subject").notNull(),
    /**
     * Pre-render input, not the wire payload: retries re-run
     * sendWithSuppressionCheck, which re-checks suppression and re-renders
     * unsubscribe footers.
     */
    bodyHtml: text("body_html"),
    bodyText: text("body_text"),
    /** JSON object. Includes the original Message-ID so every retry reuses it. */
    headers: text("headers"),
    transactional: integer("transactional").notNull().default(0),
    /** pending (awaiting retry) | failed (terminal, kept for the tab). */
    status: text("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    /** Unix seconds; the processor picks up pending rows with next_retry_at <= now. */
    nextRetryAt: integer("next_retry_at"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    index("outbox_status_retry_idx").on(table.status, table.nextRetryAt),
    index("outbox_from_idx").on(table.fromAddress),
  ],
);
