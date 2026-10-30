-- PR 6: JMAP-originated Sent rows are invisible to JMAP while their
-- submission's on-success step is pending, and an aliased Sent row (the draft
-- filed into Sent) keeps the draft's Email id. Every trigger that writes a
-- 'sent:' change row learns both rules. Hand-written because drizzle-kit does
-- not model triggers (same as 0050).

DROP TRIGGER IF EXISTS jmap_sent_emails_insert;
--> statement-breakpoint
CREATE TRIGGER jmap_sent_emails_insert
AFTER INSERT ON sent_emails
WHEN NOT EXISTS (
  SELECT 1 FROM jmap_submissions js
  WHERE js.sent_email_id = NEW.id AND js.on_success_state = 'pending'
)
BEGIN
  INSERT INTO jmap_changes (object_type, object_id, inbox, user_id, op, created_at)
  VALUES ('email', COALESCE('draft:' || NEW.jmap_email_id, 'sent:' || NEW.id), NEW.from_address, NULL, 'c', CAST(strftime('%s','now') AS INTEGER));
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS jmap_sent_emails_update;
--> statement-breakpoint
CREATE TRIGGER jmap_sent_emails_update
AFTER UPDATE ON sent_emails
WHEN NOT EXISTS (
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
WHEN NOT EXISTS (
  SELECT 1 FROM jmap_submissions js
  WHERE js.sent_email_id = OLD.id AND js.on_success_state = 'pending'
)
BEGIN
  INSERT INTO jmap_changes (object_type, object_id, inbox, user_id, op, created_at)
  VALUES ('email', COALESCE('draft:' || OLD.jmap_email_id, 'sent:' || OLD.id), OLD.from_address, NULL, 'd', CAST(strftime('%s','now') AS INTEGER));
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS jmap_message_user_state_insert;
--> statement-breakpoint
CREATE TRIGGER jmap_message_user_state_insert
AFTER INSERT ON message_user_state
BEGIN
  INSERT INTO jmap_changes (object_type, object_id, inbox, user_id, op, created_at)
  SELECT 'email', 'received:' || NEW.message_id, e.recipient, NEW.user_id, 'u', CAST(strftime('%s','now') AS INTEGER)
  FROM emails e
  WHERE NEW.message_kind = 'received' AND e.id = NEW.message_id
  UNION ALL
  SELECT 'email', COALESCE('draft:' || se.jmap_email_id, 'sent:' || se.id), se.from_address, NEW.user_id, 'u', CAST(strftime('%s','now') AS INTEGER)
  FROM sent_emails se
  WHERE NEW.message_kind = 'sent' AND se.id = NEW.message_id
    AND NOT EXISTS (SELECT 1 FROM jmap_submissions js WHERE js.sent_email_id = se.id AND js.on_success_state = 'pending');
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS jmap_message_user_state_update;
--> statement-breakpoint
CREATE TRIGGER jmap_message_user_state_update
AFTER UPDATE ON message_user_state
BEGIN
  INSERT INTO jmap_changes (object_type, object_id, inbox, user_id, op, created_at)
  SELECT 'email', 'received:' || NEW.message_id, e.recipient, NEW.user_id, 'u', CAST(strftime('%s','now') AS INTEGER)
  FROM emails e
  WHERE NEW.message_kind = 'received' AND e.id = NEW.message_id
  UNION ALL
  SELECT 'email', COALESCE('draft:' || se.jmap_email_id, 'sent:' || se.id), se.from_address, NEW.user_id, 'u', CAST(strftime('%s','now') AS INTEGER)
  FROM sent_emails se
  WHERE NEW.message_kind = 'sent' AND se.id = NEW.message_id
    AND NOT EXISTS (SELECT 1 FROM jmap_submissions js WHERE js.sent_email_id = se.id AND js.on_success_state = 'pending');
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS jmap_message_user_state_delete;
--> statement-breakpoint
CREATE TRIGGER jmap_message_user_state_delete
AFTER DELETE ON message_user_state
BEGIN
  INSERT INTO jmap_changes (object_type, object_id, inbox, user_id, op, created_at)
  SELECT 'email', 'received:' || OLD.message_id, e.recipient, OLD.user_id, 'u', CAST(strftime('%s','now') AS INTEGER)
  FROM emails e
  WHERE OLD.message_kind = 'received' AND e.id = OLD.message_id
  UNION ALL
  SELECT 'email', COALESCE('draft:' || se.jmap_email_id, 'sent:' || se.id), se.from_address, OLD.user_id, 'u', CAST(strftime('%s','now') AS INTEGER)
  FROM sent_emails se
  WHERE OLD.message_kind = 'sent' AND se.id = OLD.message_id
    AND NOT EXISTS (SELECT 1 FROM jmap_submissions js WHERE js.sent_email_id = se.id AND js.on_success_state = 'pending');
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS jmap_mailbox_message_state_insert;
--> statement-breakpoint
CREATE TRIGGER jmap_mailbox_message_state_insert
AFTER INSERT ON mailbox_message_state
BEGIN
  INSERT INTO jmap_changes (object_type, object_id, inbox, user_id, op, created_at)
  SELECT 'email', 'received:' || NEW.message_id, e.recipient, NULL, 'u', CAST(strftime('%s','now') AS INTEGER)
  FROM emails e
  WHERE NEW.message_kind = 'received' AND e.id = NEW.message_id
  UNION ALL
  SELECT 'email', COALESCE('draft:' || se.jmap_email_id, 'sent:' || se.id), se.from_address, NULL, 'u', CAST(strftime('%s','now') AS INTEGER)
  FROM sent_emails se
  WHERE NEW.message_kind = 'sent' AND se.id = NEW.message_id
    AND NOT EXISTS (SELECT 1 FROM jmap_submissions js WHERE js.sent_email_id = se.id AND js.on_success_state = 'pending');
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS jmap_mailbox_message_state_update;
--> statement-breakpoint
CREATE TRIGGER jmap_mailbox_message_state_update
AFTER UPDATE ON mailbox_message_state
BEGIN
  INSERT INTO jmap_changes (object_type, object_id, inbox, user_id, op, created_at)
  SELECT 'email', 'received:' || NEW.message_id, e.recipient, NULL, 'u', CAST(strftime('%s','now') AS INTEGER)
  FROM emails e
  WHERE NEW.message_kind = 'received' AND e.id = NEW.message_id
  UNION ALL
  SELECT 'email', COALESCE('draft:' || se.jmap_email_id, 'sent:' || se.id), se.from_address, NULL, 'u', CAST(strftime('%s','now') AS INTEGER)
  FROM sent_emails se
  WHERE NEW.message_kind = 'sent' AND se.id = NEW.message_id
    AND NOT EXISTS (SELECT 1 FROM jmap_submissions js WHERE js.sent_email_id = se.id AND js.on_success_state = 'pending');
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS jmap_mailbox_message_state_delete;
--> statement-breakpoint
CREATE TRIGGER jmap_mailbox_message_state_delete
AFTER DELETE ON mailbox_message_state
BEGIN
  INSERT INTO jmap_changes (object_type, object_id, inbox, user_id, op, created_at)
  SELECT 'email', 'received:' || OLD.message_id, e.recipient, NULL, 'u', CAST(strftime('%s','now') AS INTEGER)
  FROM emails e
  WHERE OLD.message_kind = 'received' AND e.id = OLD.message_id
  UNION ALL
  SELECT 'email', COALESCE('draft:' || se.jmap_email_id, 'sent:' || se.id), se.from_address, NULL, 'u', CAST(strftime('%s','now') AS INTEGER)
  FROM sent_emails se
  WHERE OLD.message_kind = 'sent' AND se.id = OLD.message_id
    AND NOT EXISTS (SELECT 1 FROM jmap_submissions js WHERE js.sent_email_id = se.id AND js.on_success_state = 'pending');
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS jmap_message_mailboxes_insert;
--> statement-breakpoint
CREATE TRIGGER jmap_message_mailboxes_insert
AFTER INSERT ON message_mailboxes
BEGIN
  INSERT INTO jmap_changes (object_type, object_id, inbox, user_id, op, created_at)
  SELECT 'email', 'received:' || NEW.message_id, e.recipient, NULL, 'u', CAST(strftime('%s','now') AS INTEGER)
  FROM emails e
  WHERE NEW.message_kind = 'received' AND e.id = NEW.message_id
  UNION ALL
  SELECT 'email', COALESCE('draft:' || se.jmap_email_id, 'sent:' || se.id), se.from_address, NULL, 'u', CAST(strftime('%s','now') AS INTEGER)
  FROM sent_emails se
  WHERE NEW.message_kind = 'sent' AND se.id = NEW.message_id
    AND NOT EXISTS (SELECT 1 FROM jmap_submissions js WHERE js.sent_email_id = se.id AND js.on_success_state = 'pending');
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS jmap_message_mailboxes_update;
--> statement-breakpoint
CREATE TRIGGER jmap_message_mailboxes_update
AFTER UPDATE ON message_mailboxes
BEGIN
  INSERT INTO jmap_changes (object_type, object_id, inbox, user_id, op, created_at)
  SELECT 'email', 'received:' || NEW.message_id, e.recipient, NULL, 'u', CAST(strftime('%s','now') AS INTEGER)
  FROM emails e
  WHERE NEW.message_kind = 'received' AND e.id = NEW.message_id
  UNION ALL
  SELECT 'email', COALESCE('draft:' || se.jmap_email_id, 'sent:' || se.id), se.from_address, NULL, 'u', CAST(strftime('%s','now') AS INTEGER)
  FROM sent_emails se
  WHERE NEW.message_kind = 'sent' AND se.id = NEW.message_id
    AND NOT EXISTS (SELECT 1 FROM jmap_submissions js WHERE js.sent_email_id = se.id AND js.on_success_state = 'pending');
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS jmap_message_mailboxes_delete;
--> statement-breakpoint
CREATE TRIGGER jmap_message_mailboxes_delete
AFTER DELETE ON message_mailboxes
BEGIN
  INSERT INTO jmap_changes (object_type, object_id, inbox, user_id, op, created_at)
  SELECT 'email', 'received:' || OLD.message_id, e.recipient, NULL, 'u', CAST(strftime('%s','now') AS INTEGER)
  FROM emails e
  WHERE OLD.message_kind = 'received' AND e.id = OLD.message_id
  UNION ALL
  SELECT 'email', COALESCE('draft:' || se.jmap_email_id, 'sent:' || se.id), se.from_address, NULL, 'u', CAST(strftime('%s','now') AS INTEGER)
  FROM sent_emails se
  WHERE OLD.message_kind = 'sent' AND se.id = OLD.message_id
    AND NOT EXISTS (SELECT 1 FROM jmap_submissions js WHERE js.sent_email_id = se.id AND js.on_success_state = 'pending');
END;
--> statement-breakpoint
-- The alias deletes the draft row but the Email lives on as a Sent Email, so
-- that delete must not tell clients the Email was destroyed. Body copied from
-- PR 4's jmap_drafts_delete; only the WHEN clause is new.
DROP TRIGGER IF EXISTS jmap_drafts_delete;
--> statement-breakpoint
CREATE TRIGGER jmap_drafts_delete
AFTER DELETE ON jmap_drafts
WHEN OLD.alias_delete = 0
BEGIN
  INSERT INTO jmap_changes (object_type, object_id, inbox, user_id, op, created_at)
  VALUES ('email', 'draft:' || OLD.id, OLD.inbox, OLD.user_id, 'd', CAST(strftime('%s','now') AS INTEGER));
END;
