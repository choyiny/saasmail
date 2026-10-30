CREATE TABLE `delivery_events` (
	`id` text PRIMARY KEY NOT NULL,
	`provider` text NOT NULL,
	`kind` text NOT NULL,
	`bounce_type` text,
	`sent_email_id` text,
	`campaign_id` text,
	`message_id` text,
	`recipient` text NOT NULL,
	`sender` text,
	`smtp_status` text,
	`detail` text,
	`occurred_at` integer NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `delivery_events_recipient_idx` ON `delivery_events` (`recipient`,`occurred_at`);--> statement-breakpoint
CREATE INDEX `delivery_events_sent_email_idx` ON `delivery_events` (`sent_email_id`);--> statement-breakpoint
CREATE INDEX `delivery_events_campaign_kind_idx` ON `delivery_events` (`campaign_id`,`kind`);--> statement-breakpoint
CREATE TABLE `delivery_message_ids` (
	`message_id` text PRIMARY KEY NOT NULL,
	`sent_email_id` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `delivery_message_ids_sent_email_idx` ON `delivery_message_ids` (`sent_email_id`);