PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_campaigns` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`subject` text NOT NULL,
	`template_slug` text,
	`format` text DEFAULT 'html' NOT NULL,
	`body_json` text,
	`body_html` text DEFAULT '' NOT NULL,
	`from_address` text NOT NULL,
	`list_id` text NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`scheduled_at` integer,
	`content_snapshot_at` integer,
	`subject_snapshot` text,
	`html_snapshot` text,
	`text_body_override` text,
	`text_snapshot` text,
	`from_address_snapshot` text,
	`template_revision` text,
	`unsubscribe_domain_key_version` integer DEFAULT 1 NOT NULL,
	`fan_out_cursor` text,
	`fan_out_job_id` text,
	`sent_at` integer,
	`stats_targeted` integer DEFAULT 0 NOT NULL,
	`stats_delivered` integer DEFAULT 0 NOT NULL,
	`stats_suppressed` integer DEFAULT 0 NOT NULL,
	`stats_retryable_failed` integer DEFAULT 0 NOT NULL,
	`stats_permanent_failed` integer DEFAULT 0 NOT NULL,
	`stats_unique_openers` integer DEFAULT 0 NOT NULL,
	`stats_unique_clicks` integer DEFAULT 0 NOT NULL,
	`stats_unsubscribes` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_campaigns`("id", "name", "subject", "template_slug", "format", "body_json", "body_html", "from_address", "list_id", "status", "scheduled_at", "content_snapshot_at", "subject_snapshot", "html_snapshot", "text_body_override", "text_snapshot", "from_address_snapshot", "template_revision", "unsubscribe_domain_key_version", "fan_out_cursor", "fan_out_job_id", "sent_at", "stats_targeted", "stats_delivered", "stats_suppressed", "stats_retryable_failed", "stats_permanent_failed", "stats_unique_openers", "stats_unique_clicks", "stats_unsubscribes", "created_at", "updated_at") SELECT "id", "name", "subject", "template_slug", "format", "body_json", "body_html", "from_address", "list_id", "status", "scheduled_at", "content_snapshot_at", "subject_snapshot", "html_snapshot", "text_body_override", "text_snapshot", "from_address_snapshot", "template_revision", "unsubscribe_domain_key_version", "fan_out_cursor", "fan_out_job_id", "sent_at", "stats_targeted", "stats_delivered", "stats_suppressed", "stats_retryable_failed", "stats_permanent_failed", "stats_unique_openers", "stats_unique_clicks", "stats_unsubscribes", "created_at", "updated_at" FROM `campaigns`;--> statement-breakpoint
DROP TABLE `campaigns`;--> statement-breakpoint
ALTER TABLE `__new_campaigns` RENAME TO `campaigns`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `campaigns_list_idx` ON `campaigns` (`list_id`);--> statement-breakpoint
CREATE INDEX `campaigns_from_address_idx` ON `campaigns` (`from_address`);--> statement-breakpoint
CREATE INDEX `campaigns_status_scheduled_idx` ON `campaigns` (`status`,`scheduled_at`);