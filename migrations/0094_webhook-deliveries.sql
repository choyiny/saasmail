CREATE TABLE `webhook_deliveries` (
	`id` text PRIMARY KEY NOT NULL,
	`source_key` text NOT NULL,
	`event` text NOT NULL,
	`message_id` text NOT NULL,
	`generation` integer NOT NULL,
	`payload` text,
	`frozen` integer DEFAULT 0 NOT NULL,
	`status` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`claimed_until` integer,
	`last_status` integer,
	`last_error` text,
	`next_attempt_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`finished_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `webhook_deliveries_source_key_unique` ON `webhook_deliveries` (`source_key`);--> statement-breakpoint
CREATE INDEX `webhook_deliveries_created_idx` ON `webhook_deliveries` (`created_at`);--> statement-breakpoint
CREATE INDEX `webhook_deliveries_generation_status_finished_idx` ON `webhook_deliveries` (`generation`,`status`,`finished_at`);--> statement-breakpoint
CREATE INDEX `webhook_deliveries_status_next_idx` ON `webhook_deliveries` (`status`,`next_attempt_at`);