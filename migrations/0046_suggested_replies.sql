CREATE TABLE `suggested_replies` (
	`id` text PRIMARY KEY NOT NULL,
	`email_id` text NOT NULL,
	`inbox` text NOT NULL,
	`body_text` text NOT NULL,
	`model` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`email_id`) REFERENCES `emails`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `suggested_replies_email_id_unique` ON `suggested_replies` (`email_id`);--> statement-breakpoint
CREATE INDEX `suggested_replies_inbox_status_idx` ON `suggested_replies` (`inbox`,`status`);--> statement-breakpoint
ALTER TABLE `sender_identities` ADD `agent_autodraft` integer DEFAULT 0 NOT NULL;