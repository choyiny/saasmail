-- Drafts in custom folders (0069 added jmap_drafts.folder_ids). Written as a
-- `--custom` migration: drizzle-kit doesn't manage triggers.

-- A draft's folder change is an Email update for its author, like its
-- mailbox_role / seen / flagged changes (0056).
DROP TRIGGER IF EXISTS jmap_drafts_update;
--> statement-breakpoint
CREATE TRIGGER jmap_drafts_update
AFTER UPDATE OF mailbox_role, seen, flagged, folder_ids ON jmap_drafts
WHEN OLD.mailbox_role IS NOT NEW.mailbox_role
  OR OLD.seen IS NOT NEW.seen
  OR OLD.flagged IS NOT NEW.flagged
  OR OLD.folder_ids IS NOT NEW.folder_ids
BEGIN
  INSERT INTO jmap_changes (object_type, object_id, inbox, user_id, op, created_at)
  VALUES ('email', 'draft:' || NEW.id, NEW.inbox, NEW.user_id, 'u', CAST(strftime('%s','now') AS INTEGER));
END;
--> statement-breakpoint

-- A custom folder deleted anywhere (web or JMAP) leaves every draft filed in
-- it; the update above then tells each draft's author.
CREATE TRIGGER jmap_drafts_folder_deleted
AFTER DELETE ON mailboxes
BEGIN
  UPDATE jmap_drafts
     SET folder_ids = (
       SELECT COALESCE(json_group_array(j.value), '[]')
         FROM json_each(jmap_drafts.folder_ids) j
        WHERE j.value <> OLD.id
     )
   WHERE inbox = OLD.inbox
     AND EXISTS (
       SELECT 1 FROM json_each(jmap_drafts.folder_ids) j WHERE j.value = OLD.id
     );
END;
