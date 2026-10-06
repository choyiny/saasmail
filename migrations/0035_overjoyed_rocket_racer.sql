CREATE TABLE `gmail_accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`email_address` text NOT NULL,
	`refresh_token_encrypted` text NOT NULL,
	`access_token` text,
	`expires_at` integer,
	`history_id` text,
	`last_synced_at` integer,
	`last_error` text,
	`connected_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `gmail_accounts_email_address_unique` ON `gmail_accounts` (`email_address`);