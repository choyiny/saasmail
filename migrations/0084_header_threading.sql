ALTER TABLE `emails` ADD `thread_key` text;--> statement-breakpoint
CREATE INDEX `emails_thread_key_idx` ON `emails` (`thread_key`);--> statement-breakpoint
ALTER TABLE `sent_emails` ADD `thread_key` text;--> statement-breakpoint
CREATE INDEX `sent_emails_thread_key_idx` ON `sent_emails` (`thread_key`);--> statement-breakpoint
ALTER TABLE `sender_identities` ADD `threading_mode` text DEFAULT 'relationship' NOT NULL;