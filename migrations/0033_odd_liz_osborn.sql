CREATE TABLE `expo_push_subscriptions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`installation_id` text NOT NULL,
	`token` text NOT NULL,
	`token_version` integer DEFAULT 1 NOT NULL,
	`platform` text,
	`device_name` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`last_used_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `expo_push_user_installation_idx` ON `expo_push_subscriptions` (`user_id`,`installation_id`);--> statement-breakpoint
CREATE INDEX `expo_push_user_idx` ON `expo_push_subscriptions` (`user_id`);