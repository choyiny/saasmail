ALTER TABLE `email_templates` ADD `format` text DEFAULT 'html' NOT NULL;--> statement-breakpoint
ALTER TABLE `email_templates` ADD `body_json` text;