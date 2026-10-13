import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core";

/**
 * A subscriber list. Scoped to a sender identity via `fromAddress`, which is
 * also the inbox-permission key used to authorize member-level access.
 *
 * Lists are archived rather than deleted once they have campaign history:
 * a delivered campaign's audit trail references the list, so removing the row
 * would strand it. `DELETE /api/lists/:id` hard-deletes only when no campaign
 * has ever targeted the list. Archiving is one-way in v1.
 */
export const lists = sqliteTable(
  "lists",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    description: text("description"),
    /** Bare lowercase inbox address — FK sender_identities.from_address. */
    fromAddress: text("from_address").notNull(),
    doubleOptIn: integer("double_opt_in").notNull().default(0),
    /** Optional email_templates.slug for the opt-in confirmation mail. */
    confirmationTemplateSlug: text("confirmation_template_slug"),
    /** Set instead of deleting once the list has campaign history. */
    archivedAt: integer("archived_at"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    index("lists_from_address_idx").on(table.fromAddress),
    index("lists_archived_at_idx").on(table.archivedAt),
  ],
);

export type List = typeof lists.$inferSelect;
export type NewList = typeof lists.$inferInsert;
