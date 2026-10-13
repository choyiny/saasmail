-- Best-effort historical sequence provenance.
--
-- Pass 1: rows that reached the sequence "sent" outcome have a durable
-- sequence_emails.sent_email_id backlink.
UPDATE sent_emails
SET
  sequence_enrollment_id = (
    SELECT se.enrollment_id
    FROM sequence_emails AS se
    WHERE se.sent_email_id = sent_emails.id
    LIMIT 1
  ),
  sequence_id = (
    SELECT enrollment.sequence_id
    FROM sequence_emails AS se
    JOIN sequence_enrollments AS enrollment
      ON enrollment.id = se.enrollment_id
    WHERE se.sent_email_id = sent_emails.id
    LIMIT 1
  )
WHERE sequence_id IS NULL
  AND EXISTS (
    SELECT 1
    FROM sequence_emails AS se
    JOIN sequence_enrollments AS enrollment
      ON enrollment.id = se.enrollment_id
    WHERE se.sent_email_id = sent_emails.id
  );
--> statement-breakpoint

-- Pass 2: transient/failed sequence sends may still have a surviving outbox
-- row even when sequence_emails.sent_email_id was never populated.
UPDATE sent_emails
SET
  sequence_enrollment_id = (
    SELECT se.enrollment_id
    FROM outbox_emails AS outbox
    JOIN sequence_emails AS se
      ON se.id = outbox.sequence_email_id
    WHERE outbox.sent_email_id = sent_emails.id
    LIMIT 1
  ),
  sequence_id = (
    SELECT enrollment.sequence_id
    FROM outbox_emails AS outbox
    JOIN sequence_emails AS se
      ON se.id = outbox.sequence_email_id
    JOIN sequence_enrollments AS enrollment
      ON enrollment.id = se.enrollment_id
    WHERE outbox.sent_email_id = sent_emails.id
    LIMIT 1
  )
WHERE sequence_id IS NULL
  AND EXISTS (
    SELECT 1
    FROM outbox_emails AS outbox
    JOIN sequence_emails AS se
      ON se.id = outbox.sequence_email_id
    JOIN sequence_enrollments AS enrollment
      ON enrollment.id = se.enrollment_id
    WHERE outbox.sent_email_id = sent_emails.id
  );
