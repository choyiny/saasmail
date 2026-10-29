import {
  sqliteTable,
  text,
  integer,
  primaryKey,
} from "drizzle-orm/sqlite-core";
import { users } from "./auth.schema";

/**
 * Rows of the inbox list a user pinned to the top of their Inbox. Personal:
 * one row per user and list row (`item_type` "person" with a person id, or
 * "group" with a conversation id). Archive, trash and snooze are shared per
 * inbox and live in the message state instead (docs/mailbox-state.md).
 */
export const userRowPins = sqliteTable(
  "user_row_pins",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    itemType: text("item_type").notNull(),
    itemId: text("item_id").notNull(),
    pinnedAt: integer("pinned_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.itemType, table.itemId] }),
  ],
);
