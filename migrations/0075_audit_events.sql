CREATE TABLE `audit_events` (
	`id` text PRIMARY KEY NOT NULL,
	`at` integer NOT NULL,
	`actor_type` text NOT NULL,
	`actor_user_id` text,
	`actor_label` text NOT NULL,
	`channel` text NOT NULL,
	`action` text NOT NULL,
	`target_type` text,
	`target_id` text,
	`inbox` text,
	`summary` text NOT NULL,
	`details` text,
	`ip` text,
	`user_agent` text
);
--> statement-breakpoint
CREATE INDEX `audit_events_at_idx` ON `audit_events` (`at`);--> statement-breakpoint
CREATE INDEX `audit_events_actor_at_idx` ON `audit_events` (`actor_user_id`,`at`);--> statement-breakpoint
CREATE INDEX `audit_events_inbox_at_idx` ON `audit_events` (`inbox`,`at`);--> statement-breakpoint
CREATE INDEX `audit_events_action_at_idx` ON `audit_events` (`action`,`at`);