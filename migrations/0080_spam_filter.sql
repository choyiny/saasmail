CREATE TABLE `spam_models` (
	`inbox` text PRIMARY KEY NOT NULL,
	`enabled` integer DEFAULT 0 NOT NULL,
	`spam_messages` integer DEFAULT 0 NOT NULL,
	`ham_messages` integer DEFAULT 0 NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `spam_tokens` (
	`inbox` text NOT NULL,
	`token` text NOT NULL,
	`spam_count` integer DEFAULT 0 NOT NULL,
	`ham_count` integer DEFAULT 0 NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`inbox`, `token`)
);
--> statement-breakpoint
CREATE TABLE `spam_training` (
	`inbox` text NOT NULL,
	`email_id` text NOT NULL,
	`label` text NOT NULL,
	`trained_by` text,
	`trained_at` integer NOT NULL,
	PRIMARY KEY(`inbox`, `email_id`)
);
--> statement-breakpoint
CREATE INDEX `spam_training_email_idx` ON `spam_training` (`email_id`);--> statement-breakpoint
ALTER TABLE `emails` ADD `spam_probability` real;