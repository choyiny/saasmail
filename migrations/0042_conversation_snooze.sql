CREATE TABLE `inbox_conversation_state` (
	`inbox` text NOT NULL,
	`conversation_key` text NOT NULL,
	`snoozed_until` integer,
	`snoozed_by` text,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`inbox`, `conversation_key`),
	FOREIGN KEY (`snoozed_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `inbox_conversation_state_inbox_snoozed_idx` ON `inbox_conversation_state` (`inbox`,`snoozed_until`);