ALTER TABLE `drafts` ADD `jmap_draft_id` text;--> statement-breakpoint
ALTER TABLE `drafts` ADD `dirty` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `drafts` ADD `jmap_state` text;