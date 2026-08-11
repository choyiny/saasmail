-- One-shot: clear unread counts for mail already hidden by the blocklist.
-- Going forward, POST /api/blocklist marks matching unread on create.
UPDATE emails
SET is_read = 1
WHERE is_read = 0
  AND person_id IN (
    SELECT p.id FROM people p
    WHERE EXISTS (
      SELECT 1 FROM blocklist b
      WHERE (b.type = 'email' AND b.value = p.email)
         OR (b.type = 'domain' AND b.value = lower(substr(p.email, instr(p.email, '@') + 1)))
    )
  );--> statement-breakpoint
UPDATE people
SET unread_count = (
  SELECT COUNT(*) FROM emails e
  WHERE e.person_id = people.id AND e.is_read = 0
)
WHERE id IN (
  SELECT p.id FROM people p
  WHERE EXISTS (
    SELECT 1 FROM blocklist b
    WHERE (b.type = 'email' AND b.value = p.email)
       OR (b.type = 'domain' AND b.value = lower(substr(p.email, instr(p.email, '@') + 1)))
  )
);
