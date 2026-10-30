CREATE TABLE `rules` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`inbox` text,
	`trigger` text DEFAULT 'message.received' NOT NULL,
	`conditions` text NOT NULL,
	`actions` text NOT NULL,
	`position` integer NOT NULL,
	`stop_processing` integer DEFAULT 0 NOT NULL,
	`enabled` integer DEFAULT 1 NOT NULL,
	`match_count` integer DEFAULT 0 NOT NULL,
	`last_matched_at` integer,
	`created_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `rules_enabled_position_idx` ON `rules` (`enabled`,`position`);--> statement-breakpoint
ALTER TABLE `inbox_conversation_state` ADD `assigned_user_id` text REFERENCES users(id) ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE `inbox_conversation_state` ADD `assigned_at` integer;