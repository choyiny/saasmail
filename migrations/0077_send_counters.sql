CREATE TABLE `send_counters` (
	`user_id` text NOT NULL,
	`channel` text NOT NULL,
	`day` text NOT NULL,
	`count` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`user_id`, `channel`, `day`)
);
