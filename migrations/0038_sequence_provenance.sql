ALTER TABLE `sent_emails` ADD `sequence_id` text;--> statement-breakpoint
ALTER TABLE `sent_emails` ADD `sequence_enrollment_id` text;--> statement-breakpoint
CREATE INDEX `sent_emails_sequence_sent_idx` ON `sent_emails` (`sequence_id`,`sent_at`);