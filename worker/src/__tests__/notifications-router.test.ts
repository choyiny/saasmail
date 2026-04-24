/**
 * Exercises the failure branches of /api/notifications/stream:
 *   - 401 when no auth (session cookie or bearer token) is present
 *   - 426 when an authenticated request has no `Upgrade: websocket` header
 *   - 403 when an authenticated WS upgrade has a missing/untrusted Origin
 *
 * The success path (101 upgrade to the Durable Object) is not covered here:
 * it requires a live NOTIFICATIONS_HUB binding in the test wrangler config
 * and a real WebSocket-capable client. The branch that matters for safety is
 * the rejection surface, which is what this file locks down.
 */
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { exports } from "cloudflare:workers";
import { applyMigrations, cleanDb, createTestUser, authFetch } from "./helpers";

const STREAM_URL = "http://localhost/api/notifications/stream";

function wsHeaders(extra: Record<string, string> = {}): HeadersInit {
  return {
    Upgrade: "websocket",
    Connection: "Upgrade",
    ...extra,
  };
}

describe("notifications-router /stream", () => {
  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDb();
  });

  it("returns 401 for unauthenticated requests (no session, no bearer)", async () => {
    const res = await exports.default.fetch(STREAM_URL, {
      headers: wsHeaders({ Origin: "http://localhost:8080" }),
    });
    expect(res.status).toBe(401);
  });

  it("returns 401 for unauthenticated requests even without the upgrade header", async () => {
    // The global session middleware runs before the route, so auth is
    // rejected first regardless of the Upgrade header.
    const res = await exports.default.fetch(STREAM_URL);
    expect(res.status).toBe(401);
  });

  it("returns 426 when an authenticated request is missing Upgrade: websocket", async () => {
    const { apiKey } = await createTestUser();
    const res = await authFetch("/api/notifications/stream", {
      apiKey,
      headers: { Origin: "http://localhost:8080" },
    });
    expect(res.status).toBe(426);
    const body = await res.json();
    expect(body.error).toMatch(/websocket/i);
  });

  it("returns 403 when an authenticated WS upgrade has no Origin header", async () => {
    const { apiKey } = await createTestUser();
    const res = await authFetch("/api/notifications/stream", {
      apiKey,
      headers: wsHeaders(),
    });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toMatch(/forbidden/i);
  });

  it("returns 403 when an authenticated WS upgrade has an untrusted Origin", async () => {
    const { apiKey } = await createTestUser();
    const res = await authFetch("/api/notifications/stream", {
      apiKey,
      headers: wsHeaders({ Origin: "https://evil.example.com" }),
    });
    expect(res.status).toBe(403);
  });

  it("treats requests with an invalid Bearer token as unauthenticated (401)", async () => {
    const res = await exports.default.fetch(STREAM_URL, {
      headers: wsHeaders({
        Origin: "http://localhost:8080",
        Authorization: "Bearer sk_00000000000000000000000000000000",
      }),
    });
    expect(res.status).toBe(401);
  });
});

describe("notifications-router /config", () => {
  beforeAll(async () => {
    await applyMigrations();
  });
  beforeEach(async () => {
    await cleanDb();
  });

  it("returns pushEnabled=true and public key when VAPID is configured", async () => {
    const { apiKey } = await createTestUser({ role: "member" });
    const res = await authFetch("/api/notifications/config", { apiKey });
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      vapidPublicKey: string;
      pushEnabled: boolean;
    };
    // VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY are set in vitest.config.test.ts
    expect(json.vapidPublicKey).toBe("test-vapid-public");
    expect(json.pushEnabled).toBe(true);
  });
});
