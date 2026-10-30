CREATE TABLE `oauth_client_assertions` (
	`id` text PRIMARY KEY NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `oauth_client_resources` (
	`id` text PRIMARY KEY NOT NULL,
	`client_id` text NOT NULL,
	`resource_id` text NOT NULL,
	`metadata` text,
	`created_at` integer,
	FOREIGN KEY (`client_id`) REFERENCES `oauth_clients`(`client_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`resource_id`) REFERENCES `oauth_resources`(`identifier`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `oauthClientResources_clientId_resourceId_uidx` ON `oauth_client_resources` (`client_id`,`resource_id`);--> statement-breakpoint
CREATE INDEX `oauthClientResources_clientId_idx` ON `oauth_client_resources` (`client_id`);--> statement-breakpoint
CREATE INDEX `oauthClientResources_resourceId_idx` ON `oauth_client_resources` (`resource_id`);--> statement-breakpoint
CREATE TABLE `oauth_resources` (
	`id` text PRIMARY KEY NOT NULL,
	`identifier` text NOT NULL,
	`name` text NOT NULL,
	`access_token_ttl` integer,
	`refresh_token_ttl` integer,
	`signing_algorithm` text,
	`signing_key_id` text,
	`allowed_scopes` text,
	`custom_claims` text,
	`dpop_bound_access_tokens_required` integer DEFAULT false,
	`disabled` integer DEFAULT false,
	`created_at` integer,
	`updated_at` integer,
	`policy_version` integer DEFAULT 1,
	`metadata` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `oauth_resources_identifier_unique` ON `oauth_resources` (`identifier`);--> statement-breakpoint
ALTER TABLE `jwkss` ADD `alg` text;--> statement-breakpoint
ALTER TABLE `jwkss` ADD `crv` text;--> statement-breakpoint
ALTER TABLE `oauth_access_tokens` ADD `authorization_code_id` text;--> statement-breakpoint
ALTER TABLE `oauth_access_tokens` ADD `resources` text;--> statement-breakpoint
ALTER TABLE `oauth_access_tokens` ADD `requested_user_info_claims` text;--> statement-breakpoint
ALTER TABLE `oauth_access_tokens` ADD `revoked` integer;--> statement-breakpoint
ALTER TABLE `oauth_access_tokens` ADD `confirmation` text;--> statement-breakpoint
CREATE INDEX `oauthAccessTokens_authorizationCodeId_idx` ON `oauth_access_tokens` (`authorization_code_id`);--> statement-breakpoint
ALTER TABLE `oauth_clients` ADD `client_discovery_id` text;--> statement-breakpoint
ALTER TABLE `oauth_clients` ADD `client_credentials_scopes` text DEFAULT '[]';--> statement-breakpoint
ALTER TABLE `oauth_clients` ADD `backchannel_logout_uri` text;--> statement-breakpoint
ALTER TABLE `oauth_clients` ADD `backchannel_logout_session_required` integer;--> statement-breakpoint
ALTER TABLE `oauth_clients` ADD `application_type` text;--> statement-breakpoint
ALTER TABLE `oauth_clients` ADD `jwks` text;--> statement-breakpoint
ALTER TABLE `oauth_clients` ADD `jwks_uri` text;--> statement-breakpoint
ALTER TABLE `oauth_clients` ADD `dpop_bound_access_tokens` integer DEFAULT false;--> statement-breakpoint
ALTER TABLE `oauth_consents` ADD `resources` text;--> statement-breakpoint
ALTER TABLE `oauth_consents` ADD `requested_user_info_claims` text;--> statement-breakpoint
ALTER TABLE `oauth_refresh_tokens` ADD `authorization_code_id` text;--> statement-breakpoint
ALTER TABLE `oauth_refresh_tokens` ADD `resources` text;--> statement-breakpoint
ALTER TABLE `oauth_refresh_tokens` ADD `requested_user_info_claims` text;--> statement-breakpoint
ALTER TABLE `oauth_refresh_tokens` ADD `rotated_at` integer;--> statement-breakpoint
ALTER TABLE `oauth_refresh_tokens` ADD `rotation_replay_response` text;--> statement-breakpoint
ALTER TABLE `oauth_refresh_tokens` ADD `rotation_replay_expires_at` integer;--> statement-breakpoint
ALTER TABLE `oauth_refresh_tokens` ADD `confirmation` text;--> statement-breakpoint
CREATE INDEX `oauthRefreshTokens_authorizationCodeId_idx` ON `oauth_refresh_tokens` (`authorization_code_id`);