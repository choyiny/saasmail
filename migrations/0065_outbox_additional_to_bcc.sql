-- JMAP submissions can have several To and Bcc recipients. The outbox keeps
-- them so a retry that can't reload the frozen JMAP content still reaches every
-- recipient. JSON [{email,name}], NULL = none. `--custom` because outbox_emails
-- is not exported from worker/src/db/index.ts (see 0053). Add-column only.
ALTER TABLE `outbox_emails` ADD `additional_to` text;
--> statement-breakpoint
ALTER TABLE `outbox_emails` ADD `bcc` text;
