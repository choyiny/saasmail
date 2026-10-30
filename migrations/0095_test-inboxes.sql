ALTER TABLE `emails` ADD `recipient_detail` text;--> statement-breakpoint
ALTER TABLE `sender_identities` ADD `purpose` text DEFAULT 'mail' NOT NULL;--> statement-breakpoint
ALTER TABLE `sender_identities` ADD `test_retention_days` integer;