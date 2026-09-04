CREATE TABLE `campaigns` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`subject` text NOT NULL,
	`template_slug` text NOT NULL,
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
CREATE INDEX `campaigns_list_idx` ON `campaigns` (`list_id`);--> statement-breakpoint
CREATE INDEX `campaigns_from_address_idx` ON `campaigns` (`from_address`);--> statement-breakpoint
CREATE INDEX `campaigns_status_scheduled_idx` ON `campaigns` (`status`,`scheduled_at`);--> statement-breakpoint
CREATE TABLE `campaign_recipients` (
	`id` text PRIMARY KEY NOT NULL,
	`campaign_id` text NOT NULL,
	`contact_id` text NOT NULL,
	`email` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`idempotency_key` text NOT NULL,
	`outbox_id` text,
	`sent_email_id` text,
	`attempts` integer DEFAULT 0 NOT NULL,
	`last_error` text,
	`queued_at` integer NOT NULL,
	`processed_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `campaign_recipients_campaign_contact_unique` ON `campaign_recipients` (`campaign_id`,`contact_id`);--> statement-breakpoint
CREATE INDEX `campaign_recipients_campaign_status_idx` ON `campaign_recipients` (`campaign_id`,`status`);--> statement-breakpoint
CREATE TABLE `campaign_links` (
	`id` text PRIMARY KEY NOT NULL,
	`campaign_id` text NOT NULL,
	`url` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `campaign_links_campaign_url_unique` ON `campaign_links` (`campaign_id`,`url`);--> statement-breakpoint
CREATE TABLE `campaign_events` (
	`id` text PRIMARY KEY NOT NULL,
	`campaign_id` text NOT NULL,
	`contact_id` text NOT NULL,
	`email` text NOT NULL,
	`event_type` text NOT NULL,
	`campaign_link_id` text,
	`occurred_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `campaign_events_campaign_type_idx` ON `campaign_events` (`campaign_id`,`event_type`);--> statement-breakpoint
CREATE INDEX `campaign_events_campaign_occurred_idx` ON `campaign_events` (`campaign_id`,`occurred_at`);--> statement-breakpoint
CREATE TABLE `campaign_unsubscribe_attributions` (
	`id` text PRIMARY KEY NOT NULL,
	`campaign_id` text NOT NULL,
	`list_member_id` text NOT NULL,
	`occurred_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `campaign_unsub_attr_campaign_member_unique` ON `campaign_unsubscribe_attributions` (`campaign_id`,`list_member_id`);--> statement-breakpoint
ALTER TABLE `sent_emails` ADD `campaign_id` text;