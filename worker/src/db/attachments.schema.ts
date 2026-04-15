import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";

export const attachments = sqliteTable("attachments", {
  id: text("id").primaryKey(),
  emailId: text("email_id").notNull(),
  filename: text("filename").notNull(),
  contentType: text("content_type").notNull(),
  size: integer("size").notNull(),
  r2Key: text("r2_key").notNull(),
  contentId: text("content_id"),
  createdAt: integer("created_at").notNull(),
});
