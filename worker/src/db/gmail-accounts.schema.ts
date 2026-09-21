import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";

/**
 * One row per connected Google mailbox — not per saasmail inbox. A single
 * "collector" account subscribed to several Google Groups backs several
 * inboxes, because the Gmail API cannot read a Group directly.
 * See docs/superpowers/specs/2026-09-21-gmail-workspace-sync-design.md.
 */
export const gmailAccounts = sqliteTable("gmail_accounts", {
  id: text("id").primaryKey(),
  /** The Gmail mailbox itself, e.g. collector@xyspace.dev. */
  emailAddress: text("email_address").notNull().unique(),
  /** AES-GCM sealed via lib/crypto encryptSecret. Never logged. */
  refreshTokenEncrypted: text("refresh_token_encrypted").notNull(),
  /** Short-lived cache; re-fetched from the refresh token when expired. */
  accessToken: text("access_token"),
  expiresAt: integer("expires_at"),
  /** Gmail history cursor. Seeded from users/me/profile on connect. */
  historyId: text("history_id"),
  lastSyncedAt: integer("last_synced_at"),
  /** Set when sync fails; surfaced as "Reconnect" on the Inboxes page. */
  lastError: text("last_error"),
  connectedBy: text("connected_by"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});
