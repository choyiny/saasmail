CREATE TABLE `backup_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`started_at` integer NOT NULL,
	`finished_at` integer,
	`status` text NOT NULL,
	`prefix` text NOT NULL,
	`progress` text NOT NULL,
	`bytes` integer DEFAULT 0 NOT NULL,
	`error` text,
	`requested_by` text,
	`pruned_at` integer,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `backup_runs_started_idx` ON `backup_runs` (`started_at`);