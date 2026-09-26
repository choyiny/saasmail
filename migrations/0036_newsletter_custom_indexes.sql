-- Raw SQL that Drizzle's schema DSL cannot express, plus the one table it
-- cannot see. Written into a `--custom` migration so the snapshot chain and
-- journal stay consistent (see AGENTS.md).

-- 1. campaign_events dedup.
--
-- A single composite unique index does not work here: open rows have a NULL
-- campaign_link_id, and SQLite allows unlimited rows when a unique-index column
-- is NULL, so every re-open would insert another row. One PARTIAL index per
-- event type — each over only the columns that are non-null for that type — is
-- what actually enforces "one open per contact" and "one click per link".
CREATE UNIQUE INDEX `campaign_events_open_unique`
  ON `campaign_events` (`campaign_id`, `contact_id`)
  WHERE `event_type` = 'open';
--> statement-breakpoint
CREATE UNIQUE INDEX `campaign_events_click_unique`
  ON `campaign_events` (`campaign_id`, `contact_id`, `campaign_link_id`)
  WHERE `event_type` = 'click';
--> statement-breakpoint

-- 2. outbox_emails campaign correlation.
--
-- `outbox_emails` is not exported from worker/src/db/index.ts, so drizzle-kit
-- has no snapshot of it and cannot generate this ALTER — the same reason
-- migration 0030 that created the table was hand-written. Add-column only.
ALTER TABLE `outbox_emails` ADD `campaign_recipient_id` text;
--> statement-breakpoint

-- At most one in-flight outbox row per recipient. Partial so the millions of
-- sequence and transactional rows, which all have a NULL campaign_recipient_id,
-- are not forced to be unique against each other.
CREATE UNIQUE INDEX `outbox_campaign_recipient_unique`
  ON `outbox_emails` (`campaign_recipient_id`)
  WHERE `campaign_recipient_id` IS NOT NULL;
