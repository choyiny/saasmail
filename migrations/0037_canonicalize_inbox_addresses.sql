-- Canonicalize all stored inbox-address keys so hot-path equality predicates can
-- use the existing inbox/timestamp indexes without wrapping columns in lower().
-- The migration is intentionally idempotent.

-- inbox_permissions has a composite PK (user_id, email). Keep one row per
-- case-insensitive pair, preferring an already-canonical row when present.
DELETE FROM inbox_permissions
WHERE rowid NOT IN (
  SELECT COALESCE(
    MIN(CASE WHEN email = lower(trim(email)) THEN rowid END),
    MIN(rowid)
  )
  FROM inbox_permissions
  GROUP BY user_id, lower(trim(email))
);
--> statement-breakpoint
UPDATE inbox_permissions
SET email = lower(trim(email))
WHERE email <> lower(trim(email));
--> statement-breakpoint

-- sender_identities is keyed by email. For casing collisions, keep the most
-- recently updated row; rowid breaks exact timestamp ties deterministically.
DELETE FROM sender_identities
WHERE EXISTS (
  SELECT 1
  FROM sender_identities AS newer
  WHERE lower(trim(newer.email)) = lower(trim(sender_identities.email))
    AND (
      newer.updated_at > sender_identities.updated_at
      OR (
        newer.updated_at = sender_identities.updated_at
        AND newer.rowid > sender_identities.rowid
      )
    )
);
--> statement-breakpoint
UPDATE sender_identities
SET email = lower(trim(email))
WHERE email <> lower(trim(email));
--> statement-breakpoint

-- Message write paths already canonicalize these addresses. Normalize legacy
-- rows so direct equality predicates remain correct and indexable.
UPDATE emails
SET recipient = lower(trim(recipient))
WHERE recipient <> lower(trim(recipient));
--> statement-breakpoint
UPDATE sent_emails
SET from_address = lower(trim(from_address))
WHERE from_address <> lower(trim(from_address));
