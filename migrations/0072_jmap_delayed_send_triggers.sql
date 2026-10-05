-- Delayed send (RFC 4865 FUTURERELEASE). Written as a `--custom` migration:
-- drizzle-kit doesn't manage triggers.
--
-- A submission is JMAP-visible in every state but `claimed` (the invisible
-- intention): `scheduled`, `releasing` and `accepted`. It appears when it
-- leaves `claimed` (or is inserted visible), its undoStatus changes are
-- updates, and deleting a visible one is a destroy.
DROP TRIGGER IF EXISTS jmap_submissions_insert;
--> statement-breakpoint
CREATE TRIGGER jmap_submissions_insert
AFTER INSERT ON jmap_submissions
WHEN NEW.attempt_state <> 'claimed'
BEGIN
  INSERT INTO jmap_changes (object_type, object_id, inbox, user_id, op, created_at)
  VALUES ('submission', 'submission:' || NEW.id, NEW.identity_email, NEW.user_id, 'c', CAST(strftime('%s','now') AS INTEGER));
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS jmap_submissions_accept;
--> statement-breakpoint
CREATE TRIGGER jmap_submissions_accept
AFTER UPDATE OF attempt_state ON jmap_submissions
WHEN OLD.attempt_state = 'claimed' AND NEW.attempt_state <> 'claimed'
BEGIN
  INSERT INTO jmap_changes (object_type, object_id, inbox, user_id, op, created_at)
  VALUES ('submission', 'submission:' || NEW.id, NEW.identity_email, NEW.user_id, 'c', CAST(strftime('%s','now') AS INTEGER));
END;
--> statement-breakpoint
CREATE TRIGGER jmap_submissions_undo_status
AFTER UPDATE OF undo_status ON jmap_submissions
WHEN OLD.attempt_state <> 'claimed' AND OLD.undo_status IS NOT NEW.undo_status
BEGIN
  INSERT INTO jmap_changes (object_type, object_id, inbox, user_id, op, created_at)
  VALUES ('submission', 'submission:' || NEW.id, NEW.identity_email, NEW.user_id, 'u', CAST(strftime('%s','now') AS INTEGER));
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS jmap_submissions_delete;
--> statement-breakpoint
CREATE TRIGGER jmap_submissions_delete
AFTER DELETE ON jmap_submissions
WHEN OLD.attempt_state <> 'claimed'
BEGIN
  INSERT INTO jmap_changes (object_type, object_id, inbox, user_id, op, created_at)
  VALUES ('submission', 'submission:' || OLD.id, OLD.identity_email, OLD.user_id, 'd', CAST(strftime('%s','now') AS INTEGER));
END;
--> statement-breakpoint

-- The reverse alias: a canceled delayed send's Email moves from Sent back to
-- Drafts under the same id. The Sent row is flagged `alias_restore` and then
-- deleted, and the draft row is inserted with `alias_delete` = 1 and then
-- cleared, so none of these writes logs a change of its own; the reverse alias
-- writes the author's `u` and everyone else's `d` itself. Bodies copied from
-- 0060 / 0056; only the WHEN clauses are new.
DROP TRIGGER IF EXISTS jmap_sent_emails_update;
--> statement-breakpoint
CREATE TRIGGER jmap_sent_emails_update
AFTER UPDATE ON sent_emails
WHEN NEW.alias_restore = 0 AND NOT EXISTS (
  SELECT 1 FROM jmap_submissions js
  WHERE js.sent_email_id = NEW.id AND js.on_success_state = 'pending'
)
BEGIN
  INSERT INTO jmap_changes (object_type, object_id, inbox, user_id, op, created_at)
  VALUES ('email', COALESCE('draft:' || NEW.jmap_email_id, 'sent:' || NEW.id), NEW.from_address, NULL, 'u', CAST(strftime('%s','now') AS INTEGER));
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS jmap_sent_emails_delete;
--> statement-breakpoint
CREATE TRIGGER jmap_sent_emails_delete
AFTER DELETE ON sent_emails
WHEN OLD.alias_restore = 0 AND NOT EXISTS (
  SELECT 1 FROM jmap_submissions js
  WHERE js.sent_email_id = OLD.id AND js.on_success_state = 'pending'
)
BEGIN
  INSERT INTO jmap_changes (object_type, object_id, inbox, user_id, op, created_at)
  VALUES ('email', COALESCE('draft:' || OLD.jmap_email_id, 'sent:' || OLD.id), OLD.from_address, NULL, 'd', CAST(strftime('%s','now') AS INTEGER));
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS jmap_drafts_insert;
--> statement-breakpoint
CREATE TRIGGER jmap_drafts_insert
AFTER INSERT ON jmap_drafts
WHEN NEW.alias_delete = 0
BEGIN
  INSERT INTO jmap_changes (object_type, object_id, inbox, user_id, op, created_at)
  VALUES ('email', 'draft:' || NEW.id, NEW.inbox, NEW.user_id, 'c', CAST(strftime('%s','now') AS INTEGER));
END;
