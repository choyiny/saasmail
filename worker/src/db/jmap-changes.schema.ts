import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const jmapChanges = sqliteTable(
  "jmap_changes",
  {
    seq: integer("seq").primaryKey({ autoIncrement: true }),
    objectType: text("object_type").notNull(),
    objectId: text("object_id").notNull(),
    inbox: text("inbox"),
    userId: text("user_id"),
    op: text("op").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    index("jmap_changes_inbox_user_seq_idx").on(
      table.inbox,
      table.userId,
      table.seq,
    ),
    index("jmap_changes_user_seq_idx").on(table.userId, table.seq),
    index("jmap_changes_created_at_idx").on(table.createdAt),
  ],
);
