CREATE TABLE `user_preferences` (
	`user_id` text PRIMARY KEY NOT NULL,
	`ui_theme` text,
	`color_mode` text,
	`density` text,
	`palette` text,
	`layout_settings` text,
	`tab_seen` text,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `category_overrides` (
	`user_id` text NOT NULL,
	`sender_email` text NOT NULL,
	`category` text NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`user_id`, `sender_email`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
