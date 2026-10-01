CREATE TABLE `jmap_blobs` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`type` text NOT NULL,
	`size` integer NOT NULL,
	`r2_key` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `jmap_blobs_user_idx` ON `jmap_blobs` (`user_id`);--> statement-breakpoint
CREATE INDEX `jmap_blobs_created_at_idx` ON `jmap_blobs` (`created_at`);