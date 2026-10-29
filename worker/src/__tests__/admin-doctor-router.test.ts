// docs/doctor.md: GET /api/admin/doctor is admin-only and returns no secret.
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { applyMigrations, authFetch, cleanDb, createTestUser } from "./helpers";

const SECRET_NAMES = [
  "BETTER_AUTH_SECRET",
  "UNSUBSCRIBE_SECRET",
  "TOKEN_ENCRYPTION_KEY",
  "VAPID_PRIVATE_KEY",
  "RESEND_API_KEY",
  "GOOGLE_OAUTH_CLIENT_SECRET",
] as const;

describe("GET /api/admin/doctor", () => {
  beforeAll(async () => {
    await applyMigrations();
  });
  beforeEach(async () => {
    await cleanDb();
  });

  it("refuses a member and an anonymous caller", async () => {
    const { apiKey } = await createTestUser({
      id: "member-1",
      email: "member@example.com",
      role: "member",
    });
    expect((await authFetch("/api/admin/doctor", { apiKey })).status).toBe(403);
    expect((await authFetch("/api/admin/doctor")).status).toBe(401);
  });

  it("gives an admin the report, with no secret value in the body", async () => {
    const { apiKey } = await createTestUser();
    const res = await authFetch("/api/admin/doctor", { apiKey });
    expect(res.status).toBe(200);
    const text = await res.text();
    const body = JSON.parse(text);
    expect(body.build.commit).toBe("0123456789abcdef0123456789abcdef01234567");
    expect(body.build).not.toHaveProperty("migrations");
    expect(Array.isArray(body.checks)).toBe(true);
    expect(body.checks.length).toBeGreaterThan(10);
    for (const name of SECRET_NAMES) {
      const value = (env as unknown as Record<string, string>)[name];
      expect(value, name).toBeTruthy();
      expect(text).not.toContain(value);
    }
  });
});
