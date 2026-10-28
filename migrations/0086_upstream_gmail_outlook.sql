CREATE TABLE `outlook_accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`email_address` text NOT NULL,
	`refresh_token_encrypted` text NOT NULL,
	`access_token` text,
	`expires_at` integer,
	`inbox_cursor` text,
	`inbox_cursor_offset` integer DEFAULT 0 NOT NULL,
	`sent_cursor` text,
	`sent_cursor_offset` integer DEFAULT 0 NOT NULL,
	`sync_from` integer NOT NULL,
	`last_synced_at` integer,
	`last_error` text,
	`last_gap_at` integer,
	`backfill_until` integer,
	`backfill_since` integer,
	`backfill_link` text,
	`backfill_offset` integer DEFAULT 0 NOT NULL,
	`backfill_count` integer DEFAULT 0 NOT NULL,
	`backfill_completed_at` integer,
	`backfill_reached` integer,
	`backfill_job_id` text,
	`connected_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `outlook_accounts_email_address_unique` ON `outlook_accounts` (`email_address`);--> statement-breakpoint
CREATE TABLE `install_state` (
	`installation_id` text PRIMARY KEY NOT NULL,
	`ownership_nonce` text NOT NULL,
	`version` text,
	`manifest_json` text,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `emails` ADD `gmail_message_id` text;--> statement-breakpoint
ALTER TABLE `emails` ADD `gmail_thread_id` text;--> statement-breakpoint
ALTER TABLE `emails` ADD `outlook_message_id` text;--> statement-breakpoint
ALTER TABLE `sent_emails` ADD `gmail_message_id` text;--> statement-breakpoint
ALTER TABLE `sent_emails` ADD `gmail_thread_id` text;--> statement-breakpoint
ALTER TABLE `sent_emails` ADD `outlook_message_id` text;--> statement-breakpoint
CREATE UNIQUE INDEX `sent_emails_gmail_message_from_unique` ON `sent_emails` (`gmail_message_id`,`from_address`);--> statement-breakpoint
CREATE UNIQUE INDEX `sent_emails_outlook_message_from_unique` ON `sent_emails` (`outlook_message_id`,`from_address`);--> statement-breakpoint
ALTER TABLE `sender_identities` ADD `source` text DEFAULT 'cloudflare' NOT NULL;--> statement-breakpoint
ALTER TABLE `sender_identities` ADD `gmail_account_id` text;--> statement-breakpoint
ALTER TABLE `sender_identities` ADD `gmail_group_address` text;--> statement-breakpoint
ALTER TABLE `sender_identities` ADD `outlook_account_id` text;--> statement-breakpoint
ALTER TABLE `gmail_accounts` ADD `last_gap_at` integer;--> statement-breakpoint
ALTER TABLE `gmail_accounts` ADD `backfill_until` integer;--> statement-breakpoint
ALTER TABLE `gmail_accounts` ADD `backfill_since` integer;--> statement-breakpoint
ALTER TABLE `gmail_accounts` ADD `backfill_page_token` text;--> statement-breakpoint
ALTER TABLE `gmail_accounts` ADD `backfill_offset` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `gmail_accounts` ADD `backfill_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `gmail_accounts` ADD `backfill_completed_at` integer;--> statement-breakpoint
ALTER TABLE `gmail_accounts` ADD `backfill_reached` integer;--> statement-breakpoint
ALTER TABLE `gmail_accounts` ADD `backfill_job_id` text;