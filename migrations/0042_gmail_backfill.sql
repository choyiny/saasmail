ALTER TABLE `gmail_accounts` ADD `backfill_until` integer;--> statement-breakpoint
ALTER TABLE `gmail_accounts` ADD `backfill_page_token` text;--> statement-breakpoint
ALTER TABLE `gmail_accounts` ADD `backfill_offset` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `gmail_accounts` ADD `backfill_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `gmail_accounts` ADD `backfill_completed_at` integer;