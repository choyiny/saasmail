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
    /**
     * Gmail's id for the message it created when we sent this. Null for
     * Cloudflare-sent mail. This is the echo-suppression key: a later
     * slice mirrors `SENT` messages from Gmail onto the timeline, and
     * without this id every reply we send through Gmail would come back
     * through that mirror and appear twice. Gmail owns this identifier,
     * not us, so it is NOT unique here — a duplicate API response must
     * be a no-op, not a hard failure.
     */
    gmailMessageId: text("gmail_message_id"),
    /**
     * Gmail's thread id for this message. Setting it on send is what
     * makes a reply thread inside Gmail instead of starting a new
     * conversation. It repeats by design: every message in a thread
     * shares the same id, so it is NOT unique here.
     */
    gmailThreadId: text("gmail_thread_id"),
    sentAt: integer("sent_at").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    index("sent_emails_person_sent_idx").on(table.personId, table.sentAt),
    index("sent_emails_conversation_idx").on(table.conversationId),
    index("sent_emails_from_sent_idx").on(table.fromAddress, table.sentAt),
  ],
);
