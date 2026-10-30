-- Draft change tracking. Written into a `--custom` migration because SQLite
-- triggers cannot be expressed in the Drizzle schema DSL.
--
-- Draft Emails are user-scoped: only the author sees them, so their change rows
-- carry user_id (Email/changes' personal arm) and the draft's inbox (inbox
-- scope). Changes to submit bookkeeping columns added later write nothing:
-- the update trigger lists the three JMAP-visible columns and fires only on a
-- real change.
CREATE TRIGGER jmap_drafts_insert
AFTER INSERT ON jmap_drafts
BEGIN
  INSERT INTO jmap_changes (object_type, object_id, inbox, user_id, op, created_at)
  VALUES ('email', 'draft:' || NEW.id, NEW.inbox, NEW.user_id, 'c', CAST(strftime('%s','now') AS INTEGER));
END;
--> statement-breakpoint
CREATE TRIGGER jmap_drafts_update
AFTER UPDATE OF mailbox_role, seen, flagged ON jmap_drafts
WHEN OLD.mailbox_role IS NOT NEW.mailbox_role
  OR OLD.seen IS NOT NEW.seen
  OR OLD.flagged IS NOT NEW.flagged
BEGIN
  INSERT INTO jmap_changes (object_type, object_id, inbox, user_id, op, created_at)
  VALUES ('email', 'draft:' || NEW.id, NEW.inbox, NEW.user_id, 'u', CAST(strftime('%s','now') AS INTEGER));
END;
--> statement-breakpoint
CREATE TRIGGER jmap_drafts_delete
AFTER DELETE ON jmap_drafts
BEGIN
  INSERT INTO jmap_changes (object_type, object_id, inbox, user_id, op, created_at)
  VALUES ('email', 'draft:' || OLD.id, OLD.inbox, OLD.user_id, 'd', CAST(strftime('%s','now') AS INTEGER));
END;
