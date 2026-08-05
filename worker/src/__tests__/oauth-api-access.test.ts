/**
 * OAuth bearer access to /api/*.
 *
 * Until now `/api/*` accepted only a session cookie or an `sk_` API key, so a
 * client holding an access token this deployment itself issued could reach
 * `/mcp` and nothing else. These cover the new third credential and, more
 * importantly, the scope boundary that comes with it — a token acts for a
 * client the user consented to for specific capabilities, not for the user's
 * whole account.
 */
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { applyMigrations, cleanDb, getDb } from "./helpers";
import { users, oauthClients } from "../db/auth.schema";
import {
  type Credentials,
  createUserWithPassword,
  getAccessToken,
  grantInbox,
  req,
} from "./mcp-helpers";
import { classifyRoute } from "../lib/oauth-scope-policy";

const ADMIN: Credentials = {
  name: "Owner",
  email: "owner@saasmail.test",
  password: "correct-horse-battery",
};

function bearer(path: string, token: string, init: RequestInit = {}) {
  return req(path, {
    ...init,
    headers: { ...(init.headers ?? {}), Authorization: `Bearer ${token}` },
  });
}

describe("OAuth bearer access to /api/*", () => {
  beforeAll(applyMigrations);

  beforeEach(async () => {
    await cleanDb();
    await createUserWithPassword(ADMIN, "admin");
  });

  describe("the token is accepted at all", () => {
    it("serves a read route to a token carrying email:read", async () => {
      const token = await getAccessToken(ADMIN, "openid email:read");
      const res = await bearer("/api/people", token);
      expect(res.status).toBe(200);
    });

    it("still rejects a request with no credential", async () => {
      const res = await req("/api/people");
      expect(res.status).toBe(401);
    });

    it("rejects a syntactically valid but unsigned token", async () => {
      const res = await bearer("/api/people", "not-a-real-jwt");
      expect(res.status).toBe(401);
    });
  });

  describe("scopes bound what the token can do", () => {
    it("refuses a read route to a token without email:read", async () => {
      const token = await getAccessToken(ADMIN, "openid email:send");
      const res = await bearer("/api/people", token);
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({
        code: "OAUTH_INSUFFICIENT_SCOPE",
        required: "email:read",
      });
    });

    it("refuses a mutation to a read-only token", async () => {
      const token = await getAccessToken(ADMIN, "openid email:read");
      const res = await bearer("/api/people/mark-read", token, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ personIds: ["nobody"] }),
      });
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ required: "email:manage" });
    });
  });

  /**
   * The reason the policy classifies on method+path rather than router prefix.
   * Each of these sends mail from under a router whose other routes do not, so
   * a prefix table would have filed them as email:manage.
   */
  describe("routes that send mail require email:send wherever they live", () => {
    const sendRoutes = [
      ["POST", "/api/email-templates/welcome/send"],
      ["POST", "/api/sequences/seq-1/enroll"],
      ["POST", "/api/outbox/ob-1/retry"],
      ["POST", "/api/send"],
      ["POST", "/api/send/reply/e-1"],
    ] as const;

    for (const [method, path] of sendRoutes) {
      it(`classifies ${method} ${path} as email:send`, () => {
        const cls = classifyRoute(method, path);
        expect(cls).toEqual({ kind: "scope", scope: "email:send" });
      });
    }

    it("refuses a template send to a token holding only email:manage", async () => {
      const token = await getAccessToken(ADMIN, "openid email:manage");
      const res = await bearer("/api/email-templates/welcome/send", token, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ to: "someone@example.com", variables: {} }),
      });
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ required: "email:send" });
    });
  });

  /**
   * The escalation this exists to prevent: a client consented to for reading
   * mail must not be able to mint an unscoped API key — which would hand it the
   * user's entire surface, and delete whatever key the user already had.
   */
  describe("the credential surface is closed to tokens entirely", () => {
    const deniedPaths = [
      "/api/api-keys",
      "/api/user/passkeys",
      "/api/auth/anything",
    ];

    for (const path of deniedPaths) {
      it(`denies ${path} at any scope`, () => {
        expect(classifyRoute("GET", path).kind).toBe("denied");
        expect(classifyRoute("POST", path).kind).toBe("denied");
      });
    }

    it("refuses to mint an API key for a fully-scoped token", async () => {
      const token = await getAccessToken(
        ADMIN,
        "openid email:read email:send email:manage",
      );
      const res = await bearer("/api/api-keys", token, { method: "POST" });
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ code: "OAUTH_SCOPE_DENIED" });
    });
  });

  describe("unclassified routes fail closed", () => {
    it("denies a route nobody has classified", () => {
      expect(classifyRoute("GET", "/api/some-future-route").kind).toBe(
        "denied",
      );
      expect(classifyRoute("DELETE", "/api/people/x/something-new").kind).toBe(
        "scope",
      );
    });
  });

  describe("admin needs both the scope and the role", () => {
    it("refuses an admin route to a token without admin:manage", async () => {
      const token = await getAccessToken(ADMIN, "openid email:read");
      const res = await bearer("/api/admin/users", token);
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ required: "admin:manage" });
    });

    it("refuses an admin route to a member even holding admin:manage", async () => {
      const token = await getAccessToken(ADMIN, "openid admin:manage");
      // Demote the account after the token was minted: the role is read live,
      // so the token must not keep working.
      await getDb()
        .update(users)
        .set({ role: "member" })
        .where(eq(users.email, ADMIN.email));

      const res = await bearer("/api/admin/users", token);
      expect(res.status).toBe(403);
    });
  });

  describe("revocation is honoured on a live token", () => {
    it("rejects a token whose client has been disabled", async () => {
      const token = await getAccessToken(ADMIN, "openid email:read");
      expect((await bearer("/api/people", token)).status).toBe(200);

      await getDb().update(oauthClients).set({ disabled: true });

      const res = await bearer("/api/people", token);
      expect(res.status).toBe(401);
    });

    it("rejects a token whose user has been banned", async () => {
      const token = await getAccessToken(ADMIN, "openid email:read");
      await getDb()
        .update(users)
        .set({ banned: true, banExpires: null })
        .where(eq(users.email, ADMIN.email));

      const res = await bearer("/api/people", token);
      expect(res.status).toBe(401);
      expect(await res.json()).toMatchObject({ error: "account suspended" });
    });
  });

  describe("the caller's identity", () => {
    it("reports id, email and role from /api/user/me", async () => {
      const token = await getAccessToken(ADMIN, "openid email:read");
      const res = await bearer("/api/user/me", token);
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({
        email: ADMIN.email,
        role: "admin",
      });
    });
  });

  describe("existing credentials are untouched", () => {
    it("leaves API-key callers unscoped", async () => {
      // An sk_ key must not be run through JWT verification, and must keep
      // reaching routes the scope policy would deny an OAuth caller.
      const { apiKey } = await import("./helpers").then((h) =>
        h.createTestUser({ id: "key-user", email: "key@test.local" }),
      );
      await grantInbox("key-user", "inbox@saasmail.test");

      const res = await req("/api/api-keys", {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      expect(res.status).toBe(200);
    });
  });

  /**
   * What a token must not do even holding admin:manage. The line is drawn at
   * durable privilege — one that survives revoking the client and expiring the
   * token — rather than around the admin surface as a category, so most of what
   * this block once listed is now reachable in a clamped shape. Those routes
   * and their clamps live in `admin-over-oauth.test.ts`.
   */
  describe("durable privilege is denied to tokens", () => {
    const escalating = [
      // An sk_ key authenticates as apiKey, which skips this policy entirely,
      // never expires, and is not revoked with the client.
      ["POST", "/api/api-keys"],
      // Returns the tokens of live invites, admin-role ones included.
      ["GET", "/api/admin/invites"],
    ] as const;

    for (const [method, path] of escalating) {
      it(`denies ${method} ${path}`, () => {
        expect(classifyRoute(method, path).kind).toBe("denied");
      });
    }

    it("still allows ordinary admin reads with admin:manage", async () => {
      const token = await getAccessToken(ADMIN, "openid admin:manage");
      const res = await bearer("/api/admin/users", token);
      expect(res.status).toBe(200);
    });
  });

  describe("the app can still register for push", () => {
    // Denying this would make native notifications impossible; the payload
    // being a wake-up rather than message content is what keeps it safe.
    it("classifies notification subscription as email:read", () => {
      expect(classifyRoute("POST", "/api/notifications/subscribe")).toEqual({
        kind: "scope",
        scope: "email:read",
      });
    });
  });
});
