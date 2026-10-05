import {
  sqliteTable,
  text,
  integer,
  primaryKey,
  index,
} from "drizzle-orm/sqlite-core";
import { mailboxes } from "./mailboxes.schema";

export const messageMailboxes = sqliteTable(
  "message_mailboxes",
  {
    messageKind: text("message_kind").notNull(),
    messageId: text("message_id").notNull(),
    mailboxId: text("mailbox_id")
      .notNull()
      .references(() => mailboxes.id, { onDelete: "cascade" }),
    addedBy: text("added_by"),
    addedAt: integer("added_at").notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.messageKind, table.messageId, table.mailboxId],
    }),
    index("message_mailboxes_mailbox_added_idx").on(
      table.mailboxId,
      table.addedAt,
    ),
  ],
);
