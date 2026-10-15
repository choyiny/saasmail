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
  /**
   * When the history cursor was last re-seeded from the present, in unix
   * seconds. Two paths do that: Gmail expiring the cursor (lib/gmail/sync.ts)
   * and reconnecting the mailbox, which replaces the grant and takes a fresh
   * cursor from users/me/profile (routers/admin-gmail-router.ts).
   *
   * Mail that arrived inside the gap was never synced and cannot be recovered
   * from history, so this is a RECORD THAT SOMETHING WAS MISSED, not a
   * current-state flag. A successful sync must never clear it — the gap
   * happened whether or not the mailbox is healthy now. `lastError` carries
   * the same signal transiently and is cleared on the next success, which is
   * exactly why that alone was not enough.
   *
   * Nothing clears this, by any path — not a successful sync, and not
   * reconnecting the account, which stamps a fresh one instead of erasing the
   * old. It is a timestamp, and its AGE is the signal:
   * "last gap: 3 months ago" reads very differently from "last gap: 10
   * minutes ago", and clearing it would destroy that information rather than
   * tidy it. Reconnecting does not un-miss the mail, so it must not erase the
   * evidence either.
   *
   * `GET /api/admin/gmail` exposes it as `lastGapAt` and the mailbox's row on
   * /inboxes renders it as the amber "Sync gap" notice.
   */
  lastGapAt: integer("last_gap_at"),
  /**
   * The one-off import of the last year (lib/gmail/backfill.ts).
   *
   * Pending while `backfillCompletedAt` is null — which is how every new row
   * starts, and what a reconnect resets it to so the import refills the gap
   * the reconnect just made. `backfillUntil` and `backfillSince` pin the
   * window's edges on the first run (null = not started), so paging is stable
   * across ticks; a new window spans BACKFILL_WINDOW_SECONDS. Both are stored
   * rather than derived so a window can be narrower than that — the one-year
   * migration gives mailboxes that already imported three months only the
   * older nine. `backfillPageToken` and `backfillOffset` are where the next
   * run resumes inside the listing.
   */
  backfillUntil: integer("backfill_until"),
  backfillSince: integer("backfill_since"),
  backfillPageToken: text("backfill_page_token"),
  backfillOffset: integer("backfill_offset").notNull().default(0),
  /** Messages the import has handled so far — shown as progress. */
  backfillCount: integer("backfill_count").notNull().default(0),
  backfillCompletedAt: integer("backfill_completed_at"),
  /**
   * The Workflow instance that owns the import (lib/gmail/backfill-job.ts),
   * or null when none has been started. A job only works while this names
   * it, so a reconnect clearing it — or a hand-off to a successor — stops an
   * older one at its next chunk.
   */
  backfillJobId: text("backfill_job_id"),
  connectedBy: text("connected_by"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});
