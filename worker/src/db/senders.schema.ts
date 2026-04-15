import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";

export const senders = sqliteTable("senders", {
  id: text("id").primaryKey(),
  email: text("email").notNull().unique(),
  name: text("name"),
  lastEmailAt: integer("last_email_at").notNull(),
  unreadCount: integer("unread_count").notNull().default(0),
  totalCount: integer("total_count").notNull().default(0),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});
