import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core";

/**
 * An embeddable signup form bound to one list.
 *
 * `allowedOrigins` fails **closed**: when it is set, a request whose `Origin`
 * does not match — including a request with no `Origin` header at all — is
 * rejected. Treating a missing header as "allow" would make the control
 * trivially bypassable by any non-browser client. When it is NULL, any origin
 * is accepted, which is what makes non-browser API submission work.
 */
export const subscribeForms = sqliteTable(
  "subscribe_forms",
  {
    id: text("id").primaryKey(),
    /** FK lists.id */
    listId: text("list_id").notNull(),
    name: text("name").notNull(),
    showNameField: integer("show_name_field").notNull().default(1),
    nameRequired: integer("name_required").notNull().default(0),
    successMessage: text("success_message")
      .notNull()
      .default("Thanks for subscribing!"),
    redirectUrl: text("redirect_url"),
    /** Comma-separated origins. NULL = any origin allowed. */
    allowedOrigins: text("allowed_origins"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [index("subscribe_forms_list_idx").on(table.listId)],
);

export type SubscribeForm = typeof subscribeForms.$inferSelect;
export type NewSubscribeForm = typeof subscribeForms.$inferInsert;
