import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core";

export const sentEmails = sqliteTable(
  "sent_emails",
  {
    id: text("id").primaryKey(),
    senderId: text("sender_id"),
    fromAddress: text("from_address").notNull(),
    toAddress: text("to_address").notNull(),
    subject: text("subject").notNull(),
    bodyHtml: text("body_html"),
    bodyText: text("body_text"),
    inReplyTo: text("in_reply_to"),
    resendId: text("resend_id"),
    status: text("status").notNull().default("sent"),
    sentAt: integer("sent_at").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    index("sent_emails_sender_sent_idx").on(table.senderId, table.sentAt),
  ]
);
