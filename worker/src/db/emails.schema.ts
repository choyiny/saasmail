import {
  sqliteTable,
  text,
  integer,
  real,
  index,
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
    messageId: text("message_id").unique(),
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
  ],
);
