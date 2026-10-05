CREATE TABLE `jmap_message_content` (
	`id` text PRIMARY KEY NOT NULL,
	`created_by` text,
	`inbox` text NOT NULL,
	`from_json` text NOT NULL,
	`to_json` text NOT NULL,
	`cc_json` text NOT NULL,
	`bcc_json` text NOT NULL,
	`reply_to_json` text,
	`subject` text NOT NULL,
	`message_id` text NOT NULL,
	`in_reply_to_json` text,
	`references_json` text,
	`sent_at` text NOT NULL,
	`parts_json` text NOT NULL,
	`text_body_json` text NOT NULL,
	`html_body_json` text NOT NULL,
	`attachments_json` text NOT NULL,
	`body_values_json` text NOT NULL,
	`preview` text NOT NULL,
	`thread_key` text NOT NULL,
	`raw_r2_key` text NOT NULL,
	`size` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `jmap_message_content_thread_key_idx` ON `jmap_message_content` (`thread_key`);--> statement-breakpoint
CREATE INDEX `jmap_message_content_created_at_idx` ON `jmap_message_content` (`created_at`);--> statement-breakpoint
CREATE TABLE `jmap_drafts` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`content_id` text NOT NULL,
	`inbox` text NOT NULL,
	`received_at` integer NOT NULL,
	`mailbox_role` text DEFAULT 'drafts' NOT NULL,
	`seen` integer DEFAULT 0 NOT NULL,
	`flagged` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`content_id`) REFERENCES `jmap_message_content`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `jmap_drafts_user_received_idx` ON `jmap_drafts` (`user_id`,`received_at`);--> statement-breakpoint
CREATE INDEX `jmap_drafts_content_idx` ON `jmap_drafts` (`content_id`);