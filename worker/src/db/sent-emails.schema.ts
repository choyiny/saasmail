import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core";

export const sentEmails = sqliteTable(
  "sent_emails",
  {
    id: text("id").primaryKey(),
    personId: text("person_id"),
    fromAddress: text("from_address").notNull(),
    toAddress: text("to_address").notNull(),
    subject: text("subject").notNull(),
    bodyHtml: text("body_html"),
    bodyText: text("body_text"),
    inReplyTo: text("in_reply_to"),
    messageId: text("message_id"),
    resendId: text("resend_id"),
    status: text("status").notNull().default("sent"),
    /**
     * JSON-encoded array of {"email","name"} objects for outbound CC
     * recipients. NULL = no CC. Mirrors the `cc` column on `emails`.
     */
    cc: text("cc"),
    /**
     * Group-thread identity. Mirrors `emails.conversation_id`. See
     * migration 0022 for the algorithm + rationale.
     */
    conversationId: text("conversation_id"),
    sentAt: integer("sent_at").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    index("sent_emails_person_sent_idx").on(table.personId, table.sentAt),
    index("sent_emails_conversation_idx").on(table.conversationId),
    index("sent_emails_from_sent_idx").on(table.fromAddress, table.sentAt),
  ],
);
