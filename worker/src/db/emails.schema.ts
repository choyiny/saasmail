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
    /**
     * The raw `In-Reply-To` and `References` header values, as received
     * (one or more `<id>`s). JMAP exposes them as `inReplyTo`/`references`.
     * Rows from before migration 0063 were backfilled from `raw_headers`.
     */
    inReplyTo: text("in_reply_to"),
    referencesHeader: text("references_header"),
    /**
     * The message exactly as received (RFC 5322 bytes) in R2, and its size in
     * octets: JMAP's `blobId` and `size`. Kept for the life of the row. NULL
     * for mail received before migration 0068, or if the R2 write failed.
     */
    rawR2Key: text("raw_r2_key"),
    rawSize: integer("raw_size"),
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
     * JSON-encoded array of {"email","name"} objects from the inbound
     * Reply-To header, the `cc` convention. NULL when the header is absent
     * or empty, and for rows from before migration 0074, which readers
     * resolve from `raw_headers` instead (see `replyToOf`).
     */
    replyTo: text("reply_to"),
    /**
     * Group-thread identity. When 2+ external participants are in this
     * email's thread, this column is set to a deterministic hash of
     * (inbox, sorted-external-emails). NULL means a 1-on-1 thread — the
     * inbox list falls back to per-person grouping in that case.
     * See migration 0022.
     */
    conversationId: text("conversation_id"),
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
    // One row per Message-ID per inbox: a message addressed to two inboxes is
    // stored in both, and a redelivery to the same inbox is dropped.
    uniqueIndex("emails_message_id_recipient_unique").on(
      table.messageId,
      table.recipient,
    ),
  ],
);
