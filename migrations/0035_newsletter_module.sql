CREATE TABLE `newsletter_assets` (
	`id` text PRIMARY KEY NOT NULL,
	`r2_key` text NOT NULL,
	`content_type` text NOT NULL,
	`size` integer NOT NULL,
	`width` integer NOT NULL,
	`height` integer NOT NULL,
	`sha256` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `newsletter_assets_sha256_idx` ON `newsletter_assets` (`sha256`);--> statement-breakpoint
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
CREATE INDEX `list_members_email_idx` ON `list_members` (`email`);--> statement-breakpoint
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
CREATE INDEX `subscribe_attempts_created_idx` ON `subscribe_attempts` (`created_at`);--> statement-breakpoint
CREATE TABLE `campaigns` (
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
ALTER TABLE `sent_emails` ADD `campaign_id` text;--> statement-breakpoint
ALTER TABLE `email_templates` ADD `format` text DEFAULT 'html' NOT NULL;--> statement-breakpoint
ALTER TABLE `email_templates` ADD `body_json` text;