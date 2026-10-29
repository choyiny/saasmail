// docs/doctor.md: the admin doctor's runtime checks and the build stamp.
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { buildInfo } from "../lib/build-info";
import {
  DOCTOR_CHECKS,
  LAST_CRON_AT_KEY,
  recordCronTick,
  runDoctor,
  type Check,
  type CheckResult,
} from "../lib/doctor";
import { applyMigrations, cleanDb, getDb } from "./helpers";

const NOW = 1_800_000_000;

function fakeEnv(overrides: Record<string, unknown> = {}): CloudflareBindings {
  return { ...env, ...overrides } as unknown as CloudflareBindings;
}

async function report(
  overrides: Record<string, unknown> = {},
  options: Parameters<typeof runDoctor>[1] = {},
) {
  return runDoctor(fakeEnv(overrides), { db: getDb(), now: NOW, ...options });
}

function check(checks: CheckResult[], id: string): CheckResult {
  const found = checks.find((c) => c.id === id);
  expect(found, `check ${id}`).toBeDefined();
  return found!;
}

async function markAllMigrationsApplied(except: string[] = []) {
  const db = getDb();
  await db.run(sql`DELETE FROM d1_migrations`);
  for (const name of buildInfo().migrations) {
    if (except.includes(name)) continue;
    await db.run(sql`INSERT INTO d1_migrations (name) VALUES (${name})`);
  }
}

describe("runDoctor", () => {
  beforeAll(async () => {
    await applyMigrations();
    await getDb().run(
      sql`CREATE TABLE IF NOT EXISTS d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)`,
    );
  });
  beforeEach(async () => {
    await cleanDb();
    await markAllMigrationsApplied();
    await recordCronTick(getDb(), NOW - 60);
  });

  it("migrations: a file not applied fails, an unknown applied name warns", async () => {
    const newest = buildInfo().migrations.at(-1)!;
    await markAllMigrationsApplied([newest]);
    await getDb().run(
      sql`INSERT INTO d1_migrations (name) VALUES ('9999_from_the_future.sql')`,
    );
    const { checks } = await report();
    const pending = check(checks, "migrations.pending");
    expect(pending.status).toBe("fail");
    expect(pending.summary).toContain(newest);
    expect(pending.hint).toContain("migrations apply");
    expect(check(checks, "migrations.unknown").status).toBe("warn");
  });

  it("migrations: all applied passes", async () => {
    const { checks } = await report();
    expect(check(checks, "migrations.pending").status).toBe("pass");
    expect(check(checks, "migrations.unknown").status).toBe("pass");
  });

  it("secrets: a missing BETTER_AUTH_SECRET fails", async () => {
    const { checks } = await report({ BETTER_AUTH_SECRET: undefined });
    expect(check(checks, "secrets.better_auth").status).toBe("fail");
  });

  it("secrets: the passkey gate off on a public BASE_URL fails, on localhost it does not", async () => {
    const off = await report({
      DISABLE_PASSKEY_GATE: "true",
      BASE_URL: "https://mail.example.com",
    });
    expect(check(off.checks, "secrets.dev_flags").status).toBe("fail");
    const local = await report({
      DISABLE_PASSKEY_GATE: "true",
      BASE_URL: "http://localhost:8080",
    });
    expect(check(local.checks, "secrets.dev_flags").status).not.toBe("fail");
  });

  it("secrets: a Gmail account without TOKEN_ENCRYPTION_KEY fails", async () => {
    await getDb().run(
      sql`INSERT INTO gmail_accounts (id, email_address, refresh_token_encrypted, created_at, updated_at) VALUES ('g1', 'box@example.com', 'sealed', ${NOW}, ${NOW})`,
    );
    const { checks } = await report({ TOKEN_ENCRYPTION_KEY: undefined });
    expect(check(checks, "secrets.token_encryption").status).toBe("fail");
    const without = await report({ TOKEN_ENCRYPTION_KEY: "set" });
    expect(check(without.checks, "secrets.token_encryption").status).toBe(
      "pass",
    );
  });

  it("secrets: a Google OAuth app set by env vars without TOKEN_ENCRYPTION_KEY fails", async () => {
    const envApp = await report({ TOKEN_ENCRYPTION_KEY: undefined });
    expect(check(envApp.checks, "secrets.token_encryption").status).toBe(
      "fail",
    );
    const none = await report({
      TOKEN_ENCRYPTION_KEY: undefined,
      GOOGLE_OAUTH_CLIENT_ID: undefined,
      GOOGLE_OAUTH_CLIENT_SECRET: undefined,
    });
    expect(check(none.checks, "secrets.token_encryption").status).toBe("info");
  });

  it("provider: NoopSender fails, and warns instead with a Gmail-mapped inbox", async () => {
    const noProvider = { RESEND_API_KEY: undefined, EMAIL: undefined };
    const alone = await report(noProvider);
    expect(check(alone.checks, "provider.outbound").status).toBe("fail");

    await getDb().run(
      sql`INSERT INTO sender_identities (email, source, gmail_account_id, created_at, updated_at) VALUES ('help@example.com', 'gmail', 'g1', ${NOW}, ${NOW})`,
    );
    const mapped = await report(noProvider);
    const outbound = check(mapped.checks, "provider.outbound");
    expect(outbound.status).toBe("warn");
    expect(outbound.summary).toContain("NoopSender");
  });

  it("provider: names the provider class on pass", async () => {
    const { checks } = await report();
    const outbound = check(checks, "provider.outbound");
    expect(outbound.status).toBe("pass");
    expect(outbound.summary).toContain("ResendSender");
  });

  it("bindings: a missing required binding fails", async () => {
    const { checks } = await report({ EMAIL_QUEUE: undefined });
    const required = check(checks, "bindings.required");
    expect(required.status).toBe("fail");
    expect(required.summary).toContain("EMAIL_QUEUE");
  });

  it("cron: a stale last_cron_at fails, a recent one passes", async () => {
    expect(check((await report()).checks, "cron.last_tick").status).toBe(
      "pass",
    );
    await recordCronTick(getDb(), NOW - 3 * 60 * 60);
    const stale = check((await report()).checks, "cron.last_tick");
    expect(stale.status).toBe("fail");
    expect(stale.hint).toContain("cron trigger");
    await getDb().run(
      sql`DELETE FROM app_settings WHERE key = ${LAST_CRON_AT_KEY}`,
    );
    expect(check((await report()).checks, "cron.last_tick").status).toBe(
      "fail",
    );
  });

  it("outbox: a stuck pending row warns", async () => {
    expect(check((await report()).checks, "outbox.stuck").status).toBe("pass");
    await getDb().run(
      sql`INSERT INTO outbox_emails (id, sent_email_id, from_address, to_address, subject, status, next_retry_at, created_at, updated_at) VALUES ('o1', 's1', 'a@example.com', 'b@example.com', 'Hi', 'pending', ${NOW - 2 * 60 * 60}, ${NOW - 3 * 60 * 60}, ${NOW - 2 * 60 * 60})`,
    );
    const stuck = check((await report()).checks, "outbox.stuck");
    expect(stuck.status).toBe("warn");
    expect(stuck.summary).toContain("1 pending");
  });

  it("backups: off is info, on without a recent completed run warns", async () => {
    expect(check((await report()).checks, "backups.recent").status).toBe(
      "info",
    );
    await getDb().run(
      sql`INSERT INTO app_settings (key, value, updated_at) VALUES ('backup_enabled', 'true', ${NOW})`,
    );
    expect(check((await report()).checks, "backups.recent").status).toBe(
      "warn",
    );
  });

  it("a throwing check becomes warn and the others still run", async () => {
    const broken: Check = {
      id: "test.broken",
      group: "test",
      mandatory: false,
      async run() {
        throw new Error("boom");
      },
    };
    const brokenMandatory: Check = {
      ...broken,
      id: "test.mandatory",
      mandatory: true,
    };
    const { checks } = await report(
      {},
      { checks: [broken, brokenMandatory, ...DOCTOR_CHECKS] },
    );
    const result = check(checks, "test.broken");
    expect(result.status).toBe("warn");
    expect(result.summary).toContain("boom");
    expect(check(checks, "test.mandatory").status).toBe("fail");
    expect(check(checks, "migrations.pending").status).toBe("pass");
    expect(checks).toHaveLength(DOCTOR_CHECKS.length + 2);
  });
});
