-- The Message-ID a provider delivered an accepted message with, when it
-- replaced ours (Cloudflare always does). A `bookkeeping_pending` row keeps it
-- so JMAP recovery and the campaign sweep, which finish a send's bookkeeping
-- after the request that sent it, record the id recipients actually got.
-- Written as a `--custom` migration because `outbox_emails` is not exported
-- from worker/src/db/index.ts (see 0053). Add-column only, no backfill: rows
-- written before this column keep null and fall back to the submitted id.
ALTER TABLE `outbox_emails` ADD `delivered_message_id` text;
