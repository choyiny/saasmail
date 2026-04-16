import { sqliteTable, text, integer, primaryKey, index } from "drizzle-orm/sqlite-core";
import { users } from "./auth.schema";

export const inboxPermissions = sqliteTable(
  "inbox_permissions",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    createdAt: integer("created_at").notNull(),
    createdBy: text("created_by").references(() => users.id, {
      onDelete: "set null",
    }),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.email] }),
    index("inbox_permissions_email_idx").on(table.email),
  ],
);
