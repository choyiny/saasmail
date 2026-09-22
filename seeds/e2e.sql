-- E2E seed data: inboxes + people + inbound emails.
-- Users are created via HTTP APIs in e2e/global-setup.ts.

-- Clean tables (idempotent for repeated runs)
DELETE FROM sequence_emails;
DELETE FROM sequence_enrollments;
DELETE FROM sequences;
DELETE FROM api_keys;
DELETE FROM email_templates;
DELETE FROM invitations;
DELETE FROM message_mailboxes;
DELETE FROM mailboxes;
DELETE FROM message_user_state;
DELETE FROM mailbox_message_state;
DELETE FROM inbox_conversation_state;
DELETE FROM emails;
DELETE FROM sent_emails;
DELETE FROM people;
DELETE FROM inbox_permissions;
DELETE FROM sender_identities;

-- Inboxes
INSERT INTO sender_identities (email, display_name, display_mode, created_at, updated_at)
VALUES
  ('marketing@e2e.test', 'Marketing', 'thread', CAST(strftime('%s','now') AS INTEGER), CAST(strftime('%s','now') AS INTEGER)),
  ('support@e2e.test',   'Support',   'chat',   CAST(strftime('%s','now') AS INTEGER), CAST(strftime('%s','now') AS INTEGER));

-- People
INSERT INTO people (id, email, name, last_email_at, unread_count, total_count, created_at, updated_at)
VALUES
  ('p_alice',   'alice@customers.test',   'Alice Anderson', CAST(strftime('%s','now') AS INTEGER), 2, 4, CAST(strftime('%s','now') AS INTEGER), CAST(strftime('%s','now') AS INTEGER)),
  ('p_bob',     'bob@customers.test',     'Bob Brown',      CAST(strftime('%s','now') AS INTEGER), 2, 4, CAST(strftime('%s','now') AS INTEGER), CAST(strftime('%s','now') AS INTEGER)),
  ('p_mailbox', 'mailbox@customers.test', 'Mailbox Fixture', CAST(strftime('%s','now') AS INTEGER), 2, 3, CAST(strftime('%s','now') AS INTEGER), CAST(strftime('%s','now') AS INTEGER));

-- Inbound emails. Two per (person, inbox) so display specs have thread context.
INSERT INTO emails (id, person_id, recipient, subject, body_html, body_text, message_id, is_read, received_at, created_at)
VALUES
  ('e_m_a1', 'p_alice', 'marketing@e2e.test', 'Welcome to our product',         '<p>Hi Alice,</p><p>Welcome aboard!</p>',                                                                     'welcome', 'mid_m_a1', 0, CAST(strftime('%s','now') AS INTEGER) - 3600000, CAST(strftime('%s','now') AS INTEGER) - 3600000),
  ('e_m_a2', 'p_alice', 'marketing@e2e.test', 'Re: Welcome to our product',      '<p>Thanks for signing up!</p><blockquote>On date, we wrote: Hi Alice</blockquote>',                         'thanks',  'mid_m_a2', 0, CAST(strftime('%s','now') AS INTEGER) - 1800000, CAST(strftime('%s','now') AS INTEGER) - 1800000),
  ('e_m_b1', 'p_bob',   'marketing@e2e.test', 'Your trial is ending',            '<p>Hi Bob,</p><p>Your trial ends in 3 days.</p>',                                                           'trial',   'mid_m_b1', 0, CAST(strftime('%s','now') AS INTEGER) - 7200000, CAST(strftime('%s','now') AS INTEGER) - 7200000),
  ('e_m_b2', 'p_bob',   'marketing@e2e.test', 'Re: Your trial is ending',        '<p>I want to upgrade.</p><blockquote>On date, Bob wrote: trial</blockquote>',                               'upgrade', 'mid_m_b2', 0, CAST(strftime('%s','now') AS INTEGER) - 3600000, CAST(strftime('%s','now') AS INTEGER) - 3600000),
  ('e_s_a1', 'p_alice', 'support@e2e.test',   'Help with login',                 '<p>I can''t log in.</p>',                                                                                   'login',   'mid_s_a1', 0, CAST(strftime('%s','now') AS INTEGER) - 3600000, CAST(strftime('%s','now') AS INTEGER) - 3600000),
  ('e_s_a2', 'p_alice', 'support@e2e.test',   'Re: Help with login',             '<p>Tried that, still broken.</p>',                                                                          'still',   'mid_s_a2', 0, CAST(strftime('%s','now') AS INTEGER) - 1800000, CAST(strftime('%s','now') AS INTEGER) - 1800000),
  ('e_s_b1', 'p_bob',     'support@e2e.test', 'Billing question',                '<p>What''s this charge?</p>',                                                                               'charge',  'mid_s_b1', 0, CAST(strftime('%s','now') AS INTEGER) - 7200000, CAST(strftime('%s','now') AS INTEGER) - 7200000),
  ('e_s_b2', 'p_bob',     'support@e2e.test', 'Re: Billing question',            '<p>Thanks, that clears it up.</p>',                                                                         'clears',  'mid_s_b2', 0, CAST(strftime('%s','now') AS INTEGER) - 3600000, CAST(strftime('%s','now') AS INTEGER) - 3600000),
  ('e_mailbox_1', 'p_mailbox', 'support@e2e.test', 'Mailbox fixture message',     '<p>Mailbox-only received message.</p>',                                                                      'mailbox received', 'mid_mailbox_1', 0, CAST(strftime('%s','now') AS INTEGER) - 1200, CAST(strftime('%s','now') AS INTEGER) - 1200),
  ('e_mailbox_2', 'p_mailbox', 'support@e2e.test', 'Mailbox bulk second',         '<p>Second mailbox-only received message.</p>',                                                               'mailbox bulk second', 'mid_mailbox_2', 0, CAST(strftime('%s','now') AS INTEGER) - 600, CAST(strftime('%s','now') AS INTEGER) - 600);


-- One sent message for the conventional mailbox Sent-folder flow.
INSERT INTO sent_emails (
  id, person_id, from_address, to_address, subject, body_html, body_text,
  message_id, status, sent_at, created_at
)
VALUES (
  's_mailbox_1',
  'p_mailbox',
  'support@e2e.test',
  'mailbox@customers.test',
  'Mailbox fixture message',
  '<p>Mailbox-only sent message.</p>',
  'Mailbox-only sent message.',
  'sent_mailbox_1',
  'sent',
  CAST(strftime('%s','now') AS INTEGER) - 900,
  CAST(strftime('%s','now') AS INTEGER) - 900
);
