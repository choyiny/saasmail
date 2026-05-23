CREATE TABLE `suppressions` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`reason` text NOT NULL,
	`source` text,
	`note` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `suppressions_email_unique` ON `suppressions` (`email`);