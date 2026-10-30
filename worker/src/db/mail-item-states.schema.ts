import {
  sqliteTable,
  text,
  integer,
  primaryKey,
} from "drizzle-orm/sqlite-core";
import { users } from "./auth.schema";

/**
 * Per-user correction of the Gmail-style category guess for a sender
 * ("Move to Primary" in Gmail). Keyed by lowercase sender address.
 */
export const categoryOverrides = sqliteTable(
  "category_overrides",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    senderEmail: text("sender_email").notNull(),
    category: text("category").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [primaryKey({ columns: [table.userId, table.senderEmail] })],
);
