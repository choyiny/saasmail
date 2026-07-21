CREATE TABLE `outbox_emails` (
	`id` text PRIMARY KEY NOT NULL,
	`sent_email_id` text NOT NULL,
	`sequence_email_id` text,
	`from_address` text NOT NULL,
	`to_address` text NOT NULL,
	`cc` text,
	`subject` text NOT NULL,
	`body_html` text,
	`body_text` text,
	`headers` text,
	`transactional` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`last_error` text,
	`next_retry_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `outbox_status_retry_idx` ON `outbox_emails` (`status`,`next_retry_at`);--> statement-breakpoint
CREATE INDEX `outbox_from_idx` ON `outbox_emails` (`from_address`);
