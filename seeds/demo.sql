-- Demo seed data for local development.
-- Run: yarn db:seed:dev
-- Safe to re-run: truncates demo tables first, then reseeds with stable IDs.
--
-- Populates: sender_identities (inboxes), people, emails (inbound), sent_emails (replies).
-- Timestamps are expressed as seconds since epoch, anchored to `now` so recency sorts sensibly.

-- ----------------------------------------------------------------------------
-- Clean demo tables so re-running yields a deterministic state. Auth tables
-- (user / session / account / verification) are intentionally preserved.
-- ----------------------------------------------------------------------------
DELETE FROM sequence_emails;
DELETE FROM sequence_enrollments;
DELETE FROM sequences;
DELETE FROM api_keys;
DELETE FROM email_templates;
DELETE FROM invitations;
DELETE FROM attachments;
DELETE FROM drafts;
DELETE FROM agent_runs;
DELETE FROM agent_assignments;
DELETE FROM agent_definitions;
DELETE FROM sent_emails;
DELETE FROM emails;
DELETE FROM people;
DELETE FROM inbox_permissions;
DELETE FROM sender_identities;

-- ----------------------------------------------------------------------------
-- Inboxes (admin-configured display names)
-- ----------------------------------------------------------------------------
INSERT OR REPLACE INTO sender_identities (email, display_name, created_at, updated_at) VALUES
  ('support@example.com',       'Support',       CAST(strftime('%s','now') AS INTEGER), CAST(strftime('%s','now') AS INTEGER)),
  ('sales@example.com',         'Sales',         CAST(strftime('%s','now') AS INTEGER), CAST(strftime('%s','now') AS INTEGER)),
  ('hello@example.com',         'General',       CAST(strftime('%s','now') AS INTEGER), CAST(strftime('%s','now') AS INTEGER)),
  ('billing@example.com',       'Billing',       CAST(strftime('%s','now') AS INTEGER), CAST(strftime('%s','now') AS INTEGER)),
  ('newsletter@example.com',    'Newsletter',    CAST(strftime('%s','now') AS INTEGER), CAST(strftime('%s','now') AS INTEGER)),
  ('notifications@example.com', 'Notifications', CAST(strftime('%s','now') AS INTEGER), CAST(strftime('%s','now') AS INTEGER));

-- ----------------------------------------------------------------------------
-- People (senders who have emailed us)
-- last_email_at / unread_count / total_count are recomputed below after emails insert.
-- ----------------------------------------------------------------------------
INSERT OR REPLACE INTO people (id, email, name, last_email_at, unread_count, total_count, created_at, updated_at) VALUES
  ('p_alice',   'alice.nguyen@acme.co',     'Alice Nguyen',   0, 0, 0, (CAST(strftime('%s','now') AS INTEGER) - 86400 * 14), CAST(strftime('%s','now') AS INTEGER)),
  ('p_bob',     'bob@globex.io',            'Bob Martinez',   0, 0, 0, (CAST(strftime('%s','now') AS INTEGER) - 86400 * 10), CAST(strftime('%s','now') AS INTEGER)),
  ('p_carla',   'carla@initech.dev',        'Carla Schmidt',  0, 0, 0, (CAST(strftime('%s','now') AS INTEGER) - 86400 * 8) , CAST(strftime('%s','now') AS INTEGER)),
  ('p_dan',     'dan@hooli.com',            'Dan Park',       0, 0, 0, (CAST(strftime('%s','now') AS INTEGER) - 86400 * 6) , CAST(strftime('%s','now') AS INTEGER)),
  ('p_eve',     'eve@piedpiper.ai',         'Eve Johansson',  0, 0, 0, (CAST(strftime('%s','now') AS INTEGER) - 86400 * 4) , CAST(strftime('%s','now') AS INTEGER)),
  ('p_frank',   'frank.liu@soylent.corp',   'Frank Liu',      0, 0, 0, (CAST(strftime('%s','now') AS INTEGER) - 86400 * 3) , CAST(strftime('%s','now') AS INTEGER)),
  ('p_grace',   'grace@dundermifflin.com',  'Grace Okafor',   0, 0, 0, (CAST(strftime('%s','now') AS INTEGER) - 86400 * 2) , CAST(strftime('%s','now') AS INTEGER)),
  ('p_henry',   'henry@wayne.enterprises',  'Henry Wayne',    0, 0, 0, (CAST(strftime('%s','now') AS INTEGER) - 86400 * 1) , CAST(strftime('%s','now') AS INTEGER)),
  ('p_iris',    'iris.chen@northwind.co',   'Iris Chen',      0, 0, 0, (CAST(strftime('%s','now') AS INTEGER) - 86400 * 20), CAST(strftime('%s','now') AS INTEGER)),
  ('p_jack',    'jack@wayne.enterprises',   'Jack Prince',    0, 0, 0, (CAST(strftime('%s','now') AS INTEGER) - 86400 * 9) , CAST(strftime('%s','now') AS INTEGER)),
  ('p_kim',     'kim.park@acme.co',         'Kim Park',       0, 0, 0, (CAST(strftime('%s','now') AS INTEGER) - 86400 * 11), CAST(strftime('%s','now') AS INTEGER)),
  ('p_leo',     'leo@initech.dev',          'Leo Novak',      0, 0, 0, (CAST(strftime('%s','now') AS INTEGER) - 86400 * 5) , CAST(strftime('%s','now') AS INTEGER));

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
    1, (CAST(strftime('%s','now') AS INTEGER) - 86400 * 13), (CAST(strftime('%s','now') AS INTEGER) - 86400 * 13)),
  ('e_alice_2', 'p_alice', 'support@example.com',
    'Re: Trouble logging in on mobile',
    '<p>That worked — thank you! Force-quitting and reinstalling fixed it.</p>',
    'That worked — thank you! Force-quitting and reinstalling fixed it.',
    '{}', '<alice-2@acme.co>', 'pass', 'pass', 'pass',
    1, (CAST(strftime('%s','now') AS INTEGER) - 86400 * 12), (CAST(strftime('%s','now') AS INTEGER) - 86400 * 12)),

  -- Bob — single message, unread
  ('e_bob_1', 'p_bob', 'sales@example.com',
    'Enterprise pricing question',
    '<p>Hey,</p><p>We''re evaluating a few tools for our team of 50. Could you share your enterprise pricing and whether SSO is included?</p><p>— Bob, Globex</p>',
    'Hey, We''re evaluating a few tools for our team of 50. Could you share your enterprise pricing and whether SSO is included? — Bob, Globex',
    '{}', '<bob-1@globex.io>', 'pass', 'pass', 'pass',
    0, (CAST(strftime('%s','now') AS INTEGER) - 86400 * 10), (CAST(strftime('%s','now') AS INTEGER) - 86400 * 10)),

  -- Carla — 3-message thread, last one unread
  ('e_carla_1', 'p_carla', 'support@example.com',
    'Webhook deliveries failing intermittently',
    '<p>We''re seeing 504s on about 3% of webhook deliveries. Attaching a sample request ID. Any ideas?</p>',
    'We''re seeing 504s on about 3% of webhook deliveries. Attaching a sample request ID. Any ideas?',
    '{}', '<carla-1@initech.dev>', 'pass', 'pass', 'pass',
    1, (CAST(strftime('%s','now') AS INTEGER) - 86400 * 8), (CAST(strftime('%s','now') AS INTEGER) - 86400 * 8)),
  ('e_carla_2', 'p_carla', 'support@example.com',
    'Re: Webhook deliveries failing intermittently',
    '<p>Tried the retry flag — still seeing it on the same three endpoints. Here are the latest IDs.</p>',
    'Tried the retry flag — still seeing it on the same three endpoints. Here are the latest IDs.',
    '{}', '<carla-2@initech.dev>', 'pass', 'pass', 'pass',
    1, (CAST(strftime('%s','now') AS INTEGER) - 86400 * 7), (CAST(strftime('%s','now') AS INTEGER) - 86400 * 7)),
  ('e_carla_3', 'p_carla', 'support@example.com',
    'Re: Webhook deliveries failing intermittently',
    '<p>Any update on this? We''re planning a release next week and this is blocking.</p>',
    'Any update on this? We''re planning a release next week and this is blocking.',
    '{}', '<carla-3@initech.dev>', 'pass', 'pass', 'pass',
    0, (CAST(strftime('%s','now') AS INTEGER) - 86400 * 2 - 3600 * 5), (CAST(strftime('%s','now') AS INTEGER) - 86400 * 2 - 3600 * 5)),

  -- Dan — single message to general, read
  ('e_dan_1', 'p_dan', 'hello@example.com',
    'Partnership inquiry',
    '<p>Hi,</p><p>I lead BD at Hooli. Would love to chat about a co-marketing opportunity next quarter. Do you have 20 min this week?</p><p>Dan</p>',
    'Hi, I lead BD at Hooli. Would love to chat about a co-marketing opportunity next quarter. Do you have 20 min this week? Dan',
    '{}', '<dan-1@hooli.com>', 'pass', 'pass', 'pass',
    1, (CAST(strftime('%s','now') AS INTEGER) - 86400 * 6), (CAST(strftime('%s','now') AS INTEGER) - 86400 * 6)),

  -- Eve — unread, recent, sales
  ('e_eve_1', 'p_eve', 'sales@example.com',
    'Annual contract renewal',
    '<p>Our contract comes up in 30 days. Can someone send the renewal docs and a summary of the plan changes since last year?</p>',
    'Our contract comes up in 30 days. Can someone send the renewal docs and a summary of the plan changes since last year?',
    '{}', '<eve-1@piedpiper.ai>', 'pass', 'pass', 'pass',
    0, (CAST(strftime('%s','now') AS INTEGER) - 86400 * 4), (CAST(strftime('%s','now') AS INTEGER) - 86400 * 4)),

  -- Frank — 2-message thread, both read
  ('e_frank_1', 'p_frank', 'support@example.com',
    'Feature request: CSV export',
    '<p>Would be a huge help for our ops team to export the people list as CSV — any ETA on this?</p>',
    'Would be a huge help for our ops team to export the people list as CSV — any ETA on this?',
    '{}', '<frank-1@soylent.corp>', 'pass', 'pass', 'pass',
    1, (CAST(strftime('%s','now') AS INTEGER) - 86400 * 3), (CAST(strftime('%s','now') AS INTEGER) - 86400 * 3)),
  ('e_frank_2', 'p_frank', 'support@example.com',
    'Re: Feature request: CSV export',
    '<p>Great, thanks for the workaround via the API. I''ll try that today.</p>',
    'Great, thanks for the workaround via the API. I''ll try that today.',
    '{}', '<frank-2@soylent.corp>', 'pass', 'pass', 'pass',
    1, (CAST(strftime('%s','now') AS INTEGER) - 86400 * 2 - 3600 * 8), (CAST(strftime('%s','now') AS INTEGER) - 86400 * 2 - 3600 * 8)),

  -- Grace — unread, yesterday
  ('e_grace_1', 'p_grace', 'hello@example.com',
    'Press inquiry — 5-min quote',
    '<p>I''m writing for The Paper about developer infra trends. Could someone send a quote on how you''re thinking about email-as-a-platform? Deadline EOD Friday.</p>',
    'I''m writing for The Paper about developer infra trends. Could someone send a quote on how you''re thinking about email-as-a-platform? Deadline EOD Friday.',
    '{}', '<grace-1@dundermifflin.com>', 'pass', 'pass', 'pass',
    0, (CAST(strftime('%s','now') AS INTEGER) - 86400 * 1 - 3600 * 4), (CAST(strftime('%s','now') AS INTEGER) - 86400 * 1 - 3600 * 4)),

  -- Henry — most recent, unread
  ('e_henry_1', 'p_henry', 'sales@example.com',
    'Pilot program — start next Monday?',
    '<p>Team loved the demo. We''d like to kick off a 30-day pilot starting next Monday with 10 seats. Who do I loop in to get an order form?</p><p>— Henry</p>',
    'Team loved the demo. We''d like to kick off a 30-day pilot starting next Monday with 10 seats. Who do I loop in to get an order form? — Henry',
    '{}', '<henry-1@wayne.enterprises>', 'pass', 'pass', 'pass',
    0, (CAST(strftime('%s','now') AS INTEGER) - 3600 * 2), (CAST(strftime('%s','now') AS INTEGER) - 3600 * 2)),

  -- Alice — separate support thread (2FA issue), unread
  ('e_alice_3', 'p_alice', 'support@example.com',
    '2FA codes not arriving',
    '<p>Hey — since last Thursday my 2FA SMS codes aren''t coming through. I can get in via backup codes but my whole team is reporting the same issue. Happy to share numbers off-channel.</p>',
    'Hey — since last Thursday my 2FA SMS codes aren''t coming through. I can get in via backup codes but my whole team is reporting the same issue. Happy to share numbers off-channel.',
    '{}', '<alice-3@acme.co>', 'pass', 'pass', 'pass',
    0, (CAST(strftime('%s','now') AS INTEGER) - 86400 * 1 - 3600 * 9), (CAST(strftime('%s','now') AS INTEGER) - 86400 * 1 - 3600 * 9)),

  -- Kim (Acme, same co as Alice) — webhook signing rotation, read
  ('e_kim_1', 'p_kim', 'support@example.com',
    'Webhook signing secret rotation',
    '<p>Is there a self-serve way to rotate the webhook signing secret? Our security review flagged it as an annual rotation requirement.</p><p>Kim Park, Acme Platform Eng</p>',
    'Is there a self-serve way to rotate the webhook signing secret? Our security review flagged it as an annual rotation requirement. Kim Park, Acme Platform Eng',
    '{}', '<kim-1@acme.co>', 'pass', 'pass', 'pass',
    1, (CAST(strftime('%s','now') AS INTEGER) - 86400 * 11), (CAST(strftime('%s','now') AS INTEGER) - 86400 * 11)),

  -- Kim — reply to April newsletter with a product question, unread
  ('e_kim_2', 'p_kim', 'newsletter@example.com',
    'Re: What''s new in April — scheduled sends',
    '<p>The new scheduled-sends feature looks great. Does it respect the recipient''s timezone automatically or do we pass an offset? Couldn''t tell from the changelog.</p>',
    'The new scheduled-sends feature looks great. Does it respect the recipient''s timezone automatically or do we pass an offset? Couldn''t tell from the changelog.',
    '{}', '<kim-2@acme.co>', 'pass', 'pass', 'pass',
    0, (CAST(strftime('%s','now') AS INTEGER) - 86400 * 10), (CAST(strftime('%s','now') AS INTEGER) - 86400 * 10)),

  -- Bob — follow-up on SSO docs, read
  ('e_bob_2', 'p_bob', 'sales@example.com',
    'Re: Enterprise pricing question',
    '<p>Thanks — the pricing sheet helps. Can you point me at SSO setup docs? We''re standardizing on Okta.</p>',
    'Thanks — the pricing sheet helps. Can you point me at SSO setup docs? We''re standardizing on Okta.',
    '{}', '<bob-2@globex.io>', 'pass', 'pass', 'pass',
    1, (CAST(strftime('%s','now') AS INTEGER) - 86400 * 8), (CAST(strftime('%s','now') AS INTEGER) - 86400 * 8)),

  -- Leo (Initech, same co as Carla) — minor rate-limit bug, read
  ('e_leo_1', 'p_leo', 'support@example.com',
    'Rate limit header off by one',
    '<p>Minor bug: X-RateLimit-Remaining seems to decrement twice on the final request of a window. Not blocking but worth a look.</p>',
    'Minor bug: X-RateLimit-Remaining seems to decrement twice on the final request of a window. Not blocking but worth a look.',
    '{}', '<leo-1@initech.dev>', 'pass', 'pass', 'pass',
    1, (CAST(strftime('%s','now') AS INTEGER) - 86400 * 5), (CAST(strftime('%s','now') AS INTEGER) - 86400 * 5)),

  -- Carla — new thread on API v2 migration, unread
  ('e_carla_4', 'p_carla', 'support@example.com',
    'API v2 migration timeline?',
    '<p>Saw the deprecation notice for /v1/events in the March changelog. What''s the hard cutoff date? We need to plan the migration work.</p>',
    'Saw the deprecation notice for /v1/events in the March changelog. What''s the hard cutoff date? We need to plan the migration work.',
    '{}', '<carla-4@initech.dev>', 'pass', 'pass', 'pass',
    0, (CAST(strftime('%s','now') AS INTEGER) - 86400 * 1 - 3600 * 1), (CAST(strftime('%s','now') AS INTEGER) - 86400 * 1 - 3600 * 1)),

  -- Iris — GDPR account deletion, read
  ('e_iris_1', 'p_iris', 'support@example.com',
    'GDPR — delete my account and data',
    '<p>Hi, I''m leaving Northwind and need my individual account and sent data deleted under GDPR Article 17. The company account should remain.</p><p>— Iris</p>',
    'Hi, I''m leaving Northwind and need my individual account and sent data deleted under GDPR Article 17. The company account should remain. — Iris',
    '{}', '<iris-1@northwind.co>', 'pass', 'pass', 'pass',
    1, (CAST(strftime('%s','now') AS INTEGER) - 86400 * 20), (CAST(strftime('%s','now') AS INTEGER) - 86400 * 20)),

  -- Iris — billing/refund follow-up, read
  ('e_iris_2', 'p_iris', 'billing@example.com',
    'Refund for March — account closing',
    '<p>Since my seat was deprovisioned on the 2nd, can we get the prorated refund for March applied back to the card on file?</p>',
    'Since my seat was deprovisioned on the 2nd, can we get the prorated refund for March applied back to the card on file?',
    '{}', '<iris-2@northwind.co>', 'pass', 'pass', 'pass',
    1, (CAST(strftime('%s','now') AS INTEGER) - 86400 * 18), (CAST(strftime('%s','now') AS INTEGER) - 86400 * 18)),

  -- Frank — 403 on new API key, unread
  ('e_frank_3', 'p_frank', 'support@example.com',
    'API key 403 on new environment',
    '<p>Generated a new key for our staging env and it''s 403-ing on every request. Key looks correct. Is there a propagation delay?</p>',
    'Generated a new key for our staging env and it''s 403-ing on every request. Key looks correct. Is there a propagation delay?',
    '{}', '<frank-3@soylent.corp>', 'pass', 'pass', 'pass',
    0, (CAST(strftime('%s','now') AS INTEGER) - 3600 * 18), (CAST(strftime('%s','now') AS INTEGER) - 3600 * 18)),

  -- Jack (Wayne, same co as Henry) — key rotation bug, read
  ('e_jack_1', 'p_jack', 'support@example.com',
    'Old API keys still valid after rotation',
    '<p>We rotated the root API key this morning but the old one is still returning 200s. Compliance is going to ask about this — can you confirm the expected revocation window?</p><p>Jack Prince, Wayne Infra</p>',
    'We rotated the root API key this morning but the old one is still returning 200s. Compliance is going to ask about this — can you confirm the expected revocation window? Jack Prince, Wayne Infra',
    '{}', '<jack-1@wayne.enterprises>', 'pass', 'pass', 'pass',
    1, (CAST(strftime('%s','now') AS INTEGER) - 86400 * 9), (CAST(strftime('%s','now') AS INTEGER) - 86400 * 9)),

  -- Eve — accepting renewal terms, read
  ('e_eve_2', 'p_eve', 'sales@example.com',
    'Re: Annual contract renewal',
    '<p>Terms look good. PO attached — please invoice on April 30.</p>',
    'Terms look good. PO attached — please invoice on April 30.',
    '{}', '<eve-2@piedpiper.ai>', 'pass', 'pass', 'pass',
    1, (CAST(strftime('%s','now') AS INTEGER) - 86400 * 2 - 3600 * 6), (CAST(strftime('%s','now') AS INTEGER) - 86400 * 2 - 3600 * 6)),

  -- Henry — reply with BI/CSM questions, unread
  ('e_henry_2', 'p_henry', 'sales@example.com',
    'Re: Pilot program — start next Monday?',
    '<p>One more thing: can we wire pilot usage into our internal BI via the API, or is that a paid-tier only feature? Also — who''s our CSM?</p>',
    'One more thing: can we wire pilot usage into our internal BI via the API, or is that a paid-tier only feature? Also — who''s our CSM?',
    '{}', '<henry-2@wayne.enterprises>', 'pass', 'pass', 'pass',
    0, (CAST(strftime('%s','now') AS INTEGER) - 3600 * 1), (CAST(strftime('%s','now') AS INTEGER) - 3600 * 1)),

  -- --------------------------------------------------------------------------
  -- Cross-inbox messages: ensure every person has hit ≥2 of our inboxes.
  -- --------------------------------------------------------------------------

  -- Alice (support) → billing: split invoice between cost centers
  ('e_alice_billing_1', 'p_alice', 'billing@example.com',
    'Split March invoice between two cost centers?',
    '<p>Hey — can you split the March invoice 60/40 between <code>platform-eng</code> and <code>growth</code> cost centers? Finance flagged it on our end.</p>',
    'Hey — can you split the March invoice 60/40 between platform-eng and growth cost centers? Finance flagged it on our end.',
    '{}', '<alice-billing-1@acme.co>', 'pass', 'pass', 'pass',
    1, (CAST(strftime('%s','now') AS INTEGER) - 86400 * 9), (CAST(strftime('%s','now') AS INTEGER) - 86400 * 9)),

  -- Bob (sales) → support: Okta SAML metadata URL
  ('e_bob_support_1', 'p_bob', 'support@example.com',
    'SAML metadata URL for Okta setup?',
    '<p>Our IT team is ready to wire up Okta SAML. What''s the metadata URL on your side? Couldn''t find it in the SSO docs link you sent.</p>',
    'Our IT team is ready to wire up Okta SAML. What''s the metadata URL on your side? Couldn''t find it in the SSO docs link you sent.',
    '{}', '<bob-support-1@globex.io>', 'pass', 'pass', 'pass',
    0, (CAST(strftime('%s','now') AS INTEGER) - 86400 * 6), (CAST(strftime('%s','now') AS INTEGER) - 86400 * 6)),

  -- Carla (support) → billing: PO mismatch on April invoice
  ('e_carla_billing_1', 'p_carla', 'billing@example.com',
    'PO number missing on April invoice',
    '<p>Our April invoice came through without our PO number (<code>INI-2026-0412</code>) on it — can you reissue with the PO so AP can process it?</p>',
    'Our April invoice came through without our PO number (INI-2026-0412) on it — can you reissue with the PO so AP can process it?',
    '{}', '<carla-billing-1@initech.dev>', 'pass', 'pass', 'pass',
    1, (CAST(strftime('%s','now') AS INTEGER) - 86400 * 13), (CAST(strftime('%s','now') AS INTEGER) - 86400 * 13)),

  -- Dan (hello) → sales: co-marketing pricing package
  ('e_dan_sales_1', 'p_dan', 'sales@example.com',
    'Co-marketing bundle — pricing?',
    '<p>Following the partnership thread — our marketing lead wants to bundle a joint webinar with a 3-month paid trial. Do you have a co-marketing package you can share?</p>',
    'Following the partnership thread — our marketing lead wants to bundle a joint webinar with a 3-month paid trial. Do you have a co-marketing package you can share?',
    '{}', '<dan-sales-1@hooli.com>', 'pass', 'pass', 'pass',
    0, (CAST(strftime('%s','now') AS INTEGER) - 86400 * 3 - 3600 * 6), (CAST(strftime('%s','now') AS INTEGER) - 86400 * 3 - 3600 * 6)),

  -- Eve (sales) → billing: PO delivery confirmation
  ('e_eve_billing_1', 'p_eve', 'billing@example.com',
    'PO-4471 — confirm receipt?',
    '<p>Our AP team sent <strong>PO-4471</strong> over last Thursday for the renewal. Can you confirm it''s been received on your side before the April 30 invoice goes out?</p>',
    'Our AP team sent PO-4471 over last Thursday for the renewal. Can you confirm it''s been received on your side before the April 30 invoice goes out?',
    '{}', '<eve-billing-1@piedpiper.ai>', 'pass', 'pass', 'pass',
    1, (CAST(strftime('%s','now') AS INTEGER) - 86400 * 2 - 3600 * 2), (CAST(strftime('%s','now') AS INTEGER) - 86400 * 2 - 3600 * 2)),

  -- Frank (support) → billing: card updated after failed charge
  ('e_frank_billing_1', 'p_frank', 'billing@example.com',
    'Re: Invoice cm_apr_2026_soylent — payment failed',
    '<p>Updated the card on file — it was an expiration we missed. Can you retry the charge now instead of waiting 3 days? Don''t want the account to suspend.</p>',
    'Updated the card on file — it was an expiration we missed. Can you retry the charge now instead of waiting 3 days? Don''t want the account to suspend.',
    '{}', '<frank-billing-1@soylent.corp>', 'pass', 'pass', 'pass',
    0, (CAST(strftime('%s','now') AS INTEGER) - 86400 * 14 - 3600 * 3), (CAST(strftime('%s','now') AS INTEGER) - 86400 * 14 - 3600 * 3)),

  -- Grace (hello) → sales: sponsorship/advertising inquiry
  ('e_grace_sales_1', 'p_grace', 'sales@example.com',
    'Sponsorship slot in The Paper — Q3 issue?',
    '<p>Separate from the press piece — would saasmail consider a sponsorship slot in our Q3 developer issue? We have a 60k-dev audience and can share past sponsor decks.</p>',
    'Separate from the press piece — would saasmail consider a sponsorship slot in our Q3 developer issue? We have a 60k-dev audience and can share past sponsor decks.',
    '{}', '<grace-sales-1@dundermifflin.com>', 'pass', 'pass', 'pass',
    1, (CAST(strftime('%s','now') AS INTEGER) - 86400 * 3), (CAST(strftime('%s','now') AS INTEGER) - 86400 * 3)),

  -- Henry (sales) → support: pilot SSO setup
  ('e_henry_support_1', 'p_henry', 'support@example.com',
    'Pilot SSO — can we enable on day 1?',
    '<p>Hey — our IT requires SSO from day one for any pilot. Can Business-tier SSO be enabled on the pilot workspace <code>wayne-pilot</code> even though we''re technically on a trial?</p>',
    'Hey — our IT requires SSO from day one for any pilot. Can Business-tier SSO be enabled on the pilot workspace wayne-pilot even though we''re technically on a trial?',
    '{}', '<henry-support-1@wayne.enterprises>', 'pass', 'pass', 'pass',
    0, (CAST(strftime('%s','now') AS INTEGER) - 3600 * 4), (CAST(strftime('%s','now') AS INTEGER) - 3600 * 4)),

  -- Jack (support) → billing: reconciliation on workspace seats
  ('e_jack_billing_1', 'p_jack', 'billing@example.com',
    'Seat count mismatch on March invoice',
    '<p>March invoice shows 42 seats but our audit log shows 38 active. Can you send a breakdown per seat ID so I can reconcile with AP?</p>',
    'March invoice shows 42 seats but our audit log shows 38 active. Can you send a breakdown per seat ID so I can reconcile with AP?',
    '{}', '<jack-billing-1@wayne.enterprises>', 'pass', 'pass', 'pass',
    1, (CAST(strftime('%s','now') AS INTEGER) - 86400 * 7), (CAST(strftime('%s','now') AS INTEGER) - 86400 * 7)),

  -- Leo (support) → billing: re-send February receipt
  ('e_leo_billing_1', 'p_leo', 'billing@example.com',
    'Re-send February receipt for expense report?',
    '<p>I misplaced the February receipt and our finance close is tomorrow. Can you resend <code>cm_feb_2026_initech</code> as a PDF?</p>',
    'I misplaced the February receipt and our finance close is tomorrow. Can you resend cm_feb_2026_initech as a PDF?',
    '{}', '<leo-billing-1@initech.dev>', 'pass', 'pass', 'pass',
    1, (CAST(strftime('%s','now') AS INTEGER) - 86400 * 4), (CAST(strftime('%s','now') AS INTEGER) - 86400 * 4));

-- ----------------------------------------------------------------------------
-- Sent emails (our replies)
-- ----------------------------------------------------------------------------
INSERT OR REPLACE INTO sent_emails (id, person_id, from_address, to_address, subject, body_html, body_text, in_reply_to, resend_id, status, sent_at, created_at) VALUES
  ('s_alice_1', 'p_alice', 'support@example.com', 'alice.nguyen@acme.co',
    'Re: Trouble logging in on mobile',
    '<p>Hi Alice, sorry about that! Could you try force-quitting the app and reinstalling? There was a caching bug in the previous build.</p>',
    'Hi Alice, sorry about that! Could you try force-quitting the app and reinstalling? There was a caching bug in the previous build.',
    '<alice-1@acme.co>', NULL, 'sent',
    (CAST(strftime('%s','now') AS INTEGER) - 86400 * 13 + 3600 * 2),
    (CAST(strftime('%s','now') AS INTEGER) - 86400 * 13 + 3600 * 2)),

  ('s_carla_1', 'p_carla', 'support@example.com', 'carla@initech.dev',
    'Re: Webhook deliveries failing intermittently',
    '<p>Hi Carla — pulled the IDs. Looks like a regional timeout issue. We''ve shipped a retry flag; try setting <code>x-saasmail-retry: true</code> on your callback.</p>',
    'Hi Carla — pulled the IDs. Looks like a regional timeout issue. We''ve shipped a retry flag; try setting x-saasmail-retry: true on your callback.',
    '<carla-1@initech.dev>', NULL, 'sent',
    (CAST(strftime('%s','now') AS INTEGER) - 86400 * 7 + 3600 * 4),
    (CAST(strftime('%s','now') AS INTEGER) - 86400 * 7 + 3600 * 4)),

  ('s_frank_1', 'p_frank', 'support@example.com', 'frank.liu@soylent.corp',
    'Re: Feature request: CSV export',
    '<p>Hey Frank — no ETA on a UI button yet, but <code>GET /api/people?format=csv</code> works today if you have an API key. Happy to send snippets.</p>',
    'Hey Frank — no ETA on a UI button yet, but GET /api/people?format=csv works today if you have an API key. Happy to send snippets.',
    '<frank-1@soylent.corp>', NULL, 'sent',
    (CAST(strftime('%s','now') AS INTEGER) - 86400 * 2 - 3600 * 12),
    (CAST(strftime('%s','now') AS INTEGER) - 86400 * 2 - 3600 * 12)),

  -- ---- Replies from the team -------------------------------------------------
  ('s_bob_1', 'p_bob', 'sales@example.com', 'bob@globex.io',
    'Re: Enterprise pricing question',
    '<p>Hi Bob — attached is the enterprise sheet. SSO (SAML + SCIM) is included on the Business tier and up. Happy to set up a 30-min call if helpful.</p>',
    'Hi Bob — attached is the enterprise sheet. SSO (SAML + SCIM) is included on the Business tier and up. Happy to set up a 30-min call if helpful.',
    '<bob-1@globex.io>', NULL, 'sent',
    (CAST(strftime('%s','now') AS INTEGER) - 86400 * 9 - 3600 * 3),
    (CAST(strftime('%s','now') AS INTEGER) - 86400 * 9 - 3600 * 3)),

  ('s_bob_2', 'p_bob', 'sales@example.com', 'bob@globex.io',
    'Re: Enterprise pricing question',
    '<p>Okta guide is at <a href="https://example.com/docs/sso/okta">/docs/sso/okta</a>. Let me know once the metadata is exchanged and I can verify on our end.</p>',
    'Okta guide is at https://example.com/docs/sso/okta. Let me know once the metadata is exchanged and I can verify on our end.',
    '<bob-2@globex.io>', NULL, 'sent',
    (CAST(strftime('%s','now') AS INTEGER) - 86400 * 7 - 3600 * 20),
    (CAST(strftime('%s','now') AS INTEGER) - 86400 * 7 - 3600 * 20)),

  ('s_dan_1', 'p_dan', 'hello@example.com', 'dan@hooli.com',
    'Re: Partnership inquiry',
    '<p>Hi Dan — thanks for reaching out. Forwarding this to our partnerships lead; they''ll reply with a calendar link this week.</p>',
    'Hi Dan — thanks for reaching out. Forwarding this to our partnerships lead; they''ll reply with a calendar link this week.',
    '<dan-1@hooli.com>', NULL, 'sent',
    (CAST(strftime('%s','now') AS INTEGER) - 86400 * 5 - 3600 * 4),
    (CAST(strftime('%s','now') AS INTEGER) - 86400 * 5 - 3600 * 4)),

  ('s_eve_1', 'p_eve', 'sales@example.com', 'eve@piedpiper.ai',
    'Re: Annual contract renewal',
    '<p>Hi Eve — renewal docs attached along with a diff of plan changes since 2025. Let me know if the April 30 invoice date works and we''ll get a PO out.</p>',
    'Hi Eve — renewal docs attached along with a diff of plan changes since 2025. Let me know if the April 30 invoice date works and we''ll get a PO out.',
    '<eve-1@piedpiper.ai>', NULL, 'sent',
    (CAST(strftime('%s','now') AS INTEGER) - 86400 * 3 - 3600 * 10),
    (CAST(strftime('%s','now') AS INTEGER) - 86400 * 3 - 3600 * 10)),

  ('s_grace_1', 'p_grace', 'hello@example.com', 'grace@dundermifflin.com',
    'Re: Press inquiry — 5-min quote',
    '<p>Hi Grace — sending two short quotes from our CEO below; attribution to "Founder, saasmail". Let me know if you need anything sharper before EOD Friday.</p>',
    'Hi Grace — sending two short quotes from our CEO below; attribution to "Founder, saasmail". Let me know if you need anything sharper before EOD Friday.',
    '<grace-1@dundermifflin.com>', NULL, 'sent',
    (CAST(strftime('%s','now') AS INTEGER) - 86400 * 1 - 3600 * 1),
    (CAST(strftime('%s','now') AS INTEGER) - 86400 * 1 - 3600 * 1)),

  ('s_iris_1', 'p_iris', 'support@example.com', 'iris.chen@northwind.co',
    'Re: GDPR — delete my account and data',
    '<p>Hi Iris — confirming we''ve queued your individual account for deletion (72h cooling-off per GDPR). Your company''s shared data is untouched. You''ll get a final confirmation from <code>notifications@</code> when processing completes.</p>',
    'Hi Iris — confirming we''ve queued your individual account for deletion (72h cooling-off per GDPR). Your company''s shared data is untouched. You''ll get a final confirmation from notifications@ when processing completes.',
    '<iris-1@northwind.co>', NULL, 'sent',
    (CAST(strftime('%s','now') AS INTEGER) - 86400 * 19 - 3600 * 5),
    (CAST(strftime('%s','now') AS INTEGER) - 86400 * 19 - 3600 * 5)),

  ('s_iris_2', 'p_iris', 'billing@example.com', 'iris.chen@northwind.co',
    'Re: Refund for March — account closing',
    '<p>Hi Iris — prorated refund of $27.43 has been queued to the Visa ending 4242. Should land in 5–10 business days. Receipt attached.</p>',
    'Hi Iris — prorated refund of $27.43 has been queued to the Visa ending 4242. Should land in 5–10 business days. Receipt attached.',
    '<iris-2@northwind.co>', NULL, 'sent',
    (CAST(strftime('%s','now') AS INTEGER) - 86400 * 17 - 3600 * 8),
    (CAST(strftime('%s','now') AS INTEGER) - 86400 * 17 - 3600 * 8)),

  ('s_jack_1', 'p_jack', 'support@example.com', 'jack@wayne.enterprises',
    'Re: Old API keys still valid after rotation',
    '<p>Hi Jack — rotation uses a 5-minute grace window by default so in-flight requests don''t 401. You can force-revoke immediately with <code>POST /api/keys/:id/revoke?grace=0</code>. Cutting a doc PR now.</p>',
    'Hi Jack — rotation uses a 5-minute grace window by default so in-flight requests don''t 401. You can force-revoke immediately with POST /api/keys/:id/revoke?grace=0. Cutting a doc PR now.',
    '<jack-1@wayne.enterprises>', NULL, 'sent',
    (CAST(strftime('%s','now') AS INTEGER) - 86400 * 8 - 3600 * 22),
    (CAST(strftime('%s','now') AS INTEGER) - 86400 * 8 - 3600 * 22)),

  ('s_kim_1', 'p_kim', 'support@example.com', 'kim.park@acme.co',
    'Re: Webhook signing secret rotation',
    '<p>Hi Kim — settings → webhooks → "Rotate secret" produces a new secret with both old and new valid for 24h. Full rotation runbook: <a href="https://example.com/docs/webhooks/rotation">/docs/webhooks/rotation</a>.</p>',
    'Hi Kim — settings → webhooks → "Rotate secret" produces a new secret with both old and new valid for 24h. Full rotation runbook: /docs/webhooks/rotation.',
    '<kim-1@acme.co>', NULL, 'sent',
    (CAST(strftime('%s','now') AS INTEGER) - 86400 * 10 - 3600 * 18),
    (CAST(strftime('%s','now') AS INTEGER) - 86400 * 10 - 3600 * 18)),

  ('s_leo_1', 'p_leo', 'support@example.com', 'leo@initech.dev',
    'Re: Rate limit header off by one',
    '<p>Hi Leo — nice catch. Repro''d, filed as RATE-148, fix should land in next week''s release.</p>',
    'Hi Leo — nice catch. Repro''d, filed as RATE-148, fix should land in next week''s release.',
    '<leo-1@initech.dev>', NULL, 'sent',
    (CAST(strftime('%s','now') AS INTEGER) - 86400 * 4 - 3600 * 6),
    (CAST(strftime('%s','now') AS INTEGER) - 86400 * 4 - 3600 * 6)),

  -- ---- Monthly newsletter: February 2026 (day ~73) ---------------------------
  ('s_news_feb_alice', 'p_alice', 'newsletter@example.com', 'alice.nguyen@acme.co',
    'saasmail monthly — February 2026: OAuth2 inbound is live',
    '<h2>What shipped in February</h2><ul><li>OAuth2 inbound auth for webhooks</li><li>3× faster fanout on large sends</li><li>Q1 roadmap recap</li></ul><p><a href="https://example.com/blog/feb-2026">Read the full post →</a></p>',
    'What shipped in February: OAuth2 inbound auth for webhooks; 3× faster fanout on large sends; Q1 roadmap recap. Read the full post: https://example.com/blog/feb-2026',
    NULL, 'resend_feb_alice', 'sent',
    (CAST(strftime('%s','now') AS INTEGER) - 86400 * 73),
    (CAST(strftime('%s','now') AS INTEGER) - 86400 * 73)),
  ('s_news_feb_bob', 'p_bob', 'newsletter@example.com', 'bob@globex.io',
    'saasmail monthly — February 2026: OAuth2 inbound is live',
    '<h2>What shipped in February</h2><ul><li>OAuth2 inbound auth for webhooks</li><li>3× faster fanout on large sends</li><li>Q1 roadmap recap</li></ul><p><a href="https://example.com/blog/feb-2026">Read the full post →</a></p>',
    'What shipped in February: OAuth2 inbound auth for webhooks; 3× faster fanout on large sends; Q1 roadmap recap.',
    NULL, 'resend_feb_bob', 'sent',
    (CAST(strftime('%s','now') AS INTEGER) - 86400 * 73),
    (CAST(strftime('%s','now') AS INTEGER) - 86400 * 73)),
  ('s_news_feb_carla', 'p_carla', 'newsletter@example.com', 'carla@initech.dev',
    'saasmail monthly — February 2026: OAuth2 inbound is live',
    '<h2>What shipped in February</h2><ul><li>OAuth2 inbound auth for webhooks</li><li>3× faster fanout on large sends</li><li>Q1 roadmap recap</li></ul><p><a href="https://example.com/blog/feb-2026">Read the full post →</a></p>',
    'What shipped in February: OAuth2 inbound auth for webhooks; 3× faster fanout on large sends; Q1 roadmap recap.',
    NULL, 'resend_feb_carla', 'sent',
    (CAST(strftime('%s','now') AS INTEGER) - 86400 * 73),
    (CAST(strftime('%s','now') AS INTEGER) - 86400 * 73)),
  ('s_news_feb_dan', 'p_dan', 'newsletter@example.com', 'dan@hooli.com',
    'saasmail monthly — February 2026: OAuth2 inbound is live',
    '<h2>What shipped in February</h2><ul><li>OAuth2 inbound auth for webhooks</li><li>3× faster fanout on large sends</li><li>Q1 roadmap recap</li></ul><p><a href="https://example.com/blog/feb-2026">Read the full post →</a></p>',
    'What shipped in February: OAuth2 inbound auth for webhooks; 3× faster fanout on large sends; Q1 roadmap recap.',
    NULL, 'resend_feb_dan', 'sent',
    (CAST(strftime('%s','now') AS INTEGER) - 86400 * 73),
    (CAST(strftime('%s','now') AS INTEGER) - 86400 * 73)),
  ('s_news_feb_eve', 'p_eve', 'newsletter@example.com', 'eve@piedpiper.ai',
    'saasmail monthly — February 2026: OAuth2 inbound is live',
    '<h2>What shipped in February</h2><ul><li>OAuth2 inbound auth for webhooks</li><li>3× faster fanout on large sends</li><li>Q1 roadmap recap</li></ul><p><a href="https://example.com/blog/feb-2026">Read the full post →</a></p>',
    'What shipped in February: OAuth2 inbound auth for webhooks; 3× faster fanout on large sends; Q1 roadmap recap.',
    NULL, 'resend_feb_eve', 'sent',
    (CAST(strftime('%s','now') AS INTEGER) - 86400 * 73),
    (CAST(strftime('%s','now') AS INTEGER) - 86400 * 73)),
  ('s_news_feb_frank', 'p_frank', 'newsletter@example.com', 'frank.liu@soylent.corp',
    'saasmail monthly — February 2026: OAuth2 inbound is live',
    '<h2>What shipped in February</h2><ul><li>OAuth2 inbound auth for webhooks</li><li>3× faster fanout on large sends</li><li>Q1 roadmap recap</li></ul><p><a href="https://example.com/blog/feb-2026">Read the full post →</a></p>',
    'What shipped in February: OAuth2 inbound auth for webhooks; 3× faster fanout on large sends; Q1 roadmap recap.',
    NULL, 'resend_feb_frank', 'sent',
    (CAST(strftime('%s','now') AS INTEGER) - 86400 * 73),
    (CAST(strftime('%s','now') AS INTEGER) - 86400 * 73)),
  ('s_news_feb_iris', 'p_iris', 'newsletter@example.com', 'iris.chen@northwind.co',
    'saasmail monthly — February 2026: OAuth2 inbound is live',
    '<h2>What shipped in February</h2><ul><li>OAuth2 inbound auth for webhooks</li><li>3× faster fanout on large sends</li><li>Q1 roadmap recap</li></ul><p><a href="https://example.com/blog/feb-2026">Read the full post →</a></p>',
    'What shipped in February: OAuth2 inbound auth for webhooks; 3× faster fanout on large sends; Q1 roadmap recap.',
    NULL, 'resend_feb_iris', 'sent',
    (CAST(strftime('%s','now') AS INTEGER) - 86400 * 73),
    (CAST(strftime('%s','now') AS INTEGER) - 86400 * 73)),
  ('s_news_feb_kim', 'p_kim', 'newsletter@example.com', 'kim.park@acme.co',
    'saasmail monthly — February 2026: OAuth2 inbound is live',
    '<h2>What shipped in February</h2><ul><li>OAuth2 inbound auth for webhooks</li><li>3× faster fanout on large sends</li><li>Q1 roadmap recap</li></ul><p><a href="https://example.com/blog/feb-2026">Read the full post →</a></p>',
    'What shipped in February: OAuth2 inbound auth for webhooks; 3× faster fanout on large sends; Q1 roadmap recap.',
    NULL, 'resend_feb_kim', 'sent',
    (CAST(strftime('%s','now') AS INTEGER) - 86400 * 73),
    (CAST(strftime('%s','now') AS INTEGER) - 86400 * 73)),
  ('s_news_feb_leo', 'p_leo', 'newsletter@example.com', 'leo@initech.dev',
    'saasmail monthly — February 2026: OAuth2 inbound is live',
    '<h2>What shipped in February</h2><ul><li>OAuth2 inbound auth for webhooks</li><li>3× faster fanout on large sends</li><li>Q1 roadmap recap</li></ul><p><a href="https://example.com/blog/feb-2026">Read the full post →</a></p>',
    'What shipped in February: OAuth2 inbound auth for webhooks; 3× faster fanout on large sends; Q1 roadmap recap.',
    NULL, 'resend_feb_leo', 'sent',
    (CAST(strftime('%s','now') AS INTEGER) - 86400 * 73),
    (CAST(strftime('%s','now') AS INTEGER) - 86400 * 73)),

  -- ---- Monthly newsletter: March 2026 (day ~45) ------------------------------
  ('s_news_mar_alice', 'p_alice', 'newsletter@example.com', 'alice.nguyen@acme.co',
    'saasmail monthly — March 2026: Customer spotlight + v1 deprecation',
    '<h2>March highlights</h2><ul><li>Customer spotlight: how Globex cut onboarding emails by 40%</li><li>Deprecation notice: <code>/v1/events</code> sunsets July 1, 2026</li><li>New: inbox-level signing keys</li></ul><p><a href="https://example.com/blog/mar-2026">Read more →</a></p>',
    'March highlights: Customer spotlight on Globex; /v1/events sunsets July 1, 2026; new inbox-level signing keys.',
    NULL, 'resend_mar_alice', 'sent',
    (CAST(strftime('%s','now') AS INTEGER) - 86400 * 45),
    (CAST(strftime('%s','now') AS INTEGER) - 86400 * 45)),
  ('s_news_mar_bob', 'p_bob', 'newsletter@example.com', 'bob@globex.io',
    'saasmail monthly — March 2026: Customer spotlight + v1 deprecation',
    '<h2>March highlights</h2><ul><li>Customer spotlight: how Globex cut onboarding emails by 40%</li><li>Deprecation notice: <code>/v1/events</code> sunsets July 1, 2026</li><li>New: inbox-level signing keys</li></ul><p><a href="https://example.com/blog/mar-2026">Read more →</a></p>',
    'March highlights: Customer spotlight on Globex; /v1/events sunsets July 1, 2026; new inbox-level signing keys.',
    NULL, 'resend_mar_bob', 'sent',
    (CAST(strftime('%s','now') AS INTEGER) - 86400 * 45),
    (CAST(strftime('%s','now') AS INTEGER) - 86400 * 45)),
  ('s_news_mar_carla', 'p_carla', 'newsletter@example.com', 'carla@initech.dev',
    'saasmail monthly — March 2026: Customer spotlight + v1 deprecation',
    '<h2>March highlights</h2><ul><li>Customer spotlight: how Globex cut onboarding emails by 40%</li><li>Deprecation notice: <code>/v1/events</code> sunsets July 1, 2026</li><li>New: inbox-level signing keys</li></ul><p><a href="https://example.com/blog/mar-2026">Read more →</a></p>',
    'March highlights: Customer spotlight on Globex; /v1/events sunsets July 1, 2026; new inbox-level signing keys.',
    NULL, 'resend_mar_carla', 'sent',
    (CAST(strftime('%s','now') AS INTEGER) - 86400 * 45),
    (CAST(strftime('%s','now') AS INTEGER) - 86400 * 45)),
  ('s_news_mar_dan', 'p_dan', 'newsletter@example.com', 'dan@hooli.com',
    'saasmail monthly — March 2026: Customer spotlight + v1 deprecation',
    '<h2>March highlights</h2><ul><li>Customer spotlight: how Globex cut onboarding emails by 40%</li><li>Deprecation notice: <code>/v1/events</code> sunsets July 1, 2026</li><li>New: inbox-level signing keys</li></ul><p><a href="https://example.com/blog/mar-2026">Read more →</a></p>',
    'March highlights: Customer spotlight on Globex; /v1/events sunsets July 1, 2026; new inbox-level signing keys.',
    NULL, 'resend_mar_dan', 'sent',
    (CAST(strftime('%s','now') AS INTEGER) - 86400 * 45),
    (CAST(strftime('%s','now') AS INTEGER) - 86400 * 45)),
  ('s_news_mar_eve', 'p_eve', 'newsletter@example.com', 'eve@piedpiper.ai',
    'saasmail monthly — March 2026: Customer spotlight + v1 deprecation',
    '<h2>March highlights</h2><ul><li>Customer spotlight: how Globex cut onboarding emails by 40%</li><li>Deprecation notice: <code>/v1/events</code> sunsets July 1, 2026</li><li>New: inbox-level signing keys</li></ul><p><a href="https://example.com/blog/mar-2026">Read more →</a></p>',
    'March highlights: Customer spotlight on Globex; /v1/events sunsets July 1, 2026; new inbox-level signing keys.',
    NULL, 'resend_mar_eve', 'sent',
    (CAST(strftime('%s','now') AS INTEGER) - 86400 * 45),
    (CAST(strftime('%s','now') AS INTEGER) - 86400 * 45)),
  ('s_news_mar_frank', 'p_frank', 'newsletter@example.com', 'frank.liu@soylent.corp',
    'saasmail monthly — March 2026: Customer spotlight + v1 deprecation',
    '<h2>March highlights</h2><ul><li>Customer spotlight: how Globex cut onboarding emails by 40%</li><li>Deprecation notice: <code>/v1/events</code> sunsets July 1, 2026</li><li>New: inbox-level signing keys</li></ul><p><a href="https://example.com/blog/mar-2026">Read more →</a></p>',
    'March highlights: Customer spotlight on Globex; /v1/events sunsets July 1, 2026; new inbox-level signing keys.',
    NULL, 'resend_mar_frank', 'sent',
    (CAST(strftime('%s','now') AS INTEGER) - 86400 * 45),
    (CAST(strftime('%s','now') AS INTEGER) - 86400 * 45)),
  ('s_news_mar_kim', 'p_kim', 'newsletter@example.com', 'kim.park@acme.co',
    'saasmail monthly — March 2026: Customer spotlight + v1 deprecation',
    '<h2>March highlights</h2><ul><li>Customer spotlight: how Globex cut onboarding emails by 40%</li><li>Deprecation notice: <code>/v1/events</code> sunsets July 1, 2026</li><li>New: inbox-level signing keys</li></ul><p><a href="https://example.com/blog/mar-2026">Read more →</a></p>',
    'March highlights: Customer spotlight on Globex; /v1/events sunsets July 1, 2026; new inbox-level signing keys.',
    NULL, 'resend_mar_kim', 'sent',
    (CAST(strftime('%s','now') AS INTEGER) - 86400 * 45),
    (CAST(strftime('%s','now') AS INTEGER) - 86400 * 45)),
  ('s_news_mar_leo', 'p_leo', 'newsletter@example.com', 'leo@initech.dev',
    'saasmail monthly — March 2026: Customer spotlight + v1 deprecation',
    '<h2>March highlights</h2><ul><li>Customer spotlight: how Globex cut onboarding emails by 40%</li><li>Deprecation notice: <code>/v1/events</code> sunsets July 1, 2026</li><li>New: inbox-level signing keys</li></ul><p><a href="https://example.com/blog/mar-2026">Read more →</a></p>',
    'March highlights: Customer spotlight on Globex; /v1/events sunsets July 1, 2026; new inbox-level signing keys.',
    NULL, 'resend_mar_leo', 'sent',
    (CAST(strftime('%s','now') AS INTEGER) - 86400 * 45),
    (CAST(strftime('%s','now') AS INTEGER) - 86400 * 45)),

  -- ---- Monthly newsletter: April 2026 (day ~15) ------------------------------
  ('s_news_apr_alice', 'p_alice', 'newsletter@example.com', 'alice.nguyen@acme.co',
    'What''s new in April — scheduled sends',
    '<h2>April release</h2><ul><li>Scheduled sends (timezone-aware by recipient)</li><li>Bulk attachment uploads via signed URLs</li><li>Password-reset email templates now editable</li></ul><p><a href="https://example.com/blog/apr-2026">Changelog →</a></p>',
    'April release: scheduled sends (timezone-aware); bulk attachment uploads via signed URLs; editable password-reset templates.',
    NULL, 'resend_apr_alice', 'sent',
    (CAST(strftime('%s','now') AS INTEGER) - 86400 * 15),
    (CAST(strftime('%s','now') AS INTEGER) - 86400 * 15)),
  ('s_news_apr_bob', 'p_bob', 'newsletter@example.com', 'bob@globex.io',
    'What''s new in April — scheduled sends',
    '<h2>April release</h2><ul><li>Scheduled sends (timezone-aware by recipient)</li><li>Bulk attachment uploads via signed URLs</li><li>Password-reset email templates now editable</li></ul><p><a href="https://example.com/blog/apr-2026">Changelog →</a></p>',
    'April release: scheduled sends (timezone-aware); bulk attachment uploads via signed URLs; editable password-reset templates.',
    NULL, 'resend_apr_bob', 'sent',
    (CAST(strftime('%s','now') AS INTEGER) - 86400 * 15),
    (CAST(strftime('%s','now') AS INTEGER) - 86400 * 15)),
  ('s_news_apr_carla', 'p_carla', 'newsletter@example.com', 'carla@initech.dev',
    'What''s new in April — scheduled sends',
    '<h2>April release</h2><ul><li>Scheduled sends (timezone-aware by recipient)</li><li>Bulk attachment uploads via signed URLs</li><li>Password-reset email templates now editable</li></ul><p><a href="https://example.com/blog/apr-2026">Changelog →</a></p>',
    'April release: scheduled sends (timezone-aware); bulk attachment uploads via signed URLs; editable password-reset templates.',
    NULL, 'resend_apr_carla', 'sent',
    (CAST(strftime('%s','now') AS INTEGER) - 86400 * 15),
    (CAST(strftime('%s','now') AS INTEGER) - 86400 * 15)),
  ('s_news_apr_dan', 'p_dan', 'newsletter@example.com', 'dan@hooli.com',
    'What''s new in April — scheduled sends',
    '<h2>April release</h2><ul><li>Scheduled sends (timezone-aware by recipient)</li><li>Bulk attachment uploads via signed URLs</li><li>Password-reset email templates now editable</li></ul><p><a href="https://example.com/blog/apr-2026">Changelog →</a></p>',
    'April release: scheduled sends (timezone-aware); bulk attachment uploads via signed URLs; editable password-reset templates.',
    NULL, 'resend_apr_dan', 'sent',
    (CAST(strftime('%s','now') AS INTEGER) - 86400 * 15),
    (CAST(strftime('%s','now') AS INTEGER) - 86400 * 15)),
  ('s_news_apr_eve', 'p_eve', 'newsletter@example.com', 'eve@piedpiper.ai',
    'What''s new in April — scheduled sends',
    '<h2>April release</h2><ul><li>Scheduled sends (timezone-aware by recipient)</li><li>Bulk attachment uploads via signed URLs</li><li>Password-reset email templates now editable</li></ul><p><a href="https://example.com/blog/apr-2026">Changelog →</a></p>',
    'April release: scheduled sends (timezone-aware); bulk attachment uploads via signed URLs; editable password-reset templates.',
    NULL, 'resend_apr_eve', 'sent',
    (CAST(strftime('%s','now') AS INTEGER) - 86400 * 15),
    (CAST(strftime('%s','now') AS INTEGER) - 86400 * 15)),
  ('s_news_apr_frank', 'p_frank', 'newsletter@example.com', 'frank.liu@soylent.corp',
    'What''s new in April — scheduled sends',
    '<h2>April release</h2><ul><li>Scheduled sends (timezone-aware by recipient)</li><li>Bulk attachment uploads via signed URLs</li><li>Password-reset email templates now editable</li></ul><p><a href="https://example.com/blog/apr-2026">Changelog →</a></p>',
    'April release: scheduled sends (timezone-aware); bulk attachment uploads via signed URLs; editable password-reset templates.',
    NULL, 'resend_apr_frank', 'sent',
    (CAST(strftime('%s','now') AS INTEGER) - 86400 * 15),
    (CAST(strftime('%s','now') AS INTEGER) - 86400 * 15)),
  ('s_news_apr_henry', 'p_henry', 'newsletter@example.com', 'henry@wayne.enterprises',
    'What''s new in April — scheduled sends',
    '<h2>April release</h2><ul><li>Scheduled sends (timezone-aware by recipient)</li><li>Bulk attachment uploads via signed URLs</li><li>Password-reset email templates now editable</li></ul><p><a href="https://example.com/blog/apr-2026">Changelog →</a></p>',
    'April release: scheduled sends (timezone-aware); bulk attachment uploads via signed URLs; editable password-reset templates.',
    NULL, 'resend_apr_henry', 'sent',
    (CAST(strftime('%s','now') AS INTEGER) - 86400 * 15),
    (CAST(strftime('%s','now') AS INTEGER) - 86400 * 15)),
  ('s_news_apr_jack', 'p_jack', 'newsletter@example.com', 'jack@wayne.enterprises',
    'What''s new in April — scheduled sends',
    '<h2>April release</h2><ul><li>Scheduled sends (timezone-aware by recipient)</li><li>Bulk attachment uploads via signed URLs</li><li>Password-reset email templates now editable</li></ul><p><a href="https://example.com/blog/apr-2026">Changelog →</a></p>',
    'April release: scheduled sends (timezone-aware); bulk attachment uploads via signed URLs; editable password-reset templates.',
    NULL, 'resend_apr_jack', 'sent',
    (CAST(strftime('%s','now') AS INTEGER) - 86400 * 15),
    (CAST(strftime('%s','now') AS INTEGER) - 86400 * 15)),
  ('s_news_apr_kim', 'p_kim', 'newsletter@example.com', 'kim.park@acme.co',
    'What''s new in April — scheduled sends',
    '<h2>April release</h2><ul><li>Scheduled sends (timezone-aware by recipient)</li><li>Bulk attachment uploads via signed URLs</li><li>Password-reset email templates now editable</li></ul><p><a href="https://example.com/blog/apr-2026">Changelog →</a></p>',
    'April release: scheduled sends (timezone-aware); bulk attachment uploads via signed URLs; editable password-reset templates.',
    NULL, 'resend_apr_kim', 'sent',
    (CAST(strftime('%s','now') AS INTEGER) - 86400 * 15),
    (CAST(strftime('%s','now') AS INTEGER) - 86400 * 15)),
  ('s_news_apr_leo', 'p_leo', 'newsletter@example.com', 'leo@initech.dev',
    'What''s new in April — scheduled sends',
    '<h2>April release</h2><ul><li>Scheduled sends (timezone-aware by recipient)</li><li>Bulk attachment uploads via signed URLs</li><li>Password-reset email templates now editable</li></ul><p><a href="https://example.com/blog/apr-2026">Changelog →</a></p>',
    'April release: scheduled sends (timezone-aware); bulk attachment uploads via signed URLs; editable password-reset templates.',
    NULL, 'resend_apr_leo', 'sent',
    (CAST(strftime('%s','now') AS INTEGER) - 86400 * 15),
    (CAST(strftime('%s','now') AS INTEGER) - 86400 * 15)),

  -- ---- Transactional / notifications ----------------------------------------
  ('s_welcome_henry', 'p_henry', 'notifications@example.com', 'henry@wayne.enterprises',
    'Welcome to saasmail — your pilot workspace is ready',
    '<h2>Welcome aboard, Henry</h2><p>Your 30-day pilot workspace <strong>wayne-pilot</strong> is live with 10 seats. Invite your team here: <a href="https://example.com/app/invite">/app/invite</a>.</p><p>Your CSM is Priya — she''ll reach out tomorrow.</p>',
    'Welcome aboard, Henry. Your 30-day pilot workspace wayne-pilot is live with 10 seats. Invite your team: /app/invite. Your CSM is Priya.',
    NULL, 'resend_welcome_henry', 'sent',
    (CAST(strftime('%s','now') AS INTEGER) - 3600 * 1 + 60 * 20),
    (CAST(strftime('%s','now') AS INTEGER) - 3600 * 1 + 60 * 20)),

  ('s_teaminvite_kim', 'p_kim', 'notifications@example.com', 'kim.park@acme.co',
    'Alice invited you to the Acme workspace',
    '<p>Alice Nguyen added you to the <strong>Acme</strong> workspace on saasmail. <a href="https://example.com/app/accept?t=...">Accept invite →</a></p><p>This link expires in 7 days.</p>',
    'Alice Nguyen added you to the Acme workspace on saasmail. Accept invite: /app/accept. Link expires in 7 days.',
    NULL, 'resend_teaminvite_kim', 'sent',
    (CAST(strftime('%s','now') AS INTEGER) - 86400 * 12),
    (CAST(strftime('%s','now') AS INTEGER) - 86400 * 12)),

  ('s_renewal_eve', 'p_eve', 'notifications@example.com', 'eve@piedpiper.ai',
    'Your plan renews in 30 days',
    '<p>Hi Eve,</p><p>Your Pied Piper subscription renews on <strong>May 17, 2026</strong> at $14,400/yr. No action needed — we''ll email a receipt on renewal day. Details: <a href="https://example.com/app/billing">/app/billing</a>.</p>',
    'Your Pied Piper subscription renews on May 17, 2026 at $14,400/yr. No action needed.',
    NULL, 'resend_renewal_eve', 'sent',
    (CAST(strftime('%s','now') AS INTEGER) - 86400 * 5 - 3600 * 2),
    (CAST(strftime('%s','now') AS INTEGER) - 86400 * 5 - 3600 * 2)),

  ('s_usage_carla', 'p_carla', 'notifications@example.com', 'carla@initech.dev',
    '[Alert] Initech has used 80% of its monthly API quota',
    '<p>Your workspace has sent <strong>800,421 / 1,000,000</strong> API events for the April window, which resets May 1.</p><p>Upgrade or top up: <a href="https://example.com/app/billing">/app/billing</a>.</p>',
    'Initech has used 800,421 / 1,000,000 API events for April. Upgrade or top up at /app/billing.',
    NULL, 'resend_usage_carla', 'sent',
    (CAST(strftime('%s','now') AS INTEGER) - 86400 * 4 - 3600 * 14),
    (CAST(strftime('%s','now') AS INTEGER) - 86400 * 4 - 3600 * 14)),

  ('s_pwreset_frank', 'p_frank', 'notifications@example.com', 'frank.liu@soylent.corp',
    'Your saasmail password has been reset',
    '<p>Hi Frank — your password was just changed from IP <code>72.14.8.19</code> (San Francisco, US). If this wasn''t you, <a href="https://example.com/app/security">revoke sessions immediately</a>.</p>',
    'Hi Frank — your password was just changed from IP 72.14.8.19. If this wasn''t you, revoke sessions at /app/security.',
    NULL, 'resend_pwreset_frank', 'sent',
    (CAST(strftime('%s','now') AS INTEGER) - 86400 * 30),
    (CAST(strftime('%s','now') AS INTEGER) - 86400 * 30)),

  ('s_refund_iris', 'p_iris', 'billing@example.com', 'iris.chen@northwind.co',
    'Receipt: Refund processed ($27.43)',
    '<p>A refund of <strong>$27.43</strong> was issued to your Visa ending in 4242 on April 1, 2026. It may take 5–10 business days to appear on your statement.</p><p>Reference: <code>re_02K9X...</code></p>',
    'A refund of $27.43 was issued to your Visa ending in 4242 on April 1, 2026. Reference: re_02K9X...',
    NULL, 'resend_refund_iris', 'sent',
    (CAST(strftime('%s','now') AS INTEGER) - 86400 * 16),
    (CAST(strftime('%s','now') AS INTEGER) - 86400 * 16)),

  ('s_inv_alice_mar', 'p_alice', 'billing@example.com', 'alice.nguyen@acme.co',
    'Invoice cm_mar_2026_acme — paid',
    '<p>Thanks, Acme! Your March invoice of <strong>$499.00</strong> has been paid.</p><p>Download PDF: <a href="https://example.com/app/invoices/cm_mar_2026_acme">cm_mar_2026_acme.pdf</a></p>',
    'Thanks, Acme! Your March invoice of $499.00 has been paid.',
    NULL, 'resend_inv_alice_mar', 'sent',
    (CAST(strftime('%s','now') AS INTEGER) - 86400 * 46),
    (CAST(strftime('%s','now') AS INTEGER) - 86400 * 46)),

  ('s_inv_alice_apr', 'p_alice', 'billing@example.com', 'alice.nguyen@acme.co',
    'Invoice cm_apr_2026_acme — paid',
    '<p>Thanks, Acme! Your April invoice of <strong>$499.00</strong> has been paid.</p><p>Download PDF: <a href="https://example.com/app/invoices/cm_apr_2026_acme">cm_apr_2026_acme.pdf</a></p>',
    'Thanks, Acme! Your April invoice of $499.00 has been paid.',
    NULL, 'resend_inv_alice_apr', 'sent',
    (CAST(strftime('%s','now') AS INTEGER) - 86400 * 15),
    (CAST(strftime('%s','now') AS INTEGER) - 86400 * 15)),

  ('s_inv_carla_apr', 'p_carla', 'billing@example.com', 'carla@initech.dev',
    'Invoice cm_apr_2026_initech — paid',
    '<p>Thanks, Initech! Your April invoice of <strong>$1,299.00</strong> has been paid.</p><p>Download PDF: <a href="https://example.com/app/invoices/cm_apr_2026_initech">cm_apr_2026_initech.pdf</a></p>',
    'Thanks, Initech! Your April invoice of $1,299.00 has been paid.',
    NULL, 'resend_inv_carla_apr', 'sent',
    (CAST(strftime('%s','now') AS INTEGER) - 86400 * 15),
    (CAST(strftime('%s','now') AS INTEGER) - 86400 * 15)),

  ('s_inv_frank_apr', 'p_frank', 'billing@example.com', 'frank.liu@soylent.corp',
    'Invoice cm_apr_2026_soylent — payment failed, retrying',
    '<p>Hi Frank — your April invoice of <strong>$249.00</strong> failed to charge (card declined). We''ll retry in 3 days. Update your card here: <a href="https://example.com/app/billing">/app/billing</a>.</p>',
    'Hi Frank — your April invoice of $249.00 failed to charge. We''ll retry in 3 days. Update your card at /app/billing.',
    NULL, 'resend_inv_frank_apr', 'sent',
    (CAST(strftime('%s','now') AS INTEGER) - 86400 * 15),
    (CAST(strftime('%s','now') AS INTEGER) - 86400 * 15)),

  ('s_inv_kim_apr', 'p_kim', 'billing@example.com', 'kim.park@acme.co',
    'Seat added — pro-rated charge of $41.58',
    '<p>Kim Park was added to the Acme workspace. A pro-rated charge of <strong>$41.58</strong> will appear on your next invoice.</p>',
    'Kim Park was added to the Acme workspace. A pro-rated charge of $41.58 will appear on your next invoice.',
    NULL, 'resend_inv_kim_apr', 'sent',
    (CAST(strftime('%s','now') AS INTEGER) - 86400 * 11 - 3600 * 20),
    (CAST(strftime('%s','now') AS INTEGER) - 86400 * 11 - 3600 * 20));

-- ----------------------------------------------------------------------------
-- Agent: Support Intent Classifier
--
-- Reads each inbound support email, classifies intent into one of three
-- categories, and outputs the exact pre-approved reply phrase.
--
-- Intent → reply mapping:
--   didn''t receive email  → "We''re looking into it!"
--   cannot connect to network → "follow this guide on lotsotravel"
--   do you have discount? → "yes, here''s the link"
--
-- The agent runs in "draft" mode so a human reviews before sending.
-- ----------------------------------------------------------------------------

-- Reply template — uses {{reply}} variable filled by the agent.
INSERT OR REPLACE INTO email_templates (id, slug, name, subject, body_html, from_address, created_at, updated_at) VALUES (
  'tpl_support_autoreply',
  'support-auto-reply',
  'Support Auto-Reply',
  'Re: Your inquiry',
  '<p>{{reply}}</p>',
  'support@example.com',
  CAST(strftime('%s','now') AS INTEGER),
  CAST(strftime('%s','now') AS INTEGER)
);

-- Agent definition — @cf/meta/llama-3.3-70b-instruct-fp8-fast is a good
-- structured-output model available on Cloudflare Workers AI.
INSERT OR REPLACE INTO agent_definitions (id, name, description, model_id, system_prompt, output_schema_json, max_runs_per_hour, is_active, created_at, updated_at) VALUES (
  'agent_support_classifier',
  'Support Intent Classifier',
  'Reads inbound support emails, classifies intent into one of three categories, and outputs the exact pre-approved reply phrase. Runs in draft mode for human review.',
  '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
  'You are a customer support agent for lotsotravel, a travel service.

Read the incoming email and classify the customer''s intent. Based on that intent, set the "reply" field to EXACTLY one of the following three phrases — copy the text verbatim with no changes, no greeting, no sign-off:

• If the customer says they did not receive an email or confirmation → reply: "We''re looking into it!"
• If the customer reports they cannot connect to the network or has connectivity problems → reply: "follow this guide on lotsotravel"
• If the customer is asking about discounts, promotions, or offers → reply: "yes, here''s the link"

Output only the reply field. Do not add any other text.',
  '{"type":"object","properties":{"reply":{"type":"string","description":"The exact pre-approved reply phrase for the classified intent"}},"required":["reply"]}',
  20,
  1,
  CAST(strftime('%s','now') AS INTEGER),
  CAST(strftime('%s','now') AS INTEGER)
);

-- Assignment — wires the classifier to the support inbox.
-- mailbox = support@example.com, person = any (*), mode = draft.
INSERT OR REPLACE INTO agent_assignments (id, agent_id, mailbox, person_id, template_slug, mode, is_active, created_at, updated_at) VALUES (
  'asgn_support_classifier',
  'agent_support_classifier',
  'support@example.com',
  NULL,
  'support-auto-reply',
  'draft',
  1,
  CAST(strftime('%s','now') AS INTEGER),
  CAST(strftime('%s','now') AS INTEGER)
);

-- ----------------------------------------------------------------------------
-- Recompute people.last_email_at / unread_count / total_count from the emails
-- we just inserted. This keeps the list view consistent with the actual data.
-- ----------------------------------------------------------------------------
UPDATE people
SET
  last_email_at = COALESCE((SELECT MAX(received_at) FROM emails WHERE person_id = people.id), last_email_at),
  unread_count  = (SELECT COUNT(*) FROM emails WHERE person_id = people.id AND is_read = 0),
  total_count   = (SELECT COUNT(*) FROM emails WHERE person_id = people.id),
  updated_at    = CAST(strftime('%s','now') AS INTEGER);
