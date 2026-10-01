ALTER TABLE `sent_emails` ADD `alias_restore` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `jmap_submissions` ADD `released_at` integer;--> statement-breakpoint
ALTER TABLE `jmap_submissions` ADD `restore_to_drafts` integer DEFAULT 0 NOT NULL;