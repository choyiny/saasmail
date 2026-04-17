-- Demo seed data for local development.
-- Run: yarn db:seed:dev
-- Safe to re-run: uses INSERT OR REPLACE with stable IDs.
--
-- Populates: sender_identities (inboxes), people, emails (inbound), sent_emails (replies).
-- Timestamps are expressed as ms since epoch, anchored to `now` so recency sorts sensibly.

-- ----------------------------------------------------------------------------
-- Inboxes (admin-configured display names)
-- ----------------------------------------------------------------------------
INSERT OR REPLACE INTO sender_identities (email, display_name, created_at, updated_at) VALUES
  ('support@example.com', 'Support',   CAST(strftime('%s','now') AS INTEGER) * 1000, CAST(strftime('%s','now') AS INTEGER) * 1000),
  ('sales@example.com',   'Sales',     CAST(strftime('%s','now') AS INTEGER) * 1000, CAST(strftime('%s','now') AS INTEGER) * 1000),
  ('hello@example.com',   'General',   CAST(strftime('%s','now') AS INTEGER) * 1000, CAST(strftime('%s','now') AS INTEGER) * 1000);

-- ----------------------------------------------------------------------------
-- People (senders who have emailed us)
-- last_email_at / unread_count / total_count are recomputed below after emails insert.
-- ----------------------------------------------------------------------------
INSERT OR REPLACE INTO people (id, email, name, last_email_at, unread_count, total_count, created_at, updated_at) VALUES
  ('p_alice',   'alice.nguyen@acme.co',     'Alice Nguyen',   0, 0, 0, (CAST(strftime('%s','now') AS INTEGER) - 86400 * 14) * 1000, CAST(strftime('%s','now') AS INTEGER) * 1000),
  ('p_bob',     'bob@globex.io',            'Bob Martinez',   0, 0, 0, (CAST(strftime('%s','now') AS INTEGER) - 86400 * 10) * 1000, CAST(strftime('%s','now') AS INTEGER) * 1000),
  ('p_carla',   'carla@initech.dev',        'Carla Schmidt',  0, 0, 0, (CAST(strftime('%s','now') AS INTEGER) - 86400 * 8)  * 1000, CAST(strftime('%s','now') AS INTEGER) * 1000),
  ('p_dan',     'dan@hooli.com',            'Dan Park',       0, 0, 0, (CAST(strftime('%s','now') AS INTEGER) - 86400 * 6)  * 1000, CAST(strftime('%s','now') AS INTEGER) * 1000),
  ('p_eve',     'eve@piedpiper.ai',         'Eve Johansson',  0, 0, 0, (CAST(strftime('%s','now') AS INTEGER) - 86400 * 4)  * 1000, CAST(strftime('%s','now') AS INTEGER) * 1000),
  ('p_frank',   'frank.liu@soylent.corp',   'Frank Liu',      0, 0, 0, (CAST(strftime('%s','now') AS INTEGER) - 86400 * 3)  * 1000, CAST(strftime('%s','now') AS INTEGER) * 1000),
  ('p_grace',   'grace@dundermifflin.com',  'Grace Okafor',   0, 0, 0, (CAST(strftime('%s','now') AS INTEGER) - 86400 * 2)  * 1000, CAST(strftime('%s','now') AS INTEGER) * 1000),
  ('p_henry',   'henry@wayne.enterprises',  'Henry Wayne',    0, 0, 0, (CAST(strftime('%s','now') AS INTEGER) - 86400 * 1)  * 1000, CAST(strftime('%s','now') AS INTEGER) * 1000);

-- ----------------------------------------------------------------------------
-- Inbound emails
-- receivedAt is offset from now. is_read: 0 = unread, 1 = read.
-- ----------------------------------------------------------------------------
INSERT OR REPLACE INTO emails (id, person_id, recipient, subject, body_html, body_text, raw_headers, message_id, spf, dkim, dmarc, is_read, received_at, created_at) VALUES
  -- Alice — two-message thread, both read
  ('e_alice_1', 'p_alice', 'support@example.com',
    'Trouble logging in on mobile',
    '<p>Hi team,</p><p>I can''t log into the iOS app after the latest update — it just hangs on the spinner. Desktop works fine.</p><p>Thanks,<br/>Alice</p>',
    'Hi team, I can''t log into the iOS app after the latest update — it just hangs on the spinner. Desktop works fine. Thanks, Alice',
    '{}', '<alice-1@acme.co>', 'pass', 'pass', 'pass',
    1, (CAST(strftime('%s','now') AS INTEGER) - 86400 * 13) * 1000, (CAST(strftime('%s','now') AS INTEGER) - 86400 * 13) * 1000),
  ('e_alice_2', 'p_alice', 'support@example.com',
    'Re: Trouble logging in on mobile',
    '<p>That worked — thank you! Force-quitting and reinstalling fixed it.</p>',
    'That worked — thank you! Force-quitting and reinstalling fixed it.',
    '{}', '<alice-2@acme.co>', 'pass', 'pass', 'pass',
    1, (CAST(strftime('%s','now') AS INTEGER) - 86400 * 12) * 1000, (CAST(strftime('%s','now') AS INTEGER) - 86400 * 12) * 1000),

  -- Bob — single message, unread
  ('e_bob_1', 'p_bob', 'sales@example.com',
    'Enterprise pricing question',
    '<p>Hey,</p><p>We''re evaluating a few tools for our team of 50. Could you share your enterprise pricing and whether SSO is included?</p><p>— Bob, Globex</p>',
    'Hey, We''re evaluating a few tools for our team of 50. Could you share your enterprise pricing and whether SSO is included? — Bob, Globex',
    '{}', '<bob-1@globex.io>', 'pass', 'pass', 'pass',
    0, (CAST(strftime('%s','now') AS INTEGER) - 86400 * 10) * 1000, (CAST(strftime('%s','now') AS INTEGER) - 86400 * 10) * 1000),

  -- Carla — 3-message thread, last one unread
  ('e_carla_1', 'p_carla', 'support@example.com',
    'Webhook deliveries failing intermittently',
    '<p>We''re seeing 504s on about 3% of webhook deliveries. Attaching a sample request ID. Any ideas?</p>',
    'We''re seeing 504s on about 3% of webhook deliveries. Attaching a sample request ID. Any ideas?',
    '{}', '<carla-1@initech.dev>', 'pass', 'pass', 'pass',
    1, (CAST(strftime('%s','now') AS INTEGER) - 86400 * 8) * 1000, (CAST(strftime('%s','now') AS INTEGER) - 86400 * 8) * 1000),
  ('e_carla_2', 'p_carla', 'support@example.com',
    'Re: Webhook deliveries failing intermittently',
    '<p>Tried the retry flag — still seeing it on the same three endpoints. Here are the latest IDs.</p>',
    'Tried the retry flag — still seeing it on the same three endpoints. Here are the latest IDs.',
    '{}', '<carla-2@initech.dev>', 'pass', 'pass', 'pass',
    1, (CAST(strftime('%s','now') AS INTEGER) - 86400 * 7) * 1000, (CAST(strftime('%s','now') AS INTEGER) - 86400 * 7) * 1000),
  ('e_carla_3', 'p_carla', 'support@example.com',
    'Re: Webhook deliveries failing intermittently',
    '<p>Any update on this? We''re planning a release next week and this is blocking.</p>',
    'Any update on this? We''re planning a release next week and this is blocking.',
    '{}', '<carla-3@initech.dev>', 'pass', 'pass', 'pass',
    0, (CAST(strftime('%s','now') AS INTEGER) - 86400 * 2 - 3600 * 5) * 1000, (CAST(strftime('%s','now') AS INTEGER) - 86400 * 2 - 3600 * 5) * 1000),

  -- Dan — single message to general, read
  ('e_dan_1', 'p_dan', 'hello@example.com',
    'Partnership inquiry',
    '<p>Hi,</p><p>I lead BD at Hooli. Would love to chat about a co-marketing opportunity next quarter. Do you have 20 min this week?</p><p>Dan</p>',
    'Hi, I lead BD at Hooli. Would love to chat about a co-marketing opportunity next quarter. Do you have 20 min this week? Dan',
    '{}', '<dan-1@hooli.com>', 'pass', 'pass', 'pass',
    1, (CAST(strftime('%s','now') AS INTEGER) - 86400 * 6) * 1000, (CAST(strftime('%s','now') AS INTEGER) - 86400 * 6) * 1000),

  -- Eve — unread, recent, sales
  ('e_eve_1', 'p_eve', 'sales@example.com',
    'Annual contract renewal',
    '<p>Our contract comes up in 30 days. Can someone send the renewal docs and a summary of the plan changes since last year?</p>',
    'Our contract comes up in 30 days. Can someone send the renewal docs and a summary of the plan changes since last year?',
    '{}', '<eve-1@piedpiper.ai>', 'pass', 'pass', 'pass',
    0, (CAST(strftime('%s','now') AS INTEGER) - 86400 * 4) * 1000, (CAST(strftime('%s','now') AS INTEGER) - 86400 * 4) * 1000),

  -- Frank — 2-message thread, both read
  ('e_frank_1', 'p_frank', 'support@example.com',
    'Feature request: CSV export',
    '<p>Would be a huge help for our ops team to export the people list as CSV — any ETA on this?</p>',
    'Would be a huge help for our ops team to export the people list as CSV — any ETA on this?',
    '{}', '<frank-1@soylent.corp>', 'pass', 'pass', 'pass',
    1, (CAST(strftime('%s','now') AS INTEGER) - 86400 * 3) * 1000, (CAST(strftime('%s','now') AS INTEGER) - 86400 * 3) * 1000),
  ('e_frank_2', 'p_frank', 'support@example.com',
    'Re: Feature request: CSV export',
    '<p>Great, thanks for the workaround via the API. I''ll try that today.</p>',
    'Great, thanks for the workaround via the API. I''ll try that today.',
    '{}', '<frank-2@soylent.corp>', 'pass', 'pass', 'pass',
    1, (CAST(strftime('%s','now') AS INTEGER) - 86400 * 2 - 3600 * 8) * 1000, (CAST(strftime('%s','now') AS INTEGER) - 86400 * 2 - 3600 * 8) * 1000),

  -- Grace — unread, yesterday
  ('e_grace_1', 'p_grace', 'hello@example.com',
    'Press inquiry — 5-min quote',
    '<p>I''m writing for The Paper about developer infra trends. Could someone send a quote on how you''re thinking about email-as-a-platform? Deadline EOD Friday.</p>',
    'I''m writing for The Paper about developer infra trends. Could someone send a quote on how you''re thinking about email-as-a-platform? Deadline EOD Friday.',
    '{}', '<grace-1@dundermifflin.com>', 'pass', 'pass', 'pass',
    0, (CAST(strftime('%s','now') AS INTEGER) - 86400 * 1 - 3600 * 4) * 1000, (CAST(strftime('%s','now') AS INTEGER) - 86400 * 1 - 3600 * 4) * 1000),

  -- Henry — most recent, unread
  ('e_henry_1', 'p_henry', 'sales@example.com',
    'Pilot program — start next Monday?',
    '<p>Team loved the demo. We''d like to kick off a 30-day pilot starting next Monday with 10 seats. Who do I loop in to get an order form?</p><p>— Henry</p>',
    'Team loved the demo. We''d like to kick off a 30-day pilot starting next Monday with 10 seats. Who do I loop in to get an order form? — Henry',
    '{}', '<henry-1@wayne.enterprises>', 'pass', 'pass', 'pass',
    0, (CAST(strftime('%s','now') AS INTEGER) - 3600 * 2) * 1000, (CAST(strftime('%s','now') AS INTEGER) - 3600 * 2) * 1000);

-- ----------------------------------------------------------------------------
-- Sent emails (our replies)
-- ----------------------------------------------------------------------------
INSERT OR REPLACE INTO sent_emails (id, person_id, from_address, to_address, subject, body_html, body_text, in_reply_to, resend_id, status, sent_at, created_at) VALUES
  ('s_alice_1', 'p_alice', 'support@example.com', 'alice.nguyen@acme.co',
    'Re: Trouble logging in on mobile',
    '<p>Hi Alice, sorry about that! Could you try force-quitting the app and reinstalling? There was a caching bug in the previous build.</p>',
    'Hi Alice, sorry about that! Could you try force-quitting the app and reinstalling? There was a caching bug in the previous build.',
    '<alice-1@acme.co>', NULL, 'sent',
    (CAST(strftime('%s','now') AS INTEGER) - 86400 * 13 + 3600 * 2) * 1000,
    (CAST(strftime('%s','now') AS INTEGER) - 86400 * 13 + 3600 * 2) * 1000),

  ('s_carla_1', 'p_carla', 'support@example.com', 'carla@initech.dev',
    'Re: Webhook deliveries failing intermittently',
    '<p>Hi Carla — pulled the IDs. Looks like a regional timeout issue. We''ve shipped a retry flag; try setting <code>x-cmail-retry: true</code> on your callback.</p>',
    'Hi Carla — pulled the IDs. Looks like a regional timeout issue. We''ve shipped a retry flag; try setting x-cmail-retry: true on your callback.',
    '<carla-1@initech.dev>', NULL, 'sent',
    (CAST(strftime('%s','now') AS INTEGER) - 86400 * 7 + 3600 * 4) * 1000,
    (CAST(strftime('%s','now') AS INTEGER) - 86400 * 7 + 3600 * 4) * 1000),

  ('s_frank_1', 'p_frank', 'support@example.com', 'frank.liu@soylent.corp',
    'Re: Feature request: CSV export',
    '<p>Hey Frank — no ETA on a UI button yet, but <code>GET /api/people?format=csv</code> works today if you have an API key. Happy to send snippets.</p>',
    'Hey Frank — no ETA on a UI button yet, but GET /api/people?format=csv works today if you have an API key. Happy to send snippets.',
    '<frank-1@soylent.corp>', NULL, 'sent',
    (CAST(strftime('%s','now') AS INTEGER) - 86400 * 2 - 3600 * 12) * 1000,
    (CAST(strftime('%s','now') AS INTEGER) - 86400 * 2 - 3600 * 12) * 1000);

-- ----------------------------------------------------------------------------
-- Recompute people.last_email_at / unread_count / total_count from the emails
-- we just inserted. This keeps the list view consistent with the actual data.
-- ----------------------------------------------------------------------------
UPDATE people
SET
  last_email_at = COALESCE((SELECT MAX(received_at) FROM emails WHERE person_id = people.id), last_email_at),
  unread_count  = (SELECT COUNT(*) FROM emails WHERE person_id = people.id AND is_read = 0),
  total_count   = (SELECT COUNT(*) FROM emails WHERE person_id = people.id),
  updated_at    = CAST(strftime('%s','now') AS INTEGER) * 1000;
