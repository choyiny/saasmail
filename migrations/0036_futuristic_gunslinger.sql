ALTER TABLE `emails` ADD `gmail_message_id` text;--> statement-breakpoint
ALTER TABLE `emails` ADD `gmail_thread_id` text;--> statement-breakpoint
ALTER TABLE `sender_identities` ADD `source` text DEFAULT 'cloudflare' NOT NULL;--> statement-breakpoint
ALTER TABLE `sender_identities` ADD `gmail_account_id` text;--> statement-breakpoint
ALTER TABLE `sender_identities` ADD `gmail_group_address` text;