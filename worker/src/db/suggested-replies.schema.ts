import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { emails } from "./emails.schema";

export const suggestedReplies = sqliteTable(
  "suggested_replies",
  {
    id: text("id").primaryKey(),
    emailId: text("email_id")
      .notNull()
      .unique()
      .references(() => emails.id, { onDelete: "cascade" }),
    inbox: text("inbox").notNull(),
    bodyText: text("body_text").notNull(),
    model: text("model").notNull(),
    status: text("status", { enum: ["pending", "used", "dismissed"] })
      .notNull()
      .default("pending"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    index("suggested_replies_inbox_status_idx").on(table.inbox, table.status),
  ],
);
