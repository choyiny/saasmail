/**
 * Admin operations over an OAuth bearer token.
 *
 * The deny list this replaces was drawn by category: anything that looked like
 * it rewrote the deployment. It is drawn by damage now — a route is closed to a
 * token only when it creates a privilege that survives revoking the client and
 * expiring the token, or opens a standing copy of future mail. Four routes are
 * reachable only in a clamped shape, and there the clamp *is* the boundary, so
 * each is exercised in both directions: the escalating body refused, the safe
 * one served.
 *
 * The classification assertions are not ceremony. `classifyRoute` is
 * first-match-wins over a hand-ordered table, so a rule that lands one line too
 * low fails open with nothing to see in a diff.
 */
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import {
  applyMigrations,
  authFetch,
  cleanDb,
  createTestUser,
  getDb,
} from "./helpers";
import { users } from "../db/auth.schema";
import { invitations } from "../db/invitations.schema";
import { inboxPermissions } from "../db/inbox-permissions.schema";
import {
  type Credentials,
  Jar,
  createUserWithPassword,
  getAccessToken,
  req,
  signIn,
} from "./mcp-helpers";
import {
  BODY_GUARDS,
  SCOPE_RULES,
  classifyRoute,
  guardBearerBody,
} from "../lib/oauth-scope-policy";
import { CreateInviteSchema, UpdateRoleSchema } from "../routers/admin-router";
import { PatchInboxBodySchema } from "../routers/admin-inboxes-router";
import { PutWebhookSchema } from "../routers/webhooks-router";

const ADMIN: Credentials = {
  name: "Owner",
  email: "owner@saasmail.test",
  password: "correct-horse-battery",
};

const OTHER_ADMIN: Credentials = {
  name: "Second",
  email: "second@saasmail.test",
  password: "correct-horse-battery",
};

const ADMIN_SCOPE = {
  kind: "scope",
  scope: "admin:manage",
  requiresAdminRole: true,
};

const INBOX = "support@saasmail.test";

function bearer(path: string, token: string, init: RequestInit = {}) {
  return req(path, {
    ...init,
    headers: { ...(init.headers ?? {}), Authorization: `Bearer ${token}` },
  });
}

function bearerJson(
  path: string,
  token: string,
  method: string,
  body: unknown,
) {
  return bearer(path, token, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** The guard reads the body through a thunk; tests hand it one directly. */
const guardBody = (method: string, path: string, body: unknown) =>
  guardBearerBody(method, path, async () => body);

function adminToken() {
  return getAccessToken(ADMIN, "openid admin:manage");
}

async function userId(email: string): Promise<string> {
  const row = await getDb()
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, email))
    .get();
  expect(row, `no user ${email}`).toBeTruthy();
  return row!.id;
}

describe("admin operations over an OAuth bearer token", () => {
  beforeAll(applyMigrations);

  beforeEach(async () => {
    await cleanDb();
    await createUserWithPassword(ADMIN, "admin");
  });

  describe("what a token may now reach at admin:manage", () => {
    const opened = [
      // Destroys a capability. Denied before only because the invites rule was
      // a prefix over the whole surface.
      ["DELETE", "/api/admin/invites/inv-1"],
      // Clamped in BODY_GUARDS rather than denied.
      ["POST", "/api/admin/invites"],
      ["PATCH", "/api/admin/users/u-1/role"],
      ["PATCH", `/api/admin/inboxes/${INBOX}`],
      ["PUT", "/api/webhook"],
      // Takes no URL: it posts a synthetic payload to whatever PUT already
      // configured, which is guarded.
      ["POST", "/api/webhook/test"],
      // Read-only inventory, and a revocation that destroys a capability.
      ["GET", "/api/oauth-apps"],
      ["DELETE", "/api/oauth-apps/client-1"],
      // The caller is already an admin who can read every inbox, and the
      // strictly more destructive DELETE /api/admin/users/{id} is open.
      ["PUT", `/api/admin/inboxes/${INBOX}/assignments`],
    ] as const;

    for (const [method, path] of opened) {
      it(`classifies ${method} ${path} as admin:manage`, () => {
        expect(classifyRoute(method, path)).toEqual(ADMIN_SCOPE);
      });
    }
  });

  describe("what stays denied", () => {
    const closed = [
      // An sk_ key authenticates as apiKey, which skips this policy and
      // requirePasskey both, never expires, and survives revoking the client.
      ["POST", "/api/api-keys"],
      ["GET", "/api/api-keys"],
      ["POST", "/api/user/passkeys"],
      ["GET", "/api/auth/anything"],
      // Returns live invite tokens, including admin-role ones a human created
      // in a browser with no email pinned.
      ["GET", "/api/admin/invites"],
    ] as const;

    for (const [method, path] of closed) {
      it(`denies ${method} ${path}`, () => {
        expect(classifyRoute(method, path).kind).toBe("denied");
      });
    }

    it("denies listing invites without denying the rest of the surface", () => {
      expect(classifyRoute("GET", "/api/admin/invites").kind).toBe("denied");
      expect(classifyRoute("POST", "/api/admin/invites")).toEqual(ADMIN_SCOPE);
      expect(classifyRoute("DELETE", "/api/admin/invites/inv-1")).toEqual(
        ADMIN_SCOPE,
      );
    });

    it("keeps the invite denial above the general admin rule", () => {
      // One line lower and the general rule answers first, silently opening it.
      const deny = SCOPE_RULES.findIndex(
        (r) =>
          r.cls.kind === "denied" && r.pattern.test("/api/admin/invites/inv-1"),
      );
      const generalAdmin = SCOPE_RULES.findIndex((r) =>
        r.pattern.test("/api/admin/anything-else"),
      );
      expect(deny).toBeGreaterThanOrEqual(0);
      expect(deny).toBeLessThan(generalAdmin);
    });
  });

  describe("/api/oauth-apps is classified exactly once", () => {
    // It carried two rules, a deny shadowing an admin. Which line survived the
    // edit decided the outcome, so pin the outcome rather than the line.
    it("has one rule and it is admin:manage", () => {
      const matching = SCOPE_RULES.filter((r) =>
        r.pattern.test("/api/oauth-apps"),
      );
      expect(matching).toHaveLength(1);
      expect(matching[0].cls).toEqual(ADMIN_SCOPE);
      expect(classifyRoute("GET", "/api/oauth-apps")).toEqual(ADMIN_SCOPE);
      expect(classifyRoute("DELETE", "/api/oauth-apps/client-1")).toEqual(
        ADMIN_SCOPE,
      );
    });
  });

  describe("the invite clamp", () => {
    const path = "/api/admin/invites";
    const safe = {
      role: "member",
      email: "newbie@saasmail.test",
      expiresInDays: 7,
    };

    it("accepts a member invite pinned to an address for a week", async () => {
      await expect(guardBody("POST", path, safe)).resolves.toBeNull();
    });

    it("accepts the schema defaults, which are the clamped values", async () => {
      await expect(
        guardBody("POST", path, { email: "newbie@saasmail.test" }),
      ).resolves.toBeNull();
    });

    it("refuses an admin invite", async () => {
      await expect(
        guardBody("POST", path, { ...safe, role: "admin" }),
      ).resolves.toContain("member invites");
    });

    it("refuses an invite nobody is named on", async () => {
      // Absence is the interesting case: with no Content-Type the route
      // validator sees `{}` and the schema defaults would mint an open invite.
      await expect(guardBody("POST", path, { role: "member" })).resolves.toBe(
        "OAuth clients must pin an invite to an email address",
      );
      await expect(
        guardBody("POST", path, { ...safe, email: "" }),
      ).resolves.toBeTruthy();
      await expect(
        guardBody("POST", path, { ...safe, email: null }),
      ).resolves.toBeTruthy();
    });

    it("refuses an invite that outlives a week", async () => {
      await expect(
        guardBody("POST", path, { ...safe, expiresInDays: 30 }),
      ).resolves.toContain("7 days");
      await expect(
        guardBody("POST", path, { ...safe, expiresInDays: 8 }),
      ).resolves.toBeTruthy();
    });
  });

  describe("the role clamp", () => {
    const path = "/api/admin/users/u-1/role";

    it("accepts a demotion", async () => {
      await expect(
        guardBody("PATCH", path, { role: "member" }),
      ).resolves.toBeNull();
    });

    it("refuses a promotion", async () => {
      await expect(guardBody("PATCH", path, { role: "admin" })).resolves.toBe(
        "OAuth clients may demote users but not promote them",
      );
    });
  });

  describe("the forwarding field guard", () => {
    const path = `/api/admin/inboxes/${INBOX}`;

    it("leaves the presentation fields alone", async () => {
      await expect(
        guardBody("PATCH", path, {
          displayName: "Support",
          displayMode: "thread",
          signatureHtml: "<p>hi</p>",
        }),
      ).resolves.toBeNull();
    });

    it("allows clearing a forwarding address", async () => {
      await expect(
        guardBody("PATCH", path, { forwardTo: "" }),
      ).resolves.toBeNull();
      await expect(
        guardBody("PATCH", path, { forwardTo: null }),
      ).resolves.toBeNull();
    });

    it("refuses arming one", async () => {
      await expect(
        guardBody("PATCH", path, { forwardTo: "relay@evil.test" }),
      ).resolves.toContain("clear an inbox's forwarding address");
      await expect(
        guardBody("PATCH", path, {
          displayName: "Support",
          forwardTo: "relay@evil.test",
        }),
      ).resolves.toBeTruthy();
    });
  });

  describe("the webhook field guard", () => {
    const path = "/api/webhook";

    it("allows clearing the URL and rotating the secret", async () => {
      await expect(
        guardBody("PUT", path, { url: "", secret: "rotated" }),
      ).resolves.toBeNull();
      await expect(
        guardBody("PUT", path, { url: "  ", secret: null }),
      ).resolves.toBeNull();
    });

    it("refuses setting one", async () => {
      await expect(
        guardBody("PUT", path, { url: "https://evil.test/hook" }),
      ).resolves.toBe(
        "OAuth clients may clear the webhook URL but not set one",
      );
    });
  });

  /**
   * The property that makes the guards a boundary rather than a list: a field
   * nobody has classified is refused, so next year's addition fails closed the
   * way an unclassified path does.
   */
  describe("the field guards are allowlists", () => {
    const guarded = [
      ["POST", "/api/admin/invites", CreateInviteSchema],
      ["PATCH", "/api/admin/users/u-1/role", UpdateRoleSchema],
      ["PATCH", `/api/admin/inboxes/${INBOX}`, PatchInboxBodySchema],
      ["PUT", "/api/webhook", PutWebhookSchema],
    ] as const;

    for (const [method, path, schema] of guarded) {
      it(`classifies every field of the ${method} ${path} schema`, () => {
        const guard = BODY_GUARDS.find(
          (g) => g.method === method && g.pattern.test(path),
        );
        expect(guard, `no guard for ${method} ${path}`).toBeDefined();
        expect(Object.keys(guard!.fields).sort()).toEqual(
          Object.keys(schema.shape).sort(),
        );
      });

      it(`refuses an unclassified field on ${method} ${path}`, async () => {
        await expect(
          guardBody(method, path, { addedNextYear: "whatever" }),
        ).resolves.toContain("addedNextYear");
      });
    }

    it("never reads the body of a route it does not guard", async () => {
      // Reading caches the raw text on the request, and a multipart send cannot
      // be re-parsed from text alone — POST /api/send is one.
      let reads = 0;
      const refusal = await guardBearerBody("POST", "/api/send", async () => {
        reads += 1;
        return {};
      });
      expect(refusal).toBeNull();
      expect(reads).toBe(0);
    });
  });

  describe("through the API with a real token", () => {
    it("creates a member invite pinned to an address", async () => {
      const res = await bearerJson(
        "/api/admin/invites",
        await adminToken(),
        "POST",
        {
          role: "member",
          email: "newbie@saasmail.test",
          expiresInDays: 7,
        },
      );
      expect(res.status).toBe(201);
      expect(await res.json()).toMatchObject({
        role: "member",
        email: "newbie@saasmail.test",
      });
    });

    it("refuses an admin invite", async () => {
      const res = await bearerJson(
        "/api/admin/invites",
        await adminToken(),
        "POST",
        {
          role: "admin",
          email: "newbie@saasmail.test",
          expiresInDays: 7,
        },
      );
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ code: "OAUTH_SCOPE_DENIED" });
      expect(await getDb().select().from(invitations)).toHaveLength(0);
    });

    it("refuses an unpinned invite", async () => {
      const res = await bearerJson(
        "/api/admin/invites",
        await adminToken(),
        "POST",
        {
          role: "member",
        },
      );
      expect(res.status).toBe(403);
      expect(await getDb().select().from(invitations)).toHaveLength(0);
    });

    it("refuses an invite sent with no body at all", async () => {
      // The shape that would slip past a clamp written as "reject a bad value":
      // with no Content-Type the route validator parses `{}` and the schema
      // defaults mint an unpinned member invite.
      const res = await bearer("/api/admin/invites", await adminToken(), {
        method: "POST",
      });
      expect(res.status).toBe(403);
      expect(await getDb().select().from(invitations)).toHaveLength(0);
    });

    it("revokes an invite", async () => {
      const token = await adminToken();
      const created = await bearerJson("/api/admin/invites", token, "POST", {
        role: "member",
        email: "newbie@saasmail.test",
      });
      const { id } = (await created.json()) as { id: string };

      const res = await bearer(`/api/admin/invites/${id}`, token, {
        method: "DELETE",
      });
      expect(res.status).toBe(200);
      expect(await getDb().select().from(invitations)).toHaveLength(0);
    });

    it("still refuses to list invites", async () => {
      const res = await bearer("/api/admin/invites", await adminToken());
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ code: "OAUTH_SCOPE_DENIED" });
    });

    it("demotes another admin but cannot promote", async () => {
      await createUserWithPassword(OTHER_ADMIN, "admin");
      const id = await userId(OTHER_ADMIN.email);
      const token = await adminToken();

      const promoted = await bearerJson(
        `/api/admin/users/${id}/role`,
        token,
        "PATCH",
        { role: "admin" },
      );
      expect(promoted.status).toBe(403);
      expect(await promoted.json()).toMatchObject({
        code: "OAUTH_SCOPE_DENIED",
      });

      const demoted = await bearerJson(
        `/api/admin/users/${id}/role`,
        token,
        "PATCH",
        { role: "member" },
      );
      expect(demoted.status).toBe(200);
      const row = await getDb()
        .select({ role: users.role })
        .from(users)
        .where(eq(users.id, id))
        .get();
      expect(row?.role).toBe("member");
    });

    it("renames an inbox but cannot point it anywhere", async () => {
      const token = await adminToken();

      const renamed = await bearerJson(
        `/api/admin/inboxes/${INBOX}`,
        token,
        "PATCH",
        { displayName: "Support" },
      );
      expect(renamed.status).toBe(200);
      expect(await renamed.json()).toMatchObject({
        displayName: "Support",
        forwardTo: null,
      });

      const armed = await bearerJson(
        `/api/admin/inboxes/${INBOX}`,
        token,
        "PATCH",
        { forwardTo: "relay@evil.test" },
      );
      expect(armed.status).toBe(403);
      expect(await armed.json()).toMatchObject({ code: "OAUTH_SCOPE_DENIED" });
    });

    it("clears a forwarding address someone else armed", async () => {
      const { apiKey } = await createTestUser({ role: "admin" });
      await authFetch(`/api/admin/inboxes/${INBOX}`, {
        apiKey,
        method: "PATCH",
        body: JSON.stringify({ forwardTo: "relay@example.test" }),
      });

      const res = await bearerJson(
        `/api/admin/inboxes/${INBOX}`,
        await adminToken(),
        "PATCH",
        { forwardTo: "" },
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ forwardTo: null });
    });

    it("clears the webhook but cannot repoint it", async () => {
      const token = await adminToken();

      const set = await bearerJson("/api/webhook", token, "PUT", {
        url: "https://evil.test/hook",
      });
      expect(set.status).toBe(403);
      expect(await set.json()).toMatchObject({ code: "OAUTH_SCOPE_DENIED" });

      const cleared = await bearerJson("/api/webhook", token, "PUT", {
        url: "",
      });
      expect(cleared.status).toBe(200);
      expect(await cleared.json()).toMatchObject({ url: "", hasSecret: false });
    });

    it("reaches the webhook test route", async () => {
      // 400 rather than 403: the route is reachable and answers that nothing is
      // configured to deliver to.
      const res = await bearer("/api/webhook/test", await adminToken(), {
        method: "POST",
      });
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({
        error: "No webhook URL configured.",
      });
    });

    it("lists and revokes OAuth clients", async () => {
      const token = await adminToken();

      const list = await bearer("/api/oauth-apps", token);
      expect(list.status).toBe(200);
      expect((await list.json()) as unknown[]).not.toHaveLength(0);

      // 404 rather than 403: revocation is reachable, this client is not there.
      const revoked = await bearer("/api/oauth-apps/no-such-client", token, {
        method: "DELETE",
      });
      expect(revoked.status).toBe(404);
    });

    it("clears inbox assignments", async () => {
      // The path is reachable, but only downward — granting is refused by the
      // shrink-only check in the handler, exercised in its own describe below.
      const res = await bearerJson(
        `/api/admin/inboxes/${INBOX}/assignments`,
        await adminToken(),
        "PUT",
        { userIds: [] },
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ assignedUserIds: [] });
    });
  });

  /**
   * The guards read `authMethod`, so everything above must be invisible to the
   * two credentials that carry the user's whole surface.
   */
  describe("session and API-key callers are unaffected", () => {
    it("lets an API-key admin arm forwarding, the webhook and an admin invite", async () => {
      const { apiKey } = await createTestUser({ role: "admin" });

      const forwarded = await authFetch(`/api/admin/inboxes/${INBOX}`, {
        apiKey,
        method: "PATCH",
        body: JSON.stringify({ forwardTo: "relay@example.test" }),
      });
      expect(forwarded.status).toBe(200);
      expect(await forwarded.json()).toMatchObject({
        forwardTo: "relay@example.test",
      });

      const hooked = await authFetch("/api/webhook", {
        apiKey,
        method: "PUT",
        body: JSON.stringify({ url: "https://hooks.example.test/x" }),
      });
      expect(hooked.status).toBe(200);

      const invited = await authFetch("/api/admin/invites", {
        apiKey,
        method: "POST",
        body: JSON.stringify({ role: "admin", expiresInDays: 30 }),
      });
      expect(invited.status).toBe(201);
      expect(await invited.json()).toMatchObject({
        role: "admin",
        email: null,
      });

      const listed = await authFetch("/api/admin/invites", { apiKey });
      expect(listed.status).toBe(200);
    });

    it("lets a session admin do the same", async () => {
      const jar = new Jar();
      await signIn(jar, ADMIN);
      const cookie = { cookie: jar.header, "Content-Type": "application/json" };

      const hooked = await req("/api/webhook", {
        method: "PUT",
        headers: cookie,
        body: JSON.stringify({ url: "https://hooks.example.test/x" }),
      });
      expect(hooked.status).toBe(200);

      const invited = await req("/api/admin/invites", {
        method: "POST",
        headers: cookie,
        body: JSON.stringify({ role: "admin" }),
      });
      expect(invited.status).toBe(201);
      expect(await invited.json()).toMatchObject({ role: "admin" });

      const forwarded = await req(`/api/admin/inboxes/${INBOX}`, {
        method: "PATCH",
        headers: cookie,
        body: JSON.stringify({ forwardTo: "relay@example.test" }),
      });
      expect(forwarded.status).toBe(200);
    });
  });
});

/**
 * The composition the reclassification had to close.
 *
 * Every call in the chain is individually permitted, and together they
 * assemble a durable privilege out of them: mint a member invite pinned to an
 * address the caller controls (the clamp allows exactly that, and the 201 body
 * carries the token), redeem it through the public accept route, then hand the
 * new member every inbox. That access outlives revoking the client and
 * expiring the token, so the last step is the one that has to give.
 */
describe("inbox assignments are shrink-only for a bearer caller", () => {
  beforeAll(applyMigrations);

  beforeEach(async () => {
    await cleanDb();
    await createUserWithPassword(ADMIN, "admin");
    await createTestUser({ id: "u-member", role: "member", email: "m@x.com" });
  });

  const path = `/api/admin/inboxes/${INBOX}/assignments`;

  async function grant(userIdToGrant: string) {
    await getDb()
      .insert(inboxPermissions)
      .values({
        userId: userIdToGrant,
        email: INBOX,
        createdAt: Math.floor(Date.now() / 1000),
        createdBy: null,
      });
  }

  async function held(): Promise<string[]> {
    const rows = await getDb()
      .select({ userId: inboxPermissions.userId })
      .from(inboxPermissions)
      .where(eq(inboxPermissions.email, INBOX));
    return rows.map((r) => r.userId);
  }

  it("refuses to add an assignment, and writes nothing", async () => {
    const res = await bearerJson(path, await adminToken(), "PUT", {
      userIds: ["u-member"],
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: "OAUTH_SCOPE_DENIED" });
    expect(await held()).toEqual([]);
  });

  it("allows removing every assignment", async () => {
    await grant("u-member");
    const res = await bearerJson(path, await adminToken(), "PUT", {
      userIds: [],
    });
    expect(res.status).toBe(200);
    expect(await held()).toEqual([]);
  });

  it("allows a replace that keeps the existing set", async () => {
    await grant("u-member");
    const res = await bearerJson(path, await adminToken(), "PUT", {
      userIds: ["u-member"],
    });
    expect(res.status).toBe(200);
    expect(await held()).toEqual(["u-member"]);
  });

  it("refuses a body that removes one and adds another", async () => {
    await createTestUser({ id: "u-other", role: "member", email: "o@x.com" });
    await grant("u-member");
    const res = await bearerJson(path, await adminToken(), "PUT", {
      userIds: ["u-other"],
    });
    expect(res.status).toBe(403);
    expect(await held()).toEqual(["u-member"]);
  });

  it("does not constrain an API-key caller", async () => {
    const { apiKey } = await createTestUser({
      id: "u-keyadmin",
      role: "admin",
      email: "k@x.com",
    });
    const res = await authFetch(path, {
      apiKey,
      method: "PUT",
      body: JSON.stringify({ userIds: ["u-member"] }),
    });
    expect(res.status).toBe(200);
    expect(await held()).toEqual(["u-member"]);
  });
});
