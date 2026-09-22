import {
  sqliteTable,
  text,
  integer,
  primaryKey,
  index,
} from "drizzle-orm/sqlite-core";
import { users } from "./auth.schema";

export const inboxConversationState = sqliteTable(
  "inbox_conversation_state",
  {
    inbox: text("inbox").notNull(),
    conversationKey: text("conversation_key").notNull(),
    snoozedUntil: integer("snoozed_until"),
    snoozedBy: text("snoozed_by").references(() => users.id, {
      onDelete: "set null",
    }),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.inbox, table.conversationKey] }),
    index("inbox_conversation_state_inbox_snoozed_idx").on(
      table.inbox,
      table.snoozedUntil,
    ),
  ],
);
