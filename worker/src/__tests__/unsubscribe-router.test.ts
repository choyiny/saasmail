import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { exports } from "cloudflare:workers";
import { applyMigrations, cleanDb, getDb } from "./helpers";
import { signToken } from "../lib/unsubscribe-token";
import { suppressions } from "../db/suppressions.schema";

// Matches the binding in vitest.config.test.ts.
const SECRET = "test-secret-do-not-use-in-prod";

beforeAll(applyMigrations);
beforeEach(cleanDb);

describe("public unsubscribe endpoints", () => {
  it("POST /api/unsubscribe with valid token writes a suppression row", async () => {
    const token = await signToken("alice@example.com", SECRET);
    const r = await exports.default.fetch(
      `http://localhost/api/unsubscribe?token=${encodeURIComponent(token)}`,
      { method: "POST" },
    );
    expect(r.status).toBe(200);
    const body = (await r.json()) as { email: string; status: string };
    expect(body).toMatchObject({
      email: "alice@example.com",
      status: "suppressed",
    });

    const rows = await getDb().query.suppressions.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0].reason).toBe("unsubscribe");
    expect(rows[0].source).toBe("one-click");
  });

  it("source=user-link query overrides the default", async () => {
    const token = await signToken("alice@example.com", SECRET);
    await exports.default.fetch(
      `http://localhost/api/unsubscribe?token=${encodeURIComponent(token)}&source=user-link`,
      { method: "POST" },
    );
    const rows = await getDb().query.suppressions.findMany();
    expect(rows[0].source).toBe("user-link");
  });

  it("rejects a tampered token with 401", async () => {
    const token = await signToken("alice@example.com", SECRET);
    const tampered = token.slice(0, -2) + "AA";
    const r = await exports.default.fetch(
      `http://localhost/api/unsubscribe?token=${encodeURIComponent(tampered)}`,
      { method: "POST" },
    );
    expect(r.status).toBe(401);
    const rows = await getDb().query.suppressions.findMany();
    expect(rows).toHaveLength(0);
  });

  it("is idempotent: replaying does NOT duplicate or overwrite source", async () => {
    const token = await signToken("alice@example.com", SECRET);
    await exports.default.fetch(
      `http://localhost/api/unsubscribe?token=${encodeURIComponent(token)}&source=user-link`,
      { method: "POST" },
    );
    await exports.default.fetch(
      `http://localhost/api/unsubscribe?token=${encodeURIComponent(token)}`,
      { method: "POST" },
    );
    const rows = await getDb().query.suppressions.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0].source).toBe("user-link"); // first source preserved
  });

  it("POST /api/unsubscribe/undo deletes the row", async () => {
    await getDb()
      .insert(suppressions)
      .values({
        id: "s1",
        email: "alice@example.com",
        reason: "unsubscribe",
        source: "user-link",
        note: null,
        createdAt: Math.floor(Date.now() / 1000),
      });
    const token = await signToken("alice@example.com", SECRET);
    const r = await exports.default.fetch(
      `http://localhost/api/unsubscribe/undo?token=${encodeURIComponent(token)}`,
      { method: "POST" },
    );
    expect(r.status).toBe(200);
    const body = (await r.json()) as { email: string; status: string };
    expect(body).toMatchObject({
      email: "alice@example.com",
      status: "subscribed",
    });
    const rows = await getDb().query.suppressions.findMany();
    expect(rows).toHaveLength(0);
  });

  it("undo is idempotent if no row exists", async () => {
    const token = await signToken("nobody@example.com", SECRET);
    const r = await exports.default.fetch(
      `http://localhost/api/unsubscribe/undo?token=${encodeURIComponent(token)}`,
      { method: "POST" },
    );
    expect(r.status).toBe(200);
  });

  it("public endpoints work without any auth headers", async () => {
    // Critical bypass check: NO API key, NO session, just the token.
    const token = await signToken("alice@example.com", SECRET);
    const r = await exports.default.fetch(
      `http://localhost/api/unsubscribe?token=${encodeURIComponent(token)}`,
      { method: "POST" },
    );
    expect(r.status).toBe(200); // not 401 — the allowlist must let this through
  });

  // RFC 8058 one-click clients (Gmail, Fastmail, Apple Mail) POST directly to
  // the URL in the `List-Unsubscribe` header, which is the same URL we use for
  // the SPA body link (`/unsubscribe?token=...`). Without a Worker handler at
  // that path, those POSTs fell through to the SPA route and returned 405,
  // which the clients render as "We were unable to unsubscribe you."
  it("POST /unsubscribe (bare, no /api prefix) writes a suppression row", async () => {
    const token = await signToken("alice@example.com", SECRET);
    const r = await exports.default.fetch(
      `http://localhost/unsubscribe?token=${encodeURIComponent(token)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "List-Unsubscribe=One-Click",
      },
    );
    expect(r.status).toBe(200);
    const body = (await r.json()) as { email: string; status: string };
    expect(body).toMatchObject({
      email: "alice@example.com",
      status: "suppressed",
    });
    const rows = await getDb().query.suppressions.findMany();
    expect(rows).toHaveLength(1);
  });

  it("POST /unsubscribe/undo (bare, no /api prefix) deletes the row", async () => {
    const token = await signToken("alice@example.com", SECRET);
    // Insert first
    await exports.default.fetch(
      `http://localhost/unsubscribe?token=${encodeURIComponent(token)}`,
      { method: "POST" },
    );
    const r = await exports.default.fetch(
      `http://localhost/unsubscribe/undo?token=${encodeURIComponent(token)}`,
      { method: "POST" },
    );
    expect(r.status).toBe(200);
    const rows = await getDb().query.suppressions.findMany();
    expect(rows).toHaveLength(0);
  });
});
