CREATE TABLE `send_idempotency` (
	`user_id` text NOT NULL,
	`key` text NOT NULL,
	`fingerprint` text NOT NULL,
	`status` text NOT NULL,
	`response_status` integer,
	`response_body` text,
	`sent_email_id` text,
	`created_at` integer NOT NULL,
	`completed_at` integer,
	PRIMARY KEY(`user_id`, `key`)
);
--> statement-breakpoint
CREATE INDEX `send_idempotency_created_at_idx` ON `send_idempotency` (`created_at`);