CREATE TABLE `message_user_state` (
	`user_id` text NOT NULL,
	`message_kind` text NOT NULL,
	`message_id` text NOT NULL,
	`seen_at` integer,
	`starred_at` integer,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`user_id`, `message_kind`, `message_id`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `message_user_state_user_starred_idx` ON `message_user_state` (`user_id`,`starred_at`);--> statement-breakpoint
CREATE TABLE `mailbox_message_state` (
	`inbox` text NOT NULL,
	`message_kind` text NOT NULL,
	`message_id` text NOT NULL,
	`archived_at` integer,
	`spam_at` integer,
	`trashed_at` integer,
	`updated_by` text,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`message_kind`, `message_id`),
	FOREIGN KEY (`updated_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `mailbox_message_state_inbox_trashed_idx` ON `mailbox_message_state` (`inbox`,`trashed_at`);--> statement-breakpoint
CREATE INDEX `mailbox_message_state_inbox_spam_idx` ON `mailbox_message_state` (`inbox`,`spam_at`);--> statement-breakpoint
CREATE INDEX `mailbox_message_state_inbox_archived_idx` ON `mailbox_message_state` (`inbox`,`archived_at`);--> statement-breakpoint
CREATE TABLE `mailboxes` (
	`id` text PRIMARY KEY NOT NULL,
	`inbox` text NOT NULL,
	`name` text NOT NULL,
	`role` text,
	`parent_id` text,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`parent_id`) REFERENCES `mailboxes`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `mailboxes_inbox_parent_name_unique` ON `mailboxes` (`inbox`,`parent_id`,`name`);--> statement-breakpoint
CREATE TABLE `message_mailboxes` (
	`message_kind` text NOT NULL,
	`message_id` text NOT NULL,
	`mailbox_id` text NOT NULL,
	`added_by` text,
	`added_at` integer NOT NULL,
	PRIMARY KEY(`message_kind`, `message_id`, `mailbox_id`),
	FOREIGN KEY (`mailbox_id`) REFERENCES `mailboxes`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `message_mailboxes_mailbox_added_idx` ON `message_mailboxes` (`mailbox_id`,`added_at`);