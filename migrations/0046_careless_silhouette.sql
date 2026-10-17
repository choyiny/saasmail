CREATE TABLE `install_state` (
	`installation_id` text PRIMARY KEY NOT NULL,
	`ownership_nonce` text NOT NULL,
	`version` text,
	`manifest_json` text,
	`updated_at` integer NOT NULL
);
