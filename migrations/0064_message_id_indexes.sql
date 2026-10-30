CREATE INDEX `sent_emails_message_id_idx` ON `sent_emails` (`message_id`);--> statement-breakpoint
CREATE INDEX `jmap_message_content_message_id_idx` ON `jmap_message_content` (`message_id`);