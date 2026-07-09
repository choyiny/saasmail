CREATE TABLE `blocklist` (
	`id` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`value` text NOT NULL,
	`note` text,
	`created_by` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `blocklist_created_at_idx` ON `blocklist` (`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `blocklist_type_value_unique` ON `blocklist` (`type`,`value`);