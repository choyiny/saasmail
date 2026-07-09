import {
  sqliteTable,
  text,
  integer,
  unique,
  index,
} from "drizzle-orm/sqlite-core";

export const blocklist = sqliteTable(
  "blocklist",
  {
    id: text("id").primaryKey(),
    // "email" blocks a single address; "domain" blocks every address at a domain.
    type: text("type", { enum: ["email", "domain"] }).notNull(),
    // Lowercased + trimmed. For "domain" this is the bare domain (e.g. "spammer.com").
    value: text("value").notNull(),
    note: text("note"),
    createdBy: text("created_by"),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    unique("blocklist_type_value_unique").on(table.type, table.value),
    index("blocklist_created_at_idx").on(table.createdAt),
  ],
);

export type BlockRule = typeof blocklist.$inferSelect;
export type NewBlockRule = typeof blocklist.$inferInsert;
