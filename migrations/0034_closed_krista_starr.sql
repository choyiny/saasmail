CREATE TABLE `drafts` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`context_key` text NOT NULL,
	`from_address` text,
	`to_address` text,
	`cc` text,
	`subject` text,
	`body_html` text,
	`body_text` text,
	`reply_to_email_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `drafts_user_context_idx` ON `drafts` (`user_id`,`context_key`);