import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";
import { users } from "./auth.schema";

export const invitations = sqliteTable("invitations", {
  id: text("id").primaryKey(),
  token: text("token").notNull().unique(),
  role: text("role").notNull().default("member"),
  email: text("email"),
  expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
  usedBy: text("used_by"),
  usedAt: integer("used_at", { mode: "timestamp" }),
  createdBy: text("created_by").notNull(),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
});
