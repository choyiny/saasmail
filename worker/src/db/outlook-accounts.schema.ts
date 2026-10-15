import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";

/**
 * A connected Microsoft mailbox (Microsoft 365 or outlook.com), read through
 * Microsoft Graph. The Outlook counterpart of `gmail_accounts`, kept as its
 * own table: the sync cursors are a different shape (one Graph delta link
 * per folder, where Gmail has a single history id).
 */
export const outlookAccounts = sqliteTable("outlook_accounts", {
  id: text("id").primaryKey(),
  /** The mailbox's primary SMTP address, lowercased. */
  emailAddress: text("email_address").notNull().unique(),
  /**
   * Sealed with TOKEN_ENCRYPTION_KEY. Microsoft ROTATES refresh tokens: each
   * refresh can return a new one, which replaces this — keeping the old one
   * would work for a while and then fail.
   */
  refreshTokenEncrypted: text("refresh_token_encrypted").notNull(),
  accessToken: text("access_token"),
  expiresAt: integer("expires_at"),
  /**
   * Where the live sync resumes in each folder: a Graph delta URL (a
   * `@odata.nextLink` mid-round, or the round's `@odata.deltaLink`), plus how
   * many messages of the page it names were already handled. Null until the
   * first sync, which starts from `connectedAt` so only new mail comes in.
   */
  inboxCursor: text("inbox_cursor"),
  inboxCursorOffset: integer("inbox_cursor_offset").notNull().default(0),
  sentCursor: text("sent_cursor"),
  sentCursorOffset: integer("sent_cursor_offset").notNull().default(0),
  /**
   * When the live sync's window starts (unix seconds): the connection, or a
   * reconnect. A first sync — or one whose delta link Graph has expired —
   * asks for mail received since then, so an expired cursor costs nothing.
   */
  syncFrom: integer("sync_from").notNull(),
  lastSyncedAt: integer("last_synced_at"),
  lastError: text("last_error"),
  lastGapAt: integer("last_gap_at"),
  /** The one-year import; same meaning as on `gmail_accounts`. */
  backfillUntil: integer("backfill_until"),
  backfillSince: integer("backfill_since"),
  /** The Graph `@odata.nextLink` to resume the import listing from. */
  backfillLink: text("backfill_link"),
  backfillOffset: integer("backfill_offset").notNull().default(0),
  backfillCount: integer("backfill_count").notNull().default(0),
  backfillCompletedAt: integer("backfill_completed_at"),
  backfillReached: integer("backfill_reached"),
  backfillJobId: text("backfill_job_id"),
  connectedBy: text("connected_by"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});
