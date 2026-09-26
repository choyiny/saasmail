-- Generalises the outbox's campaign-only "hold for bookkeeping" into an
-- owner marker that any subsystem can claim. Written into a `--custom`
-- migration because `outbox_emails` is deliberately not exported from
-- worker/src/db/index.ts, so drizzle-kit has no snapshot of this table and
-- cannot generate the ALTER (the same reason migration 0030, which created the
-- table, was hand-written — see migrations/0036_newsletter_custom_indexes.sql).
-- Add-column only.

-- 'campaign' | 'jmap' | null. null means no owner owes bookkeeping, so a
-- provider-accepted row is deleted immediately as before.
ALTER TABLE `outbox_emails` ADD `bookkeeping_owner` text;
--> statement-breakpoint

-- Deliberately NO data backfill. Rows written before this column existed keep a
-- null owner, and `bookkeepingOwnerOf()` in worker/src/lib/outbox.ts recognises
-- a set `campaign_recipient_id` as 'campaign', so a campaign row that was in
-- flight at deploy time still keeps its hold instead of being deleted on
-- provider success (which is how a crash would otherwise duplicate an email).
