import {
  sqliteTable,
  text,
  integer,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { users } from "./auth.schema";

/**
 * Autosaved compose drafts, scoped per user.
 *
 * A draft is identified by `(userId, contextKey)` so there is exactly one
 * autosaved draft per composing surface:
 *   - `"compose"`         — the new-message composer (one per user)
 *   - `"reply:<emailId>"` — a reply to a specific email
 *
 * The unique index enforces that identity and lets the router upsert with a
 * single `onConflictDoUpdate`. Attachments are intentionally not persisted —
 * they're in-browser File objects re-added when a draft is resumed.
 */
export const drafts = sqliteTable(
  "drafts",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    contextKey: text("context_key").notNull(),
    fromAddress: text("from_address"),
    toAddress: text("to_address"),
    /** JSON-encoded array of { email, name? }. */
    cc: text("cc"),
    subject: text("subject"),
    bodyHtml: text("body_html"),
    bodyText: text("body_text"),
    /** The email being replied to, or null for a new-message draft. */
    replyToEmailId: text("reply_to_email_id"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("drafts_user_context_idx").on(table.userId, table.contextKey),
  ],
);
