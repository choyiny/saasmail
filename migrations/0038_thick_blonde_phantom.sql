DROP INDEX `emails_message_id_unique`;--> statement-breakpoint
CREATE UNIQUE INDEX `emails_message_recipient_unique` ON `emails` (`message_id`,`recipient`);