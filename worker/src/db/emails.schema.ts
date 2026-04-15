import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core";

export const emails = sqliteTable(
  "emails",
  {
    id: text("id").primaryKey(),
    senderId: text("sender_id").notNull(),
    recipient: text("recipient").notNull(),
    subject: text("subject"),
    bodyHtml: text("body_html"),
    bodyText: text("body_text"),
    rawHeaders: text("raw_headers"),
    messageId: text("message_id").unique(),
    isRead: integer("is_read").notNull().default(0),
    receivedAt: integer("received_at").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    index("emails_sender_received_idx").on(table.senderId, table.receivedAt),
    index("emails_recipient_received_idx").on(
      table.recipient,
      table.receivedAt,
    ),
  ],
);
