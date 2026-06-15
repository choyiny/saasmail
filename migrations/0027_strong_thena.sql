CREATE INDEX IF NOT EXISTS `users_role_idx` ON `users` (`role`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `emails_conversation_idx` ON `emails` (`conversation_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `sent_emails_conversation_idx` ON `sent_emails` (`conversation_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `sent_emails_from_sent_idx` ON `sent_emails` (`from_address`,`sent_at`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `invitations_created_at_idx` ON `invitations` (`created_at`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `suppressions_created_at_idx` ON `suppressions` (`created_at`);
