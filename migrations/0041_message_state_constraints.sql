-- Enforce the application-level MessageKind union without rebuilding the
-- freshly-created state tables. SQLite triggers provide the same insert/update
-- invariant while keeping the Drizzle-managed table definitions unchanged.

CREATE TRIGGER message_user_state_kind_insert
BEFORE INSERT ON message_user_state
WHEN NEW.message_kind NOT IN ('received', 'sent')
BEGIN
  SELECT RAISE(ABORT, 'invalid message_kind');
END;
--> statement-breakpoint
CREATE TRIGGER message_user_state_kind_update
BEFORE UPDATE OF message_kind ON message_user_state
WHEN NEW.message_kind NOT IN ('received', 'sent')
BEGIN
  SELECT RAISE(ABORT, 'invalid message_kind');
END;
--> statement-breakpoint

CREATE TRIGGER mailbox_message_state_kind_insert
BEFORE INSERT ON mailbox_message_state
WHEN NEW.message_kind NOT IN ('received', 'sent')
BEGIN
  SELECT RAISE(ABORT, 'invalid message_kind');
END;
--> statement-breakpoint
CREATE TRIGGER mailbox_message_state_kind_update
BEFORE UPDATE OF message_kind ON mailbox_message_state
WHEN NEW.message_kind NOT IN ('received', 'sent')
BEGIN
  SELECT RAISE(ABORT, 'invalid message_kind');
END;
--> statement-breakpoint

CREATE TRIGGER message_mailboxes_kind_insert
BEFORE INSERT ON message_mailboxes
WHEN NEW.message_kind NOT IN ('received', 'sent')
BEGIN
  SELECT RAISE(ABORT, 'invalid message_kind');
END;
--> statement-breakpoint
CREATE TRIGGER message_mailboxes_kind_update
BEFORE UPDATE OF message_kind ON message_mailboxes
WHEN NEW.message_kind NOT IN ('received', 'sent')
BEGIN
  SELECT RAISE(ABORT, 'invalid message_kind');
END;
--> statement-breakpoint

-- SQLite treats NULLs as distinct in composite UNIQUE indexes, so the
-- Drizzle-managed (inbox,parent_id,name) index does not protect root names.
CREATE UNIQUE INDEX mailboxes_root_name_unique
ON mailboxes(inbox, name)
WHERE parent_id IS NULL;
