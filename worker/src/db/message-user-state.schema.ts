import {
  sqliteTable,
  text,
  integer,
  primaryKey,
  index,
} from "drizzle-orm/sqlite-core";
import { users } from "./auth.schema";

export const messageUserState = sqliteTable(
  "message_user_state",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    messageKind: text("message_kind").notNull(),
    messageId: text("message_id").notNull(),
    seenAt: integer("seen_at"),
    starredAt: integer("starred_at"),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.messageKind, table.messageId] }),
    index("message_user_state_user_starred_idx").on(
      table.userId,
      table.starredAt,
    ),
  ],
);
