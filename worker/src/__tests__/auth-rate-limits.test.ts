// docs/archive/SPEC-two-factor.md §1: sign-in rate limits that hold across
// Worker isolates.
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { env, exports } from "cloudflare:workers";
import { sql } from "drizzle-orm";
import {
  d1RateLimitStorage,
  pruneAuthRateLimits,
} from "../auth/rate-limit-storage";
import { applyMigrations, cleanDb, getDb } from "./helpers";
import { createUserWithPassword } from "./mcp-helpers";

const RULE = { window: 10, max: 3 };
/** As if better-auth served every path these tests use. */
const served = () => true;

describe("the D1 rate-limit storage", () => {
  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDb();
  });

  it("admits max requests in a window and refuses the next, with the wait", async () => {
    const storage = d1RateLimitStorage(getDb(), served);
    for (let i = 0; i < RULE.max; i++) {
      expect(await storage.consume("1.2.3.4|/sign-in/email", RULE)).toEqual({
        allowed: true,
        retryAfter: null,
      });
    }
    const refused = await storage.consume("1.2.3.4|/sign-in/email", RULE);
    expect(refused.allowed).toBe(false);
    expect(refused.retryAfter).toBeGreaterThan(0);
    expect(refused.retryAfter).toBeLessThanOrEqual(RULE.window);

    // Another address, or another path, has its own count.
    expect(
      (await storage.consume("5.6.7.8|/sign-in/email", RULE)).allowed,
    ).toBe(true);
    expect(
      (await storage.consume("1.2.3.4|/passkey/verify-authentication", RULE))
        .allowed,
    ).toBe(true);
  });

  it("starts the count again once the window has closed", async () => {
    const storage = d1RateLimitStorage(getDb(), served);
    for (let i = 0; i <= RULE.max; i++) {
      await storage.consume("k", RULE);
    }
    expect((await storage.consume("k", RULE)).allowed).toBe(false);
    // Close the window as if 10 seconds had passed.
    await getDb().run(
      sql`UPDATE auth_rate_limits SET expires_at = ${Date.now() - 1}`,
    );
    expect((await storage.consume("k", RULE)).allowed).toBe(true);
    const [row] = await getDb().all<{ count: number }>(
      sql`SELECT count FROM auth_rate_limits WHERE key = 'k'`,
    );
    expect(Number(row.count)).toBe(1);
  });

  it("counts every one of many concurrent requests", async () => {
    const storage = d1RateLimitStorage(getDb(), served);
    const results = await Promise.all(
      Array.from({ length: 10 }, () => storage.consume("k", RULE)),
    );
    expect(results.filter((r) => r.allowed)).toHaveLength(RULE.max);
    const [row] = await getDb().all<{ count: number }>(
      sql`SELECT count FROM auth_rate_limits WHERE key = 'k'`,
    );
    expect(Number(row.count)).toBe(10);
  });

  it("reads a live counter, and nothing once it expired", async () => {
    const storage = d1RateLimitStorage(getDb(), served);
    await storage.consume("k", RULE);
    await storage.consume("k", RULE);
    expect(await storage.get("k")).toMatchObject({ key: "k", count: 2 });
    await getDb().run(
      sql`UPDATE auth_rate_limits SET expires_at = ${Date.now() - 1}`,
    );
    expect(await storage.get("k")).toBeNull();
  });

  it("counts made-up paths in one shared row per address", async () => {
    const storage = d1RateLimitStorage(getDb(), (path) => path === "/real");
    await storage.consume("9.9.9.9|/made-up-1", RULE);
    await storage.consume("9.9.9.9|/made-up-2", RULE);
    await storage.consume("9.9.9.9|/real", RULE);
    const rows = await getDb().all<{ key: string; count: number }>(
      sql`SELECT key, count FROM auth_rate_limits ORDER BY key`,
    );
    expect(rows.map((row) => [row.key, Number(row.count)])).toEqual([
      ["9.9.9.9|/real", 1],
      ["9.9.9.9|other", 2],
    ]);
  });

  it("prunes expired counters only", async () => {
    const storage = d1RateLimitStorage(getDb(), served);
    await storage.consume("old", RULE);
    await storage.consume("live", RULE);
    await getDb().run(
      sql`UPDATE auth_rate_limits SET expires_at = ${Date.now() - 1} WHERE key = 'old'`,
    );
    expect(await pruneAuthRateLimits(getDb(), Date.now())).toBe(1);
    const keys = await getDb().all<{ key: string }>(
      sql`SELECT key FROM auth_rate_limits`,
    );
    expect(keys.map((row) => row.key)).toEqual(["live"]);
  });
});

describe("rate-limited sign-in", () => {
  const signIn = (ip: string, password = "wrong-password") =>
    exports.default.fetch("http://localhost/api/auth/sign-in/email", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "cf-connecting-ip": ip,
      },
      body: JSON.stringify({ email: "jane@acme.com", password }),
    });

  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDb();
    await createUserWithPassword(
      { name: "Jane", email: "jane@acme.com", password: "right-password-1" },
      "member",
    );
    // The limiter is off in local development and tests; on here.
    (env as any).DISABLE_PASSKEY_GATE = "false";
  });

  afterEach(() => {
    (env as any).DISABLE_PASSKEY_GATE = "true";
  });

  it("refuses the fourth attempt from one address within 10 seconds, even with the right password", async () => {
    for (let i = 0; i < 3; i++) {
      expect((await signIn("203.0.113.7")).status).toBe(401);
    }
    const limited = await signIn("203.0.113.7", "right-password-1");
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("X-Retry-After"))).toBeGreaterThan(0);
    // Counted in D1, where every isolate sees it.
    const [row] = await getDb().all<{ count: number }>(
      sql`SELECT count FROM auth_rate_limits WHERE key LIKE '203.0.113.7%sign-in/email'`,
    );
    expect(Number(row.count)).toBe(4);

    // Another address is not held back by the first one's attempts.
    expect((await signIn("198.51.100.4", "right-password-1")).status).toBe(200);
  });

  it("keeps requests to paths better-auth does not serve in one row", async () => {
    for (let i = 0; i < 5; i++) {
      await exports.default.fetch(
        `http://localhost/api/auth/no-such-endpoint-${i}`,
        { method: "POST", headers: { "cf-connecting-ip": "203.0.113.9" } },
      );
    }
    const rows = await getDb().all<{ key: string; count: number }>(
      sql`SELECT key, count FROM auth_rate_limits WHERE key LIKE '203.0.113.9%'`,
    );
    expect(rows.map((row) => [row.key, Number(row.count)])).toEqual([
      ["203.0.113.9|other", 5],
    ]);
  });

  it("does not count reading the session", async () => {
    for (let i = 0; i < 5; i++) {
      await exports.default.fetch("http://localhost/api/auth/get-session", {
        headers: { "cf-connecting-ip": "203.0.113.7" },
      });
    }
    expect(
      await getDb().all(
        sql`SELECT key FROM auth_rate_limits WHERE key LIKE '%get-session%'`,
      ),
    ).toEqual([]);
  });
});
