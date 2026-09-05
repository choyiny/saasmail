import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core";

/**
 * Newsletter subscriber identity, deliberately separate from `people`.
 *
 * `people` is the inbox/CRM correspondent: it requires `last_email_at` and
 * drives the conversation and contact views. Bulk-importing thousands of
 * subscribers into `people` would bury real correspondents in a list ordered
 * by `people_last_email_at_idx`, so subscribers live here instead.
 *
 * `personId` is a *cache* of the link, never a creation trigger. Import, form
 * submission and confirmation all leave it NULL. A campaign send fills it in
 * only when a `people` row for that address already exists (see
 * `lib/find-person.ts`) — the campaign path never inserts into `people`.
 * Subscribers who later become real correspondents (they email in, or get
 * transactional mail) are picked up by the hourly backfill, which is what
 * `contacts_person_id_idx` supports.
 */
export const contacts = sqliteTable(
  "contacts",
  {
    id: text("id").primaryKey(),
    email: text("email").notNull().unique(),
    name: text("name"),
    /** FK people.id. NULL until that address is a real correspondent. */
    personId: text("person_id"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [index("contacts_person_id_idx").on(table.personId)],
);

export type Contact = typeof contacts.$inferSelect;
export type NewContact = typeof contacts.$inferInsert;
