CREATE TABLE `jmap_changes` (
  `seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `object_type` text NOT NULL,
  `object_id` text NOT NULL,
  `inbox` text,
  `user_id` text,
  `op` text NOT NULL,
  `created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `jmap_changes_inbox_user_seq_idx` ON `jmap_changes` (`inbox`,`user_id`,`seq`);
--> statement-breakpoint
CREATE INDEX `jmap_changes_user_seq_idx` ON `jmap_changes` (`user_id`,`seq`);
--> statement-breakpoint
CREATE INDEX `jmap_changes_created_at_idx` ON `jmap_changes` (`created_at`);
--> statement-breakpoint
CREATE TRIGGER jmap_emails_insert
AFTER INSERT ON emails
BEGIN
  INSERT INTO jmap_changes (object_type, object_id, inbox, user_id, op, created_at)
  VALUES ('email', 'received:' || NEW.id, NEW.recipient, NULL, 'c', CAST(strftime('%s','now') AS INTEGER));
END;
--> statement-breakpoint
CREATE TRIGGER jmap_emails_update
AFTER UPDATE ON emails
BEGIN
  INSERT INTO jmap_changes (object_type, object_id, inbox, user_id, op, created_at)
  VALUES ('email', 'received:' || NEW.id, NEW.recipient, NULL, 'u', CAST(strftime('%s','now') AS INTEGER));
END;
--> statement-breakpoint
CREATE TRIGGER jmap_emails_delete
AFTER DELETE ON emails
BEGIN
  INSERT INTO jmap_changes (object_type, object_id, inbox, user_id, op, created_at)
  VALUES ('email', 'received:' || OLD.id, OLD.recipient, NULL, 'd', CAST(strftime('%s','now') AS INTEGER));
END;
--> statement-breakpoint
CREATE TRIGGER jmap_sent_emails_insert
AFTER INSERT ON sent_emails
BEGIN
  INSERT INTO jmap_changes (object_type, object_id, inbox, user_id, op, created_at)
  VALUES ('email', 'sent:' || NEW.id, NEW.from_address, NULL, 'c', CAST(strftime('%s','now') AS INTEGER));
END;
--> statement-breakpoint
CREATE TRIGGER jmap_sent_emails_update
AFTER UPDATE ON sent_emails
BEGIN
  INSERT INTO jmap_changes (object_type, object_id, inbox, user_id, op, created_at)
  VALUES ('email', 'sent:' || NEW.id, NEW.from_address, NULL, 'u', CAST(strftime('%s','now') AS INTEGER));
END;
--> statement-breakpoint
CREATE TRIGGER jmap_sent_emails_delete
AFTER DELETE ON sent_emails
BEGIN
  INSERT INTO jmap_changes (object_type, object_id, inbox, user_id, op, created_at)
  VALUES ('email', 'sent:' || OLD.id, OLD.from_address, NULL, 'd', CAST(strftime('%s','now') AS INTEGER));
END;
--> statement-breakpoint
CREATE TRIGGER jmap_message_user_state_insert
AFTER INSERT ON message_user_state
BEGIN
  INSERT INTO jmap_changes (object_type, object_id, inbox, user_id, op, created_at)
  SELECT 'email', 'received:' || NEW.message_id, e.recipient, NEW.user_id, 'u', CAST(strftime('%s','now') AS INTEGER)
  FROM emails e
  WHERE NEW.message_kind = 'received' AND e.id = NEW.message_id
  UNION ALL
  SELECT 'email', 'sent:' || NEW.message_id, se.from_address, NEW.user_id, 'u', CAST(strftime('%s','now') AS INTEGER)
  FROM sent_emails se
  WHERE NEW.message_kind = 'sent' AND se.id = NEW.message_id;
END;
--> statement-breakpoint
CREATE TRIGGER jmap_message_user_state_update
AFTER UPDATE ON message_user_state
BEGIN
  INSERT INTO jmap_changes (object_type, object_id, inbox, user_id, op, created_at)
  SELECT 'email', 'received:' || NEW.message_id, e.recipient, NEW.user_id, 'u', CAST(strftime('%s','now') AS INTEGER)
  FROM emails e
  WHERE NEW.message_kind = 'received' AND e.id = NEW.message_id
  UNION ALL
  SELECT 'email', 'sent:' || NEW.message_id, se.from_address, NEW.user_id, 'u', CAST(strftime('%s','now') AS INTEGER)
  FROM sent_emails se
  WHERE NEW.message_kind = 'sent' AND se.id = NEW.message_id;
END;
--> statement-breakpoint
CREATE TRIGGER jmap_message_user_state_delete
AFTER DELETE ON message_user_state
BEGIN
  INSERT INTO jmap_changes (object_type, object_id, inbox, user_id, op, created_at)
  SELECT 'email', 'received:' || OLD.message_id, e.recipient, OLD.user_id, 'u', CAST(strftime('%s','now') AS INTEGER)
  FROM emails e
  WHERE OLD.message_kind = 'received' AND e.id = OLD.message_id
  UNION ALL
  SELECT 'email', 'sent:' || OLD.message_id, se.from_address, OLD.user_id, 'u', CAST(strftime('%s','now') AS INTEGER)
  FROM sent_emails se
  WHERE OLD.message_kind = 'sent' AND se.id = OLD.message_id;
END;
--> statement-breakpoint
CREATE TRIGGER jmap_mailbox_message_state_insert
AFTER INSERT ON mailbox_message_state
BEGIN
  INSERT INTO jmap_changes (object_type, object_id, inbox, user_id, op, created_at)
  SELECT 'email', 'received:' || NEW.message_id, e.recipient, NULL, 'u', CAST(strftime('%s','now') AS INTEGER)
  FROM emails e
  WHERE NEW.message_kind = 'received' AND e.id = NEW.message_id
  UNION ALL
  SELECT 'email', 'sent:' || NEW.message_id, se.from_address, NULL, 'u', CAST(strftime('%s','now') AS INTEGER)
  FROM sent_emails se
  WHERE NEW.message_kind = 'sent' AND se.id = NEW.message_id;
END;
--> statement-breakpoint
CREATE TRIGGER jmap_mailbox_message_state_update
AFTER UPDATE ON mailbox_message_state
BEGIN
  INSERT INTO jmap_changes (object_type, object_id, inbox, user_id, op, created_at)
  SELECT 'email', 'received:' || NEW.message_id, e.recipient, NULL, 'u', CAST(strftime('%s','now') AS INTEGER)
  FROM emails e
  WHERE NEW.message_kind = 'received' AND e.id = NEW.message_id
  UNION ALL
  SELECT 'email', 'sent:' || NEW.message_id, se.from_address, NULL, 'u', CAST(strftime('%s','now') AS INTEGER)
  FROM sent_emails se
  WHERE NEW.message_kind = 'sent' AND se.id = NEW.message_id;
END;
--> statement-breakpoint
CREATE TRIGGER jmap_mailbox_message_state_delete
AFTER DELETE ON mailbox_message_state
BEGIN
  INSERT INTO jmap_changes (object_type, object_id, inbox, user_id, op, created_at)
  SELECT 'email', 'received:' || OLD.message_id, e.recipient, NULL, 'u', CAST(strftime('%s','now') AS INTEGER)
  FROM emails e
  WHERE OLD.message_kind = 'received' AND e.id = OLD.message_id
  UNION ALL
  SELECT 'email', 'sent:' || OLD.message_id, se.from_address, NULL, 'u', CAST(strftime('%s','now') AS INTEGER)
  FROM sent_emails se
  WHERE OLD.message_kind = 'sent' AND se.id = OLD.message_id;
END;
--> statement-breakpoint
CREATE TRIGGER jmap_message_mailboxes_insert
AFTER INSERT ON message_mailboxes
BEGIN
  INSERT INTO jmap_changes (object_type, object_id, inbox, user_id, op, created_at)
  SELECT 'email', 'received:' || NEW.message_id, e.recipient, NULL, 'u', CAST(strftime('%s','now') AS INTEGER)
  FROM emails e
  WHERE NEW.message_kind = 'received' AND e.id = NEW.message_id
  UNION ALL
  SELECT 'email', 'sent:' || NEW.message_id, se.from_address, NULL, 'u', CAST(strftime('%s','now') AS INTEGER)
  FROM sent_emails se
  WHERE NEW.message_kind = 'sent' AND se.id = NEW.message_id;
END;
--> statement-breakpoint
CREATE TRIGGER jmap_message_mailboxes_update
AFTER UPDATE ON message_mailboxes
BEGIN
  INSERT INTO jmap_changes (object_type, object_id, inbox, user_id, op, created_at)
  SELECT 'email', 'received:' || NEW.message_id, e.recipient, NULL, 'u', CAST(strftime('%s','now') AS INTEGER)
  FROM emails e
  WHERE NEW.message_kind = 'received' AND e.id = NEW.message_id
  UNION ALL
  SELECT 'email', 'sent:' || NEW.message_id, se.from_address, NULL, 'u', CAST(strftime('%s','now') AS INTEGER)
  FROM sent_emails se
  WHERE NEW.message_kind = 'sent' AND se.id = NEW.message_id;
END;
--> statement-breakpoint
CREATE TRIGGER jmap_message_mailboxes_delete
AFTER DELETE ON message_mailboxes
BEGIN
  INSERT INTO jmap_changes (object_type, object_id, inbox, user_id, op, created_at)
  SELECT 'email', 'received:' || OLD.message_id, e.recipient, NULL, 'u', CAST(strftime('%s','now') AS INTEGER)
  FROM emails e
  WHERE OLD.message_kind = 'received' AND e.id = OLD.message_id
  UNION ALL
  SELECT 'email', 'sent:' || OLD.message_id, se.from_address, NULL, 'u', CAST(strftime('%s','now') AS INTEGER)
  FROM sent_emails se
  WHERE OLD.message_kind = 'sent' AND se.id = OLD.message_id;
END;
--> statement-breakpoint
CREATE TRIGGER jmap_mailboxes_insert
AFTER INSERT ON mailboxes
BEGIN
  INSERT INTO jmap_changes (object_type, object_id, inbox, user_id, op, created_at)
  VALUES ('mailbox', 'mbx:' || NEW.id, NEW.inbox, NULL, 'c', CAST(strftime('%s','now') AS INTEGER));
END;
--> statement-breakpoint
CREATE TRIGGER jmap_mailboxes_update
AFTER UPDATE ON mailboxes
BEGIN
  INSERT INTO jmap_changes (object_type, object_id, inbox, user_id, op, created_at)
  VALUES ('mailbox', 'mbx:' || NEW.id, NEW.inbox, NULL, 'u', CAST(strftime('%s','now') AS INTEGER));
END;
--> statement-breakpoint
CREATE TRIGGER jmap_mailboxes_delete
AFTER DELETE ON mailboxes
BEGIN
  INSERT INTO jmap_changes (object_type, object_id, inbox, user_id, op, created_at)
  VALUES ('mailbox', 'mbx:' || OLD.id, OLD.inbox, NULL, 'd', CAST(strftime('%s','now') AS INTEGER));
END;
