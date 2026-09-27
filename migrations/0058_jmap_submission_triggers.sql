-- Change tracking for EmailSubmission (spec §5): accepted submissions are
-- user-scoped objects; claimed intentions are invisible and log nothing.
CREATE TRIGGER jmap_submissions_insert
AFTER INSERT ON jmap_submissions
WHEN NEW.attempt_state = 'accepted'
BEGIN
  INSERT INTO jmap_changes (object_type, object_id, inbox, user_id, op, created_at)
  VALUES ('submission', 'submission:' || NEW.id, NEW.identity_email, NEW.user_id, 'c', CAST(strftime('%s','now') AS INTEGER));
END;
--> statement-breakpoint
CREATE TRIGGER jmap_submissions_accept
AFTER UPDATE OF attempt_state ON jmap_submissions
WHEN OLD.attempt_state = 'claimed' AND NEW.attempt_state = 'accepted'
BEGIN
  INSERT INTO jmap_changes (object_type, object_id, inbox, user_id, op, created_at)
  VALUES ('submission', 'submission:' || NEW.id, NEW.identity_email, NEW.user_id, 'c', CAST(strftime('%s','now') AS INTEGER));
END;
--> statement-breakpoint
CREATE TRIGGER jmap_submissions_delete
AFTER DELETE ON jmap_submissions
WHEN OLD.attempt_state = 'accepted'
BEGIN
  INSERT INTO jmap_changes (object_type, object_id, inbox, user_id, op, created_at)
  VALUES ('submission', 'submission:' || OLD.id, OLD.identity_email, OLD.user_id, 'd', CAST(strftime('%s','now') AS INTEGER));
END;
