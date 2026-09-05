import { env, exports } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import { schema } from "../db/schema";
import { users } from "../db/auth.schema";
import { sessions } from "../db/auth.schema";
import { people } from "../db/people.schema";
import { emails } from "../db/emails.schema";
import { sentEmails } from "../db/sent-emails.schema";
import { attachments } from "../db/attachments.schema";
import { emailTemplates } from "../db/email-templates.schema";
import { sequences } from "../db/sequences.schema";
import { sequenceEnrollments } from "../db/sequence-enrollments.schema";
import { sequenceEmails } from "../db/sequence-emails.schema";
import { apiKeys } from "../db/api-keys.schema";
import { invitations } from "../db/invitations.schema";
import {
  passkeys,
  oauthClients,
  oauthConsents,
  oauthAccessTokens,
  oauthRefreshTokens,
} from "../db/auth.schema";
import { hashKey } from "../lib/crypto";

export function getDb() {
  return drizzle(env.DB, { schema });
}

/**
 * Apply all migration SQL files to set up the D1 schema.
 * We execute raw SQL to create tables since the test D1 starts empty.
 */
export async function applyMigrations() {
  const db = env.DB;

  const statements = [
    `CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE, email_verified INTEGER NOT NULL DEFAULT 0, image TEXT, created_at INTEGER NOT NULL DEFAULT (cast(unixepoch() * 1000 as integer)), updated_at INTEGER NOT NULL DEFAULT (cast(unixepoch() * 1000 as integer)), role TEXT, banned INTEGER DEFAULT 0, ban_reason TEXT, ban_expires INTEGER)`,
    `CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, expires_at INTEGER NOT NULL, token TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL DEFAULT (cast(unixepoch() * 1000 as integer)), updated_at INTEGER NOT NULL DEFAULT (cast(unixepoch() * 1000 as integer)), ip_address TEXT, user_agent TEXT, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, impersonated_by TEXT)`,
    `CREATE INDEX IF NOT EXISTS sessions_userId_idx ON sessions(user_id)`,
    `CREATE TABLE IF NOT EXISTS accounts (id TEXT PRIMARY KEY, account_id TEXT NOT NULL, provider_id TEXT NOT NULL, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, access_token TEXT, refresh_token TEXT, id_token TEXT, access_token_expires_at INTEGER, refresh_token_expires_at INTEGER, scope TEXT, password TEXT, created_at INTEGER NOT NULL DEFAULT (cast(unixepoch() * 1000 as integer)), updated_at INTEGER NOT NULL DEFAULT (cast(unixepoch() * 1000 as integer)))`,
    `CREATE INDEX IF NOT EXISTS accounts_userId_idx ON accounts(user_id)`,
    `CREATE TABLE IF NOT EXISTS verifications (id TEXT PRIMARY KEY, identifier TEXT NOT NULL, value TEXT NOT NULL, expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL DEFAULT (cast(unixepoch() * 1000 as integer)), updated_at INTEGER NOT NULL DEFAULT (cast(unixepoch() * 1000 as integer)))`,
    `CREATE INDEX IF NOT EXISTS verifications_identifier_idx ON verifications(identifier)`,
    `CREATE TABLE IF NOT EXISTS passkeys (id TEXT PRIMARY KEY, name TEXT, public_key TEXT NOT NULL, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, credential_id TEXT NOT NULL, counter INTEGER NOT NULL, device_type TEXT NOT NULL, backed_up INTEGER NOT NULL, transports TEXT, created_at INTEGER, aaguid TEXT)`,
    `CREATE INDEX IF NOT EXISTS passkeys_userId_idx ON passkeys(user_id)`,
    `CREATE INDEX IF NOT EXISTS passkeys_credentialID_idx ON passkeys(credential_id)`,
    `CREATE TABLE IF NOT EXISTS jwkss (id TEXT PRIMARY KEY, public_key TEXT NOT NULL, private_key TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER)`,
    `CREATE TABLE IF NOT EXISTS oauth_clients (id TEXT PRIMARY KEY, client_id TEXT NOT NULL UNIQUE, client_secret TEXT, disabled INTEGER DEFAULT 0, skip_consent INTEGER, enable_end_session INTEGER, subject_type TEXT, scopes TEXT, user_id TEXT REFERENCES users(id) ON DELETE CASCADE, created_at INTEGER, updated_at INTEGER, name TEXT, uri TEXT, icon TEXT, contacts TEXT, tos TEXT, policy TEXT, software_id TEXT, software_version TEXT, software_statement TEXT, redirect_uris TEXT NOT NULL, post_logout_redirect_uris TEXT, token_endpoint_auth_method TEXT, grant_types TEXT, response_types TEXT, public INTEGER, type TEXT, require_pkce INTEGER, reference_id TEXT, metadata TEXT)`,
    `CREATE TABLE IF NOT EXISTS oauth_refresh_tokens (id TEXT PRIMARY KEY, token TEXT NOT NULL, client_id TEXT NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE, session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, reference_id TEXT, expires_at INTEGER, created_at INTEGER, revoked INTEGER, auth_time INTEGER, scopes TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS oauth_access_tokens (id TEXT PRIMARY KEY, token TEXT UNIQUE, client_id TEXT NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE, session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL, user_id TEXT REFERENCES users(id) ON DELETE CASCADE, reference_id TEXT, refresh_id TEXT REFERENCES oauth_refresh_tokens(id) ON DELETE CASCADE, expires_at INTEGER, created_at INTEGER, scopes TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS oauth_consents (id TEXT PRIMARY KEY, client_id TEXT NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE, user_id TEXT REFERENCES users(id) ON DELETE CASCADE, reference_id TEXT, scopes TEXT NOT NULL, created_at INTEGER, updated_at INTEGER)`,
    `CREATE TABLE IF NOT EXISTS people (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT, last_email_at INTEGER NOT NULL, unread_count INTEGER NOT NULL DEFAULT 0, total_count INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`,
    `CREATE INDEX IF NOT EXISTS people_last_email_at_idx ON people(last_email_at)`,
    `CREATE TABLE IF NOT EXISTS emails (id TEXT PRIMARY KEY, person_id TEXT NOT NULL, recipient TEXT NOT NULL, subject TEXT, body_html TEXT, body_text TEXT, raw_headers TEXT, message_id TEXT UNIQUE, spf TEXT, dkim TEXT, dmarc TEXT, spam_score REAL, is_read INTEGER NOT NULL DEFAULT 0, cc TEXT, conversation_id TEXT, received_at INTEGER NOT NULL, created_at INTEGER NOT NULL)`,
    `CREATE INDEX IF NOT EXISTS emails_person_received_idx ON emails(person_id, received_at)`,
    `CREATE INDEX IF NOT EXISTS emails_recipient_received_idx ON emails(recipient, received_at)`,
    `CREATE TABLE IF NOT EXISTS sent_emails (id TEXT PRIMARY KEY, person_id TEXT, from_address TEXT NOT NULL, to_address TEXT NOT NULL, subject TEXT NOT NULL, body_html TEXT, body_text TEXT, in_reply_to TEXT, message_id TEXT, resend_id TEXT, status TEXT NOT NULL DEFAULT 'sent', cc TEXT, conversation_id TEXT, campaign_id TEXT, sent_at INTEGER NOT NULL, created_at INTEGER NOT NULL)`,
    `CREATE INDEX IF NOT EXISTS sent_emails_person_sent_idx ON sent_emails(person_id, sent_at)`,
    `CREATE TABLE IF NOT EXISTS attachments (id TEXT PRIMARY KEY, email_id TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'inbound', filename TEXT NOT NULL, content_type TEXT NOT NULL, size INTEGER NOT NULL, r2_key TEXT NOT NULL, content_id TEXT, created_at INTEGER NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS email_templates (id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, name TEXT NOT NULL, subject TEXT NOT NULL, body_html TEXT NOT NULL, format TEXT NOT NULL DEFAULT 'html', body_json TEXT, from_address TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS newsletter_assets (id TEXT PRIMARY KEY, r2_key TEXT NOT NULL, content_type TEXT NOT NULL, size INTEGER NOT NULL, width INTEGER NOT NULL, height INTEGER NOT NULL, sha256 TEXT NOT NULL, created_by TEXT NOT NULL, created_at INTEGER NOT NULL)`,
    `CREATE INDEX IF NOT EXISTS newsletter_assets_sha256_idx ON newsletter_assets(sha256)`,
    `CREATE TABLE IF NOT EXISTS api_keys (id TEXT PRIMARY KEY, user_id TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE, key_hash TEXT NOT NULL, key_prefix TEXT NOT NULL, created_at INTEGER NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS invitations (id TEXT PRIMARY KEY, token TEXT NOT NULL UNIQUE, role TEXT NOT NULL DEFAULT 'member', email TEXT, expires_at INTEGER NOT NULL, used_by TEXT REFERENCES users(id) ON DELETE SET NULL, used_at INTEGER, created_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, created_at INTEGER NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS sequences (id TEXT PRIMARY KEY, name TEXT NOT NULL, steps TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS sequence_enrollments (id TEXT PRIMARY KEY, sequence_id TEXT NOT NULL, person_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', variables TEXT NOT NULL DEFAULT '{}', from_address TEXT NOT NULL DEFAULT '', enrolled_at INTEGER NOT NULL, cancelled_at INTEGER)`,
    `CREATE INDEX IF NOT EXISTS enrollments_person_status_idx ON sequence_enrollments(person_id, status)`,
    `CREATE TABLE IF NOT EXISTS sequence_emails (id TEXT PRIMARY KEY, enrollment_id TEXT NOT NULL, step_order INTEGER NOT NULL, template_slug TEXT NOT NULL, scheduled_at INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'pending', sent_at INTEGER, sent_email_id TEXT)`,
    `CREATE INDEX IF NOT EXISTS seq_emails_status_scheduled_idx ON sequence_emails(status, scheduled_at)`,
    `CREATE TABLE IF NOT EXISTS sender_identities (email TEXT PRIMARY KEY NOT NULL, display_name TEXT, display_mode TEXT NOT NULL DEFAULT 'thread', signature_html TEXT, forward_to TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS inbox_permissions (user_id TEXT NOT NULL, email TEXT NOT NULL, created_at INTEGER NOT NULL, created_by TEXT, PRIMARY KEY(user_id, email), FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE, FOREIGN KEY(created_by) REFERENCES users(id) ON DELETE SET NULL)`,
    `CREATE INDEX IF NOT EXISTS inbox_permissions_email_idx ON inbox_permissions(email)`,
    `CREATE TABLE IF NOT EXISTS push_subscriptions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, endpoint TEXT NOT NULL, p256dh TEXT NOT NULL, auth TEXT NOT NULL, user_agent TEXT, created_at INTEGER NOT NULL, last_used_at INTEGER)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS push_subscriptions_endpoint_idx ON push_subscriptions(endpoint)`,
    `CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT, updated_at INTEGER NOT NULL, updated_by TEXT)`,
    `CREATE INDEX IF NOT EXISTS push_subscriptions_user_idx ON push_subscriptions(user_id)`,
    `CREATE TABLE IF NOT EXISTS suppressions (id TEXT PRIMARY KEY, email TEXT NOT NULL, reason TEXT NOT NULL, source TEXT, note TEXT, created_at INTEGER NOT NULL)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS suppressions_email_unique ON suppressions(email)`,
    `CREATE TABLE IF NOT EXISTS blocklist (id TEXT PRIMARY KEY, type TEXT NOT NULL, value TEXT NOT NULL, note TEXT, created_by TEXT, created_at INTEGER NOT NULL)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS blocklist_type_value_unique ON blocklist(type, value)`,
    `CREATE TABLE IF NOT EXISTS outbox_emails (id TEXT PRIMARY KEY, sent_email_id TEXT NOT NULL, sequence_email_id TEXT, campaign_recipient_id TEXT, from_address TEXT NOT NULL, to_address TEXT NOT NULL, cc TEXT, subject TEXT NOT NULL, body_html TEXT, body_text TEXT, headers TEXT, transactional INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT, next_retry_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`,
    `CREATE INDEX IF NOT EXISTS outbox_status_retry_idx ON outbox_emails(status, next_retry_at)`,
    `CREATE INDEX IF NOT EXISTS outbox_from_idx ON outbox_emails(from_address)`,
    `CREATE TABLE IF NOT EXISTS drafts (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, context_key TEXT NOT NULL, from_address TEXT, to_address TEXT, cc TEXT, subject TEXT, body_html TEXT, body_text TEXT, reply_to_email_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS drafts_user_context_idx ON drafts(user_id, context_key)`,
    // Newsletter module (migration 0035).
    `CREATE TABLE IF NOT EXISTS async_jobs (id TEXT PRIMARY KEY, job_type TEXT NOT NULL, ref_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'running', cursor TEXT, storage_key TEXT, total_rows INTEGER, processed_rows INTEGER NOT NULL DEFAULT 0, imported_count INTEGER NOT NULL DEFAULT 0, skipped_count INTEGER NOT NULL DEFAULT 0, error_summary TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`,
    `CREATE INDEX IF NOT EXISTS async_jobs_ref_idx ON async_jobs(job_type, ref_id)`,
    `CREATE INDEX IF NOT EXISTS async_jobs_status_idx ON async_jobs(status)`,
    `CREATE TABLE IF NOT EXISTS contacts (id TEXT PRIMARY KEY, email TEXT NOT NULL, name TEXT, person_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS contacts_email_unique ON contacts(email)`,
    `CREATE INDEX IF NOT EXISTS contacts_person_id_idx ON contacts(person_id)`,
    `CREATE TABLE IF NOT EXISTS lists (id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT, from_address TEXT NOT NULL, double_opt_in INTEGER NOT NULL DEFAULT 0, confirmation_template_slug TEXT, archived_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`,
    `CREATE INDEX IF NOT EXISTS lists_from_address_idx ON lists(from_address)`,
    `CREATE INDEX IF NOT EXISTS lists_archived_at_idx ON lists(archived_at)`,
    `CREATE TABLE IF NOT EXISTS list_members (id TEXT PRIMARY KEY, list_id TEXT NOT NULL, contact_id TEXT NOT NULL, email TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', source TEXT NOT NULL, form_id TEXT, submitted_ip TEXT, consent_source TEXT NOT NULL, consent_at INTEGER, import_job_id TEXT, subscribed_at INTEGER, confirmed_at INTEGER, unsubscribed_at INTEGER, unsubscribe_reason TEXT, created_at INTEGER NOT NULL)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS list_members_list_contact_unique ON list_members(list_id, contact_id)`,
    `CREATE INDEX IF NOT EXISTS list_members_list_status_id_idx ON list_members(list_id, status, id)`,
    `CREATE INDEX IF NOT EXISTS list_members_email_idx ON list_members(email)`,
    `CREATE TABLE IF NOT EXISTS subscribe_forms (id TEXT PRIMARY KEY, list_id TEXT NOT NULL, name TEXT NOT NULL, show_name_field INTEGER NOT NULL DEFAULT 1, name_required INTEGER NOT NULL DEFAULT 0, success_message TEXT NOT NULL DEFAULT 'Thanks for subscribing!', redirect_url TEXT, allowed_origins TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`,
    `CREATE INDEX IF NOT EXISTS subscribe_forms_list_idx ON subscribe_forms(list_id)`,
    `CREATE TABLE IF NOT EXISTS subscribe_attempts (id TEXT PRIMARY KEY, form_id TEXT NOT NULL, email_hash TEXT NOT NULL, ip TEXT NOT NULL, attempt_type TEXT NOT NULL, created_at INTEGER NOT NULL)`,
    `CREATE INDEX IF NOT EXISTS subscribe_attempts_form_email_idx ON subscribe_attempts(form_id, email_hash, created_at)`,
    `CREATE INDEX IF NOT EXISTS subscribe_attempts_ip_idx ON subscribe_attempts(ip, created_at)`,
    `CREATE INDEX IF NOT EXISTS subscribe_attempts_created_idx ON subscribe_attempts(created_at)`,
    `CREATE TABLE IF NOT EXISTS campaigns (id TEXT PRIMARY KEY, name TEXT NOT NULL, subject TEXT NOT NULL, template_slug TEXT, format TEXT NOT NULL DEFAULT 'html', body_json TEXT, body_html TEXT NOT NULL DEFAULT '', from_address TEXT NOT NULL, list_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'draft', scheduled_at INTEGER, content_snapshot_at INTEGER, subject_snapshot TEXT, html_snapshot TEXT, text_body_override TEXT, text_snapshot TEXT, from_address_snapshot TEXT, template_revision TEXT, unsubscribe_domain_key_version INTEGER NOT NULL DEFAULT 1, fan_out_cursor TEXT, fan_out_job_id TEXT, sent_at INTEGER, stats_targeted INTEGER NOT NULL DEFAULT 0, stats_delivered INTEGER NOT NULL DEFAULT 0, stats_suppressed INTEGER NOT NULL DEFAULT 0, stats_retryable_failed INTEGER NOT NULL DEFAULT 0, stats_permanent_failed INTEGER NOT NULL DEFAULT 0, stats_unique_openers INTEGER NOT NULL DEFAULT 0, stats_unique_clicks INTEGER NOT NULL DEFAULT 0, stats_unsubscribes INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`,
    `CREATE INDEX IF NOT EXISTS campaigns_list_idx ON campaigns(list_id)`,
    `CREATE INDEX IF NOT EXISTS campaigns_from_address_idx ON campaigns(from_address)`,
    `CREATE INDEX IF NOT EXISTS campaigns_status_scheduled_idx ON campaigns(status, scheduled_at)`,
    `CREATE TABLE IF NOT EXISTS campaign_recipients (id TEXT PRIMARY KEY, campaign_id TEXT NOT NULL, contact_id TEXT NOT NULL, email TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'queued', idempotency_key TEXT NOT NULL, outbox_id TEXT, sent_email_id TEXT, attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT, queued_at INTEGER NOT NULL, processed_at INTEGER)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS campaign_recipients_campaign_contact_unique ON campaign_recipients(campaign_id, contact_id)`,
    `CREATE INDEX IF NOT EXISTS campaign_recipients_campaign_status_idx ON campaign_recipients(campaign_id, status)`,
    `CREATE TABLE IF NOT EXISTS campaign_links (id TEXT PRIMARY KEY, campaign_id TEXT NOT NULL, url TEXT NOT NULL, created_at INTEGER NOT NULL)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS campaign_links_campaign_url_unique ON campaign_links(campaign_id, url)`,
    `CREATE TABLE IF NOT EXISTS campaign_events (id TEXT PRIMARY KEY, campaign_id TEXT NOT NULL, contact_id TEXT NOT NULL, email TEXT NOT NULL, event_type TEXT NOT NULL, campaign_link_id TEXT, occurred_at INTEGER NOT NULL)`,
    `CREATE INDEX IF NOT EXISTS campaign_events_campaign_type_idx ON campaign_events(campaign_id, event_type)`,
    `CREATE INDEX IF NOT EXISTS campaign_events_campaign_occurred_idx ON campaign_events(campaign_id, occurred_at)`,
    // The partial unique indexes are the actual dedup mechanism (migration
    // 0038); a plain composite index would not enforce it, so the test schema
    // must carry them or dedup tests would pass against a weaker table.
    `CREATE UNIQUE INDEX IF NOT EXISTS campaign_events_open_unique ON campaign_events(campaign_id, contact_id) WHERE event_type = 'open'`,
    `CREATE UNIQUE INDEX IF NOT EXISTS campaign_events_click_unique ON campaign_events(campaign_id, contact_id, campaign_link_id) WHERE event_type = 'click'`,
    `CREATE TABLE IF NOT EXISTS campaign_unsubscribe_attributions (id TEXT PRIMARY KEY, campaign_id TEXT NOT NULL, list_member_id TEXT NOT NULL, occurred_at INTEGER NOT NULL)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS campaign_unsub_attr_campaign_member_unique ON campaign_unsubscribe_attributions(campaign_id, list_member_id)`,
  ];

  for (const sql of statements) {
    await db.exec(sql);
  }

  // FTS5 virtual table + triggers (custom migration, not in schema statements above)
  await db.exec(
    `CREATE VIRTUAL TABLE IF NOT EXISTS emails_fts USING fts5(subject, body_text, content='emails', content_rowid='rowid')`,
  );
  await db.exec(
    `CREATE TRIGGER IF NOT EXISTS emails_fts_ai AFTER INSERT ON emails BEGIN INSERT INTO emails_fts(rowid, subject, body_text) VALUES (new.rowid, new.subject, new.body_text); END`,
  );
  await db.exec(
    `CREATE TRIGGER IF NOT EXISTS emails_fts_ad AFTER DELETE ON emails BEGIN INSERT INTO emails_fts(emails_fts, rowid, subject, body_text) VALUES ('delete', old.rowid, old.subject, old.body_text); END`,
  );
  await db.exec(
    `CREATE TRIGGER IF NOT EXISTS emails_fts_au AFTER UPDATE ON emails BEGIN INSERT INTO emails_fts(emails_fts, rowid, subject, body_text) VALUES ('delete', old.rowid, old.subject, old.body_text); INSERT INTO emails_fts(rowid, subject, body_text) VALUES (new.rowid, new.subject, new.body_text); END`,
  );
}

/** Insert a test user with an API key for auth. Returns userId and apiKey. */
export async function createTestUser(
  opts: { id?: string; role?: string; name?: string; email?: string } = {},
) {
  const db = getDb();
  const userId = opts.id ?? "test-user-1";
  const now = Date.now();

  await db.insert(users).values({
    id: userId,
    name: opts.name ?? "Test User",
    email: opts.email ?? "test@example.com",
    emailVerified: false,
    createdAt: new Date(now),
    updatedAt: new Date(now),
    role: opts.role ?? "admin",
  });

  // Create API key for auth in tests (BetterAuth sessions require token hashing we can't easily replicate)
  const rawKey = `sk_${userId
    .replace(/[^a-f0-9]/g, "0")
    .padEnd(32, "0")
    .slice(0, 32)}`;
  const keyHash = await hashKey(rawKey);

  await db.insert(apiKeys).values({
    id: `api-key-${userId}`,
    userId,
    keyHash,
    keyPrefix: rawKey.slice(0, 8) + "...",
    createdAt: Math.floor(now / 1000),
  });

  return { userId, apiKey: rawKey };
}

/** Create a test person. */
export async function createTestPerson(
  opts: {
    id?: string;
    email?: string;
    name?: string;
    unreadCount?: number;
    totalCount?: number;
  } = {},
) {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  const person = {
    id: opts.id ?? "sender-1",
    email: opts.email ?? "alice@example.com",
    name: opts.name ?? "Alice",
    lastEmailAt: now,
    unreadCount: opts.unreadCount ?? 1,
    totalCount: opts.totalCount ?? 1,
    createdAt: now,
    updatedAt: now,
  };
  await db.insert(people).values(person);
  return person;
}

/** Create a test received email. */
export async function createTestEmail(
  opts: {
    id?: string;
    personId?: string;
    recipient?: string;
    subject?: string;
    bodyText?: string;
    messageId?: string;
    isRead?: number;
    rawHeaders?: string;
    conversationId?: string | null;
    cc?: string | null;
  } = {},
) {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  const email = {
    id: opts.id ?? "email-1",
    personId: opts.personId ?? "sender-1",
    recipient: opts.recipient ?? "inbox@saasmail.test",
    subject: opts.subject ?? "Test Subject",
    bodyHtml: "<p>Hello</p>",
    bodyText: opts.bodyText ?? "Hello",
    rawHeaders: opts.rawHeaders ?? "{}",
    messageId: opts.messageId ?? "msg-1@example.com",
    isRead: opts.isRead ?? 0,
    conversationId: opts.conversationId ?? null,
    cc: opts.cc ?? null,
    receivedAt: now,
    createdAt: now,
  };
  await db.insert(emails).values(email);
  return email;
}

/** Create a test email template. */
export async function createTestTemplate(
  opts: {
    slug?: string;
    name?: string;
    subject?: string;
    bodyHtml?: string;
  } = {},
) {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  const template = {
    id: `tmpl-${opts.slug ?? "welcome"}`,
    slug: opts.slug ?? "welcome",
    name: opts.name ?? "Welcome",
    subject: opts.subject ?? "Hello {{name}}",
    bodyHtml: opts.bodyHtml ?? "<p>Hi {{name}}, welcome!</p>",
    createdAt: now,
    updatedAt: now,
  };
  await db.insert(emailTemplates).values(template);
  return template;
}

/** Make an authenticated API request. */
export async function authFetch(
  path: string,
  opts: RequestInit & { apiKey?: string } = {},
) {
  const { apiKey, ...init } = opts;

  const headers = new Headers(init.headers);

  if (apiKey) {
    headers.set("Authorization", `Bearer ${apiKey}`);
  }

  if (typeof init.body === "string" && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  return exports.default.fetch(`http://localhost${path}`, {
    ...init,
    headers,
  });
}

/**
 * Build a multipart/form-data body for POST /api/send.
 * The JSON payload goes in the `payload` field; files go in `files` fields.
 */
export function buildSendForm(
  payload: Record<string, unknown>,
  files: Array<{ name: string; type?: string; bytes: Uint8Array }> = [],
): FormData {
  const fd = new FormData();
  fd.append("payload", JSON.stringify(payload));
  for (const f of files) {
    fd.append(
      "files",
      new File([f.bytes], f.name, {
        type: f.type ?? "application/octet-stream",
      }),
    );
  }
  return fd;
}

/** Clean all tables between tests. */
export async function cleanDb() {
  const db = env.DB;
  await db.exec(`
    DELETE FROM campaign_unsubscribe_attributions;
    DELETE FROM campaign_events;
    DELETE FROM campaign_links;
    DELETE FROM campaign_recipients;
    DELETE FROM campaigns;
    DELETE FROM subscribe_attempts;
    DELETE FROM subscribe_forms;
    DELETE FROM list_members;
    DELETE FROM lists;
    DELETE FROM contacts;
    DELETE FROM async_jobs;
    DELETE FROM drafts;
    DELETE FROM outbox_emails;
    DELETE FROM blocklist;
    DELETE FROM suppressions;
    DELETE FROM push_subscriptions;
    DELETE FROM inbox_permissions;
    DELETE FROM sender_identities;
    DELETE FROM sequence_emails;
    DELETE FROM sequence_enrollments;
    DELETE FROM sequences;
    DELETE FROM attachments;
    DELETE FROM sent_emails;
    DELETE FROM emails;
    DELETE FROM people;
    DELETE FROM newsletter_assets;
    DELETE FROM email_templates;
    DELETE FROM api_keys;
    DELETE FROM invitations;
    DELETE FROM app_settings;
    DELETE FROM oauth_consents;
    DELETE FROM oauth_access_tokens;
    DELETE FROM oauth_refresh_tokens;
    DELETE FROM oauth_clients;
    DELETE FROM passkeys;
    DELETE FROM sessions;
    DELETE FROM accounts;
    DELETE FROM verifications;
    DELETE FROM jwkss;
    DELETE FROM users;
  `);
}
