import {
  sqliteTable,
  text,
  integer,
  primaryKey,
  index,
} from "drizzle-orm/sqlite-core";
import { users } from "./auth.schema";

/**
 * Per-user state for an inbox row: star, pin, archive and snooze.
 *
 * An inbox row is either a person (1-on-1 timeline) or a group conversation,
 * so the key is `(userId, itemType, itemId)` where `itemType` is
 * "person" | "group" and `itemId` is the person id or conversation id.
 *
 * State is per user, like Gmail stars: one teammate archiving a thread does
 * not hide it from the others.
 *
 * Archive and snooze are timestamps, not flags, so new mail brings a row
 * back without a cron job: a row is archived only while
 * `archivedAt >= lastEmailAt`, and snoozed only while `snoozedUntil > now`.
 * All timestamps are unix seconds, matching `emails.received_at`.
 */
export const mailItemStates = sqliteTable(
  "mail_item_states",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    itemType: text("item_type").notNull(),
    itemId: text("item_id").notNull(),
    starred: integer("starred").notNull().default(0),
    pinned: integer("pinned").notNull().default(0),
    archivedAt: integer("archived_at"),
    snoozedUntil: integer("snoozed_until"),
    /** Moved to this user's Trash; like archive, new mail brings it back. */
    trashedAt: integer("trashed_at"),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.itemType, table.itemId] }),
    index("mail_item_states_user_idx").on(table.userId),
  ],
);

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
