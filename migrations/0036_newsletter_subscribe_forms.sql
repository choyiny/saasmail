CREATE TABLE `subscribe_forms` (
	`id` text PRIMARY KEY NOT NULL,
	`list_id` text NOT NULL,
	`name` text NOT NULL,
	`show_name_field` integer DEFAULT 1 NOT NULL,
	`name_required` integer DEFAULT 0 NOT NULL,
	`success_message` text DEFAULT 'Thanks for subscribing!' NOT NULL,
	`redirect_url` text,
	`allowed_origins` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `subscribe_forms_list_idx` ON `subscribe_forms` (`list_id`);--> statement-breakpoint
CREATE TABLE `subscribe_attempts` (
	`id` text PRIMARY KEY NOT NULL,
	`form_id` text NOT NULL,
	`email_hash` text NOT NULL,
	`ip` text NOT NULL,
	`attempt_type` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `subscribe_attempts_form_email_idx` ON `subscribe_attempts` (`form_id`,`email_hash`,`created_at`);--> statement-breakpoint
CREATE INDEX `subscribe_attempts_ip_idx` ON `subscribe_attempts` (`ip`,`created_at`);--> statement-breakpoint
CREATE INDEX `subscribe_attempts_created_idx` ON `subscribe_attempts` (`created_at`);