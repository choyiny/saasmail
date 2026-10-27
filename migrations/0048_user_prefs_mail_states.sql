CREATE TABLE `user_preferences` (
	`user_id` text PRIMARY KEY NOT NULL,
	`ui_theme` text,
	`color_mode` text,
	`density` text,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `mail_item_states` (
	`user_id` text NOT NULL,
	`item_type` text NOT NULL,
	`item_id` text NOT NULL,
	`starred` integer DEFAULT 0 NOT NULL,
	`pinned` integer DEFAULT 0 NOT NULL,
	`archived_at` integer,
	`snoozed_until` integer,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`user_id`, `item_type`, `item_id`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `mail_item_states_user_idx` ON `mail_item_states` (`user_id`);