-- Canonicalize every persisted sending-inbox key that can flow into
-- sent_emails.from_address or outbox_emails.from_address. Read paths use
-- case-sensitive equality against canonical inbox grants, so mixed-case legacy
-- rows become invisible even though permission checks themselves fold case.

UPDATE sent_emails
SET from_address = lower(trim(from_address))
WHERE from_address <> lower(trim(from_address));
--> statement-breakpoint
UPDATE sequence_enrollments
SET from_address = lower(trim(from_address))
WHERE from_address <> lower(trim(from_address));
--> statement-breakpoint
UPDATE outbox_emails
SET from_address = lower(trim(from_address))
WHERE from_address <> lower(trim(from_address));
--> statement-breakpoint
UPDATE campaigns
SET from_address = lower(trim(from_address))
WHERE from_address <> lower(trim(from_address));
--> statement-breakpoint
UPDATE campaigns
SET from_address_snapshot = lower(trim(from_address_snapshot))
WHERE from_address_snapshot IS NOT NULL
  AND from_address_snapshot <> lower(trim(from_address_snapshot));
--> statement-breakpoint
UPDATE lists
SET from_address = lower(trim(from_address))
WHERE from_address <> lower(trim(from_address));
--> statement-breakpoint
UPDATE email_templates
SET from_address = lower(trim(from_address))
WHERE from_address IS NOT NULL
  AND from_address <> lower(trim(from_address));
--> statement-breakpoint
UPDATE drafts
SET from_address = lower(trim(from_address))
WHERE from_address IS NOT NULL
  AND from_address <> lower(trim(from_address));
