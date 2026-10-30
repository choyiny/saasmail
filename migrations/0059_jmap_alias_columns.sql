ALTER TABLE `sent_emails` ADD `jmap_email_id` text;--> statement-breakpoint
ALTER TABLE `sent_emails` ADD `jmap_received_at` integer;--> statement-breakpoint
CREATE UNIQUE INDEX `sent_emails_jmap_email_id_unique` ON `sent_emails` (`jmap_email_id`);--> statement-breakpoint
ALTER TABLE `jmap_changes` ADD `exclude_user_id` text;--> statement-breakpoint
ALTER TABLE `jmap_drafts` ADD `alias_delete` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `jmap_submissions` ADD `from_header` text;