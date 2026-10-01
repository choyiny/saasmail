CREATE TABLE `jmap_submissions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`attempt_state` text NOT NULL,
	`on_success_state` text NOT NULL,
	`draft_id` text NOT NULL,
	`content_id` text NOT NULL,
	`identity_id` text NOT NULL,
	`identity_email` text NOT NULL,
	`email_id` text NOT NULL,
	`thread_id` text NOT NULL,
	`sent_email_id` text NOT NULL,
	`envelope_json` text NOT NULL,
	`on_success_mode` text NOT NULL,
	`on_success_patch_json` text,
	`send_at` integer NOT NULL,
	`undo_status` text DEFAULT 'final' NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `jmap_submissions_sent_email_id_unique` ON `jmap_submissions` (`sent_email_id`);--> statement-breakpoint
CREATE INDEX `jmap_submissions_user_send_idx` ON `jmap_submissions` (`user_id`,`send_at`);--> statement-breakpoint
CREATE INDEX `jmap_submissions_attempt_idx` ON `jmap_submissions` (`attempt_state`,`created_at`);--> statement-breakpoint
CREATE INDEX `jmap_submissions_on_success_idx` ON `jmap_submissions` (`on_success_state`);--> statement-breakpoint
ALTER TABLE `sent_emails` ADD `jmap_content_id` text;--> statement-breakpoint
CREATE INDEX `sent_emails_jmap_content_idx` ON `sent_emails` (`jmap_content_id`);--> statement-breakpoint
ALTER TABLE `jmap_drafts` ADD `submit_state` text;--> statement-breakpoint
ALTER TABLE `jmap_drafts` ADD `submit_attempt_id` text;