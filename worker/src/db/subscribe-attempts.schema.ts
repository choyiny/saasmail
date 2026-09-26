import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core";

/**
 * An expiring ledger of subscribe attempts, used for rate limiting.
 *
 * This exists because counting `list_members` cannot detect abuse: submission
 * is an upsert, so repeated attempts against an *already pending* membership
 * change no row and are invisible to a membership count. Every attempt is
 * recorded here regardless of whether it changed anything.
 *
 * `emailHash` is SHA-256 of the lowercased address, never the raw address —
 * this is a high-write table populated from a public unauthenticated endpoint,
 * and it would otherwise become a second, less-guarded copy of the subscriber
 * list.
 *
 * Retention is 24 hours, swept by the hourly cron: the ledger only has to
 * answer "how many attempts in the last hour", so nothing needs to outlive the
 * widest rate-limit window plus a margin.
 */
export const subscribeAttempts = sqliteTable(
  "subscribe_attempts",
  {
    id: text("id").primaryKey(),
    /** FK subscribe_forms.id */
    formId: text("form_id").notNull(),
    /** SHA-256 of the lowercased email, hex encoded. */
    emailHash: text("email_hash").notNull(),
    /** CF-Connecting-IP. */
    ip: text("ip").notNull(),
    attemptType: text("attempt_type", {
      enum: ["submission", "confirmation_resend"],
    }).notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    index("subscribe_attempts_form_email_idx").on(
      table.formId,
      table.emailHash,
      table.createdAt,
    ),
    index("subscribe_attempts_ip_idx").on(table.ip, table.createdAt),
    // Supports the hourly retention sweep.
    index("subscribe_attempts_created_idx").on(table.createdAt),
  ],
);

export type SubscribeAttempt = typeof subscribeAttempts.$inferSelect;
export type NewSubscribeAttempt = typeof subscribeAttempts.$inferInsert;
