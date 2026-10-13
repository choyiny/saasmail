import {
  sqliteTable,
  text,
  integer,
  uniqueIndex,
  type AnySQLiteColumn,
} from "drizzle-orm/sqlite-core";

export const mailboxes = sqliteTable(
  "mailboxes",
  {
    id: text("id").primaryKey(),
    inbox: text("inbox").notNull(),
    name: text("name").notNull(),
    role: text("role"),
    parentId: text("parent_id").references(
      (): AnySQLiteColumn => mailboxes.id,
      { onDelete: "cascade" },
    ),
    sortOrder: integer("sort_order").notNull().default(0),
    createdBy: text("created_by"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("mailboxes_inbox_parent_name_unique").on(
      table.inbox,
      table.parentId,
      table.name,
    ),
  ],
);
