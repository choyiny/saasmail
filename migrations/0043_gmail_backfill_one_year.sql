ALTER TABLE `gmail_accounts` ADD `backfill_since` integer;--> statement-breakpoint
-- The import now reaches back a year instead of 90 days. Order matters: the
-- second statement clears `backfill_completed_at`, so it must run last or the
-- first would match its rows too.
-- One still part-way through restarts over the whole year from its pinned end.
-- Its page token belongs to the old query, so it cannot resume; what it already
-- imported is re-listed and deduped, and the count restarts so it stays true.
UPDATE `gmail_accounts` SET
  `backfill_since` = `backfill_until` - 31536000,
  `backfill_page_token` = NULL,
  `backfill_offset` = 0,
  `backfill_count` = 0
WHERE `backfill_completed_at` IS NULL AND `backfill_until` IS NOT NULL;--> statement-breakpoint
-- A mailbox that already finished its three months imports only the older
-- nine: the new window ends where the old one began.
UPDATE `gmail_accounts` SET
  `backfill_since` = `backfill_until` - 31536000,
  `backfill_until` = `backfill_until` - 7776000,
  `backfill_page_token` = NULL,
  `backfill_offset` = 0,
  `backfill_completed_at` = NULL
WHERE `backfill_completed_at` IS NOT NULL AND `backfill_until` IS NOT NULL;
