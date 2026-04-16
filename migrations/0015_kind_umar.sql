CREATE TABLE `inbox_permissions` (
	`user_id` text NOT NULL,
	`email` text NOT NULL,
	`created_at` integer NOT NULL,
	`created_by` text,
	PRIMARY KEY(`user_id`, `email`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `inbox_permissions_email_idx` ON `inbox_permissions` (`email`);