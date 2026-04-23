-- FTS5 virtual table for full-text search across email subject and body.
-- Uses emails as a content table so text is not duplicated on disk.
-- Triggers keep the index in sync with the emails table.
CREATE VIRTUAL TABLE emails_fts USING fts5(
  subject,
  body_text,
  content='emails',
  content_rowid='rowid'
);

-- Backfill existing emails into the index
INSERT INTO emails_fts(rowid, subject, body_text)
SELECT rowid, subject, body_text FROM emails;

CREATE TRIGGER emails_fts_ai AFTER INSERT ON emails BEGIN
  INSERT INTO emails_fts(rowid, subject, body_text)
  VALUES (new.rowid, new.subject, new.body_text);
END;

CREATE TRIGGER emails_fts_ad AFTER DELETE ON emails BEGIN
  INSERT INTO emails_fts(emails_fts, rowid, subject, body_text)
  VALUES ('delete', old.rowid, old.subject, old.body_text);
END;

CREATE TRIGGER emails_fts_au AFTER UPDATE ON emails BEGIN
  INSERT INTO emails_fts(emails_fts, rowid, subject, body_text)
  VALUES ('delete', old.rowid, old.subject, old.body_text);
  INSERT INTO emails_fts(rowid, subject, body_text)
  VALUES (new.rowid, new.subject, new.body_text);
END;
