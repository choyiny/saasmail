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
    `CREATE TABLE IF NOT EXISTS emails (id TEXT PRIMARY KEY, person_id TEXT NOT NULL, recipient TEXT NOT NULL, subject TEXT, body_html TEXT, body_text TEXT, raw_headers TEXT, message_id TEXT UNIQUE, spf TEXT, dkim TEXT, dmarc TEXT, is_read INTEGER NOT NULL DEFAULT 0, received_at INTEGER NOT NULL, created_at INTEGER NOT NULL)`,
    `CREATE INDEX IF NOT EXISTS emails_person_received_idx ON emails(person_id, received_at)`,
    `CREATE INDEX IF NOT EXISTS emails_recipient_received_idx ON emails(recipient, received_at)`,
    `CREATE TABLE IF NOT EXISTS sent_emails (id TEXT PRIMARY KEY, person_id TEXT, from_address TEXT NOT NULL, to_address TEXT NOT NULL, subject TEXT NOT NULL, body_html TEXT, body_text TEXT, in_reply_to TEXT, message_id TEXT, resend_id TEXT, status TEXT NOT NULL DEFAULT 'sent', sent_at INTEGER NOT NULL, created_at INTEGER NOT NULL)`,
    `CREATE INDEX IF NOT EXISTS sent_emails_person_sent_idx ON sent_emails(person_id, sent_at)`,
    `CREATE TABLE IF NOT EXISTS attachments (id TEXT PRIMARY KEY, email_id TEXT NOT NULL, filename TEXT NOT NULL, content_type TEXT NOT NULL, size INTEGER NOT NULL, r2_key TEXT NOT NULL, content_id TEXT, created_at INTEGER NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS email_templates (id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, name TEXT NOT NULL, subject TEXT NOT NULL, body_html TEXT NOT NULL, from_address TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS api_keys (id TEXT PRIMARY KEY, user_id TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE, key_hash TEXT NOT NULL, key_prefix TEXT NOT NULL, created_at INTEGER NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS invitations (id TEXT PRIMARY KEY, token TEXT NOT NULL UNIQUE, role TEXT NOT NULL DEFAULT 'member', email TEXT, expires_at INTEGER NOT NULL, used_by TEXT REFERENCES users(id) ON DELETE SET NULL, used_at INTEGER, created_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, created_at INTEGER NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS sequences (id TEXT PRIMARY KEY, name TEXT NOT NULL, steps TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS sequence_enrollments (id TEXT PRIMARY KEY, sequence_id TEXT NOT NULL, person_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', variables TEXT NOT NULL DEFAULT '{}', from_address TEXT NOT NULL DEFAULT '', enrolled_at INTEGER NOT NULL, cancelled_at INTEGER)`,
    `CREATE INDEX IF NOT EXISTS enrollments_person_status_idx ON sequence_enrollments(person_id, status)`,
    `CREATE TABLE IF NOT EXISTS sequence_emails (id TEXT PRIMARY KEY, enrollment_id TEXT NOT NULL, step_order INTEGER NOT NULL, template_slug TEXT NOT NULL, scheduled_at INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'pending', sent_at INTEGER, sent_email_id TEXT)`,
    `CREATE INDEX IF NOT EXISTS seq_emails_status_scheduled_idx ON sequence_emails(status, scheduled_at)`,
    `CREATE TABLE IF NOT EXISTS sender_identities (email TEXT PRIMARY KEY NOT NULL, display_name TEXT, display_mode TEXT NOT NULL DEFAULT 'thread', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS inbox_permissions (user_id TEXT NOT NULL, email TEXT NOT NULL, created_at INTEGER NOT NULL, created_by TEXT, PRIMARY KEY(user_id, email), FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE, FOREIGN KEY(created_by) REFERENCES users(id) ON DELETE SET NULL)`,
    `CREATE INDEX IF NOT EXISTS inbox_permissions_email_idx ON inbox_permissions(email)`,
    `CREATE TABLE IF NOT EXISTS push_subscriptions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, endpoint TEXT NOT NULL, p256dh TEXT NOT NULL, auth TEXT NOT NULL, user_agent TEXT, created_at INTEGER NOT NULL, last_used_at INTEGER)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS push_subscriptions_endpoint_idx ON push_subscriptions(endpoint)`,
    `CREATE INDEX IF NOT EXISTS push_subscriptions_user_idx ON push_subscriptions(user_id)`,
  ];

  for (const sql of statements) {
    await db.exec(sql);
  }
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
    messageId?: string;
    isRead?: number;
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
    bodyText: "Hello",
    rawHeaders: "{}",
    messageId: opts.messageId ?? "msg-1@example.com",
    isRead: opts.isRead ?? 0,
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

  if (init.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  return exports.default.fetch(`http://localhost${path}`, {
    ...init,
    headers,
  });
}

/** Clean all tables between tests. */
export async function cleanDb() {
  const db = env.DB;
  await db.exec(`
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
    DELETE FROM email_templates;
    DELETE FROM api_keys;
    DELETE FROM invitations;
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
