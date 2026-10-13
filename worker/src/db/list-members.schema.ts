import {
  sqliteTable,
  text,
  integer,
  index,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

/**
 * Membership of a contact in a list, plus the consent provenance that makes
 * "why do we have this address?" answerable.
 *
 * Removing a member is a **status change** to `unsubscribed`, never a row
 * delete — deleting would destroy the consent record along with the
 * membership. A genuine hard delete only happens through the explicit,
 * audited erasure endpoint.
 *
 * `email` is denormalized from `contacts` so suppression checks and CSV export
 * do not need a join on the hot path.
 */
export const listMembers = sqliteTable(
  "list_members",
  {
    id: text("id").primaryKey(),
    /** FK lists.id */
    listId: text("list_id").notNull(),
    /** FK contacts.id — never people.id; see contacts.schema.ts. */
    contactId: text("contact_id").notNull(),
    /** Denormalized from contacts.email for fast lookup. */
    email: text("email").notNull(),
    status: text("status", {
      enum: ["pending", "subscribed", "unsubscribed"],
    })
      .notNull()
      .default("pending"),
    source: text("source", { enum: ["form", "api", "import"] }).notNull(),
    /** FK subscribe_forms.id — NULL unless source = 'form'. */
    formId: text("form_id"),
    /** CF-Connecting-IP at submission. Nulled by cron after 30 days. */
    submittedIp: text("submitted_ip"),
    /** Provenance for compliance export; mirrors `source` at capture time. */
    consentSource: text("consent_source", {
      enum: ["form", "api", "import"],
    }).notNull(),
    consentAt: integer("consent_at"),
    /** FK async_jobs.id — set when source = 'import'. */
    importJobId: text("import_job_id"),
    subscribedAt: integer("subscribed_at"),
    /** Double opt-in confirmation timestamp. */
    confirmedAt: integer("confirmed_at"),
    unsubscribedAt: integer("unsubscribed_at"),
    unsubscribeReason: text("unsubscribe_reason"),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("list_members_list_contact_unique").on(
      table.listId,
      table.contactId,
    ),
    // Fan-out pages `WHERE list_id = ? AND status = 'subscribed' AND id > cursor`
    // ordered by id, so the cursor scan is index-covered.
    index("list_members_list_status_id_idx").on(
      table.listId,
      table.status,
      table.id,
    ),
    index("list_members_email_idx").on(table.email),
  ],
);

export type ListMember = typeof listMembers.$inferSelect;
export type NewListMember = typeof listMembers.$inferInsert;
