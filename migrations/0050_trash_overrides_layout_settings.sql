CREATE TABLE `category_overrides` (
	`user_id` text NOT NULL,
	`sender_email` text NOT NULL,
	`category` text NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`user_id`, `sender_email`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `user_preferences` ADD `layout_settings` text;--> statement-breakpoint
ALTER TABLE `user_preferences` ADD `tab_seen` text;--> statement-breakpoint
ALTER TABLE `mail_item_states` ADD `trashed_at` integer;