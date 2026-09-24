DROP INDEX `sent_emails_gmail_message_idx`;--> statement-breakpoint
CREATE UNIQUE INDEX `sent_emails_gmail_message_from_unique` ON `sent_emails` (`gmail_message_id`,`from_address`);