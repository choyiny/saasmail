DROP TABLE `subscribe_forms`;--> statement-breakpoint
DROP TABLE `subscribe_attempts`;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_list_members` (
	`id` text PRIMARY KEY NOT NULL,
	`list_id` text NOT NULL,
	`contact_id` text NOT NULL,
	`email` text NOT NULL,
	`status` text DEFAULT 'subscribed' NOT NULL,
	`source` text NOT NULL,
	`consent_source` text NOT NULL,
	`consent_at` integer,
	`import_job_id` text,
	`subscribed_at` integer,
	`unsubscribed_at` integer,
	`unsubscribe_reason` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_list_members`("id", "list_id", "contact_id", "email", "status", "source", "consent_source", "consent_at", "import_job_id", "subscribed_at", "unsubscribed_at", "unsubscribe_reason", "created_at") SELECT "id", "list_id", "contact_id", "email", "status", "source", "consent_source", "consent_at", "import_job_id", "subscribed_at", "unsubscribed_at", "unsubscribe_reason", "created_at" FROM `list_members`;--> statement-breakpoint
DROP TABLE `list_members`;--> statement-breakpoint
ALTER TABLE `__new_list_members` RENAME TO `list_members`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `list_members_list_contact_unique` ON `list_members` (`list_id`,`contact_id`);--> statement-breakpoint
CREATE INDEX `list_members_list_status_id_idx` ON `list_members` (`list_id`,`status`,`id`);--> statement-breakpoint
CREATE INDEX `list_members_email_idx` ON `list_members` (`email`);--> statement-breakpoint
ALTER TABLE `lists` DROP COLUMN `double_opt_in`;--> statement-breakpoint
ALTER TABLE `lists` DROP COLUMN `confirmation_template_slug`;