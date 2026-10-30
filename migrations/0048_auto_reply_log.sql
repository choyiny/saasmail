CREATE TABLE `auto_reply_log` (
	`rule_id` text NOT NULL,
	`sender` text NOT NULL,
	`sent_at` integer NOT NULL,
	FOREIGN KEY (`rule_id`) REFERENCES `rules`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `auto_reply_log_rule_sender_sent_idx` ON `auto_reply_log` (`rule_id`,`sender`,`sent_at`);