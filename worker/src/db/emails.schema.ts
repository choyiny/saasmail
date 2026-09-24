import {
  sqliteTable,
  text,
  integer,
  real,
  index,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const emails = sqliteTable(
  "emails",
  {
    id: text("id").primaryKey(),
    personId: text("person_id").notNull(),
    recipient: text("recipient").notNull(),
    subject: text("subject"),
    bodyHtml: text("body_html"),
    bodyText: text("body_text"),
    rawHeaders: text("raw_headers"),
    messageId: text("message_id"),
    spf: text("spf"),
    dkim: text("dkim"),
    dmarc: text("dmarc"),
    spamScore: real("spam_score"),
    isRead: integer("is_read").notNull().default(0),
    /**
     * JSON-encoded array of {"email","name"} objects for additional
     * recipients on the inbound CC line. NULL = no CC. Stored as TEXT
     * so we can keep the schema flat — see migration 0021 for rationale.
     */
    cc: text("cc"),
    /**
     * Group-thread identity. When 2+ external participants are in this
     * email's thread, this column is set to a deterministic hash of
     * (inbox, sorted-external-emails). NULL means a 1-on-1 thread — the
     * inbox list falls back to per-person grouping in that case.
     * See migration 0022.
     */
    conversationId: text("conversation_id"),
    /** Gmail's own message id. Null for Cloudflare-routed mail. */
    gmailMessageId: text("gmail_message_id"),
    /** Gmail's thread id, kept for reply threading in a later slice. */
    gmailThreadId: text("gmail_thread_id"),
    receivedAt: integer("received_at").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    index("emails_person_received_idx").on(table.personId, table.receivedAt),
    index("emails_recipient_received_idx").on(
      table.recipient,
      table.receivedAt,
    ),
    index("emails_conversation_idx").on(table.conversationId),
    /**
     * The inbound dedupe key, and the reason it is a PAIR.
     *
     * A global UNIQUE on `message_id` used to hold it. That is correct for
     * one delivery path, and silently lossy for two: when a sender puts two
     * of our inboxes on one To: line, both copies carry the same Message-ID,
     * and the second inbox's copy was refused by the constraint. With Gmail
     * sync that refusal became permanent — the sync counted the drop as an
     * ingest and advanced its cursor past mail that never landed anywhere.
     *
     * One message to two inboxes is two deliveries. Scoping the key to
     * `(message_id, recipient)` keeps the real duplicate — the same message
     * offered twice to the SAME inbox, which is what a retry or an overlapping
     * cron tick produces — a no-op, while letting the second inbox receive.
     *
     * SQLite treats NULLs as distinct in a unique index, so mail with no
     * Message-ID at all is unconstrained here exactly as it was before.
     */
    uniqueIndex("emails_message_recipient_unique").on(
      table.messageId,
      table.recipient,
    ),
  ],
);
