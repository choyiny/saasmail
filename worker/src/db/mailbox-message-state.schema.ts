import {
  sqliteTable,
  text,
  integer,
  primaryKey,
  index,
} from "drizzle-orm/sqlite-core";
import { users } from "./auth.schema";

export const mailboxMessageState = sqliteTable(
  "mailbox_message_state",
  {
    inbox: text("inbox").notNull(),
    messageKind: text("message_kind").notNull(),
    messageId: text("message_id").notNull(),
    archivedAt: integer("archived_at"),
    spamAt: integer("spam_at"),
    trashedAt: integer("trashed_at"),
    updatedBy: text("updated_by").references(() => users.id, {
      onDelete: "set null",
    }),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.messageKind, table.messageId] }),
    index("mailbox_message_state_inbox_trashed_idx").on(
      table.inbox,
      table.trashedAt,
    ),
    index("mailbox_message_state_inbox_spam_idx").on(table.inbox, table.spamAt),
    index("mailbox_message_state_inbox_archived_idx").on(
      table.inbox,
      table.archivedAt,
    ),
  ],
);
