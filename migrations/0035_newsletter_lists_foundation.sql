CREATE TABLE `async_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`job_type` text NOT NULL,
	`ref_id` text NOT NULL,
	`status` text DEFAULT 'running' NOT NULL,
	`cursor` text,
	`storage_key` text,
	`total_rows` integer,
	`processed_rows` integer DEFAULT 0 NOT NULL,
	`imported_count` integer DEFAULT 0 NOT NULL,
	`skipped_count` integer DEFAULT 0 NOT NULL,
	`error_summary` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `async_jobs_ref_idx` ON `async_jobs` (`job_type`,`ref_id`);--> statement-breakpoint
CREATE INDEX `async_jobs_status_idx` ON `async_jobs` (`status`);--> statement-breakpoint
CREATE TABLE `contacts` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`name` text,
	`person_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `contacts_email_unique` ON `contacts` (`email`);--> statement-breakpoint
CREATE INDEX `contacts_person_id_idx` ON `contacts` (`person_id`);--> statement-breakpoint
CREATE TABLE `lists` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`from_address` text NOT NULL,
	`double_opt_in` integer DEFAULT 0 NOT NULL,
	`confirmation_template_slug` text,
	`archived_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `lists_from_address_idx` ON `lists` (`from_address`);--> statement-breakpoint
CREATE INDEX `lists_archived_at_idx` ON `lists` (`archived_at`);--> statement-breakpoint
CREATE TABLE `list_members` (
	`id` text PRIMARY KEY NOT NULL,
	`list_id` text NOT NULL,
	`contact_id` text NOT NULL,
	`email` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`source` text NOT NULL,
	`form_id` text,
	`submitted_ip` text,
	`consent_source` text NOT NULL,
	`consent_at` integer,
	`import_job_id` text,
	`subscribed_at` integer,
	`confirmed_at` integer,
	`unsubscribed_at` integer,
	`unsubscribe_reason` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `list_members_list_contact_unique` ON `list_members` (`list_id`,`contact_id`);--> statement-breakpoint
CREATE INDEX `list_members_list_status_id_idx` ON `list_members` (`list_id`,`status`,`id`);--> statement-breakpoint
CREATE INDEX `list_members_email_idx` ON `list_members` (`email`);