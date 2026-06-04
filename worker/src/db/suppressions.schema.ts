import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";

export const suppressions = sqliteTable("suppressions", {
  id: text("id").primaryKey(),
  email: text("email").notNull().unique(),
  reason: text("reason", { enum: ["unsubscribe", "manual"] }).notNull(),
  source: text("source"),
  note: text("note"),
  createdAt: integer("created_at").notNull(),
});

export type Suppression = typeof suppressions.$inferSelect;
export type NewSuppression = typeof suppressions.$inferInsert;
