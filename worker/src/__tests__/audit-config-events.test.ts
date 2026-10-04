// docs/archive/SPEC-audit-log.md §3: events for configuration, people and
// credentials.
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { auditAuthRequest, recordFailedSignIn } from "../auth/audit-hooks";
import { auditEvents } from "../db/audit-events.schema";
import { invitations } from "../db/invitations.schema";
import { senderIdentities } from "../db/sender-identities.schema";
import {
  createMailbox,
  deleteMailbox,
  updateMailbox,
} from "../lib/messages/state";
import {
  applyMigrations,
  authFetch,
  cleanDb,
  createTestUser,
  getDb,
} from "./helpers";

const ADMIN = { isAdmin: true as const };
const INBOX = "support@saasmail.test";

async function events() {
  const rows = await getDb()
    .select()
    .from(auditEvents)
    .orderBy(sql`rowid`);
  return rows.map((row) => ({
    ...row,
    details: row.details ? JSON.parse(row.details) : null,
  }));
}

async function actions() {
  return (await events()).map((row) => row.action).sort();
}

function send(path: string, apiKey: string, method: string, body?: unknown) {
  return authFetch(path, {
    apiKey,
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

describe("audit events for configuration and people", () => {
  let userId: string;
  let apiKey: string;

  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDb();
    ({ userId, apiKey } = await createTestUser());
  });

  it("records a brand name change with the old and new value, once", async () => {
    await send("/api/admin/settings", apiKey, "PATCH", { brandName: "Acme" });
    // The same value again changes nothing and records nothing.
    await send("/api/admin/settings", apiKey, "PATCH", { brandName: "Acme" });

    const rows = await events();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: "settings.changed",
      targetType: "setting",
      targetId: "brand_name",
      actorUserId: userId,
      details: { key: "brand_name", from: null, to: "Acme" },
    });
  });

  it("records a webhook change without its secret", async () => {
    const res = await send("/api/webhook", apiKey, "PUT", {
      url: "https://hooks.example.com/in",
      secret: "whsec_do_not_log_me",
    });
    expect(res.status).toBe(200);

    const [row] = await events();
    expect(row.action).toBe("settings.changed");
    expect(row.details).toEqual({
      key: "webhook",
      url: "https://hooks.example.com/in",
      hasSecret: true,
    });
    expect(JSON.stringify(row)).not.toContain("whsec_do_not_log_me");

    // A URL can carry credentials too: only where it points is kept.
    await send("/api/webhook", apiKey, "PUT", {
      url: "https://user:hunter2@hooks.example.com/in?token=tok_abc#frag",
    });
    const [, second] = await events();
    expect(second.details.url).toBe("https://hooks.example.com/in");
    expect(JSON.stringify(second)).not.toContain("hunter2");
    expect(JSON.stringify(second)).not.toContain("tok_abc");
  });

  it("records an inbox's life: created, changed, access, deleted", async () => {
    const member = await createTestUser({
      id: "audit-member",
      email: "member@example.com",
      role: "member",
    });
    const base = "/api/admin/inboxes";
    const one = `${base}/${encodeURIComponent(INBOX)}`;

    expect(
      (
        await send(base, apiKey, "POST", {
          email: INBOX,
          displayName: "Support",
        })
      ).status,
    ).toBeLessThan(300);
    await send(one, apiKey, "PATCH", {
      forwardTo: "team@elsewhere.test",
      signatureHtml: "<p>Private signature text</p>",
    });
    // A patch that changes nothing is not an event.
    await send(one, apiKey, "PATCH", { forwardTo: "team@elsewhere.test" });
    await send(`${one}/assignments`, apiKey, "PUT", {
      userIds: [member.userId],
    });
    await send(`${one}/assignments`, apiKey, "PUT", { userIds: [] });
    await send(one, apiKey, "DELETE");

    const rows = await events();
    expect(rows.map((row) => row.action)).toEqual([
      "inbox.created",
      "inbox.updated",
      "user.inbox_access_changed",
      "user.inbox_access_changed",
      "inbox.deleted",
    ]);
    expect(rows.every((row) => row.inbox === INBOX)).toBe(true);
    expect(rows[1].details).toEqual({
      forwardTo: { from: null, to: "team@elsewhere.test" },
      signatureHtml: "changed",
    });
    expect(JSON.stringify(rows[1])).not.toContain("Private signature text");
    expect(rows[2].details).toEqual({ added: [member.userId], removed: [] });
    expect(rows[3].details).toEqual({ added: [], removed: [member.userId] });
  });

  it("records folders created, renamed and deleted, not reordered", async () => {
    const now = Math.floor(Date.now() / 1000);
    await getDb()
      .insert(senderIdentities)
      .values({ email: INBOX, createdAt: now, updatedAt: now });
    const folder = await createMailbox(getDb(), ADMIN, userId, {
      inbox: INBOX,
      name: "Invoices",
    });
    await updateMailbox(getDb(), ADMIN, userId, folder.id, { sortOrder: 3 });
    await updateMailbox(getDb(), ADMIN, userId, folder.id, { name: "Bills" });
    await deleteMailbox(getDb(), ADMIN, userId, folder.id);

    const rows = await events();
    expect(rows.map((row) => [row.action, row.summary])).toEqual([
      ["folder.created", `Created the folder 'Invoices' in ${INBOX}`],
      [
        "folder.renamed",
        `Renamed the folder 'Invoices' to 'Bills' in ${INBOX}`,
      ],
      ["folder.deleted", `Deleted the folder 'Bills' in ${INBOX}`],
    ]);
    expect(rows.every((row) => row.targetId === folder.id)).toBe(true);
  });

  it("records rules created, toggled, changed and deleted", async () => {
    const created = await send("/api/admin/rules", apiKey, "POST", {
      name: "Invoices",
      inbox: INBOX,
      conditions: [
        { field: "subject", operator: "contains", value: "invoice" },
      ],
      actions: [{ type: "archive" }],
      position: 0,
    });
    expect(created.status).toBe(201);
    const { id } = (await created.json()) as { id: string };
    const one = `/api/admin/rules/${id}`;

    await send(one, apiKey, "PATCH", { enabled: false });
    // Already off: nothing changed.
    await send(one, apiKey, "PATCH", { enabled: false });
    await send(one, apiKey, "PATCH", { name: "Invoices 2", enabled: true });
    await send(one, apiKey, "DELETE");

    const rows = await events();
    expect(rows.map((row) => [row.action, row.summary])).toEqual([
      ["rule.created", "Created the rule 'Invoices'"],
      ["rule.toggled", "Turned the rule 'Invoices' off"],
      ["rule.updated", "Changed name, enabled of the rule 'Invoices 2'"],
      ["rule.deleted", "Deleted the rule 'Invoices 2'"],
    ]);
    expect(rows[0].details).toEqual({ enabled: true, actions: ["archive"] });
  });

  it("records invitations, role changes and removals", async () => {
    const other = await createTestUser({
      id: "audit-other",
      email: "other@example.com",
      role: "member",
    });
    expect(
      (
        await send("/api/admin/invites", apiKey, "POST", {
          role: "member",
          email: "new@example.com",
          expiresInDays: 7,
        })
      ).status,
    ).toBe(201);
    await send(`/api/admin/users/${other.userId}/role`, apiKey, "PATCH", {
      role: "admin",
    });
    await send(`/api/admin/users/${other.userId}`, apiKey, "DELETE");

    const rows = await events();
    expect(rows.map((row) => [row.action, row.summary])).toEqual([
      ["user.invited", "Invited new@example.com as member"],
      ["user.role_changed", "Changed other@example.com from member to admin"],
      ["user.removed", "Removed other@example.com (admin)"],
    ]);
  });

  it("records someone joining by invitation as that person", async () => {
    await getDb()
      .insert(invitations)
      .values({
        id: "inv-1",
        token: "tok-1",
        role: "member",
        email: "joiner@example.com",
        expiresAt: new Date(Date.now() + 86_400_000),
        usedBy: null,
        usedAt: null,
        createdBy: userId,
        createdAt: new Date(),
      });
    const res = await authFetch("/api/invites/accept", {
      method: "POST",
      body: JSON.stringify({
        token: "tok-1",
        name: "Joiner",
        email: "joiner@example.com",
        password: "correct horse battery staple",
      }),
    });
    expect(res.status, await res.clone().text()).toBe(200);
    const { userId: joined } = (await res.json()) as { userId: string };

    const [row] = (await events()).filter((e) => e.action === "user.joined");
    expect(row).toMatchObject({
      actorType: "user",
      actorUserId: joined,
      actorLabel: "joiner@example.com",
      channel: "web",
      targetId: joined,
      summary: "joiner@example.com joined as member",
    });
  });

  it("records real sign-ins through better-auth: a wrong password, then the right one", async () => {
    await getDb()
      .insert(invitations)
      .values({
        id: "inv-2",
        token: "tok-2",
        role: "member",
        email: "signer@example.com",
        expiresAt: new Date(Date.now() + 86_400_000),
        usedBy: null,
        usedAt: null,
        createdBy: userId,
        createdAt: new Date(),
      });
    const password = "correct horse battery staple";
    const joined = await authFetch("/api/invites/accept", {
      method: "POST",
      body: JSON.stringify({
        token: "tok-2",
        name: "Signer",
        email: "signer@example.com",
        password,
      }),
    });
    expect(joined.status, await joined.clone().text()).toBe(200);
    const { userId: signerId } = (await joined.json()) as { userId: string };

    const signIn = (attempt: string) =>
      authFetch("/api/auth/sign-in/email", {
        method: "POST",
        headers: { "cf-connecting-ip": "198.51.100.4" },
        body: JSON.stringify({
          email: "signer@example.com",
          password: attempt,
        }),
      });
    const wrong = await signIn("not the password");
    expect(wrong.status).toBeGreaterThanOrEqual(400);
    // A second failure within the minute is not a second row.
    expect((await signIn("still not it")).status).toBeGreaterThanOrEqual(400);
    const right = await signIn(password);
    expect(right.status, await right.clone().text()).toBe(200);

    const rows = (await events()).filter((row) =>
      row.action.startsWith("auth."),
    );
    expect(rows.map((row) => row.action)).toEqual([
      "auth.sign_in_failed",
      "auth.sign_in",
    ]);
    expect(rows[0]).toMatchObject({
      actorUserId: null,
      channel: "web",
      ip: "198.51.100.4",
      targetId: signerId,
      details: { method: "password", email: "signer@example.com" },
    });
    expect(rows[1]).toMatchObject({
      actorType: "user",
      actorUserId: signerId,
      actorLabel: "signer@example.com",
      details: { method: "password" },
    });
    expect(JSON.stringify(rows)).not.toContain(password);
  });

  it("records an API key created and revoked by its prefix", async () => {
    const created = await send("/api/api-keys", apiKey, "POST");
    expect(created.status, await created.clone().text()).toBe(201);
    const { key, prefix } = (await created.json()) as {
      key: string;
      prefix: string;
    };
    // The old key was replaced: use the new one to revoke.
    await send("/api/api-keys", key, "DELETE");

    const rows = await events();
    expect(rows.map((row) => [row.action, row.targetId])).toEqual([
      ["api_key.created", prefix],
      ["api_key.revoked", prefix],
    ]);
    expect(JSON.stringify(rows)).not.toContain(key);
  });
});

describe("auditAuthRequest", () => {
  const jane = { id: "u-jane", email: "jane@acme.com" };

  beforeAll(async () => {
    await applyMigrations();
  });
  beforeEach(async () => {
    await cleanDb();
  });

  it("records a sign-in as the person, with the method", async () => {
    await auditAuthRequest(getDb(), {
      path: "/passkey/verify-authentication",
      context: { returned: { ok: true }, newSession: { user: jane } },
    });
    const [row] = await events();
    expect(row).toMatchObject({
      action: "auth.sign_in",
      actorType: "user",
      actorUserId: "u-jane",
      actorLabel: "jane@acme.com",
      summary: "Signed in with a passkey",
      details: { method: "passkey" },
    });
  });

  it("records a failed sign-in against an account, with nobody as actor", async () => {
    const account = await createTestUser({
      id: "u-jane",
      email: "jane@acme.com",
    });
    await auditAuthRequest(getDb(), {
      path: "/sign-in/email",
      body: { email: "Jane@Acme.com", password: "wrong" },
      context: { returned: new Error("Invalid email or password") },
    });
    const [row] = await events();
    expect(row).toMatchObject({
      action: "auth.sign_in_failed",
      actorUserId: null,
      targetId: account.userId,
      summary: "Failed password sign-in for jane@acme.com",
      details: { method: "password", email: "jane@acme.com" },
    });
    expect(JSON.stringify(row)).not.toContain("wrong");
  });

  it("does not let an unauthenticated caller write what they like", async () => {
    await createTestUser({ id: "u-jane", email: "jane@acme.com" });
    const fail = (email: unknown) =>
      auditAuthRequest(getDb(), {
        path: "/sign-in/email",
        body: { email, password: "x" },
        context: { returned: new Error("Invalid email or password") },
      });

    // No such account, a password typed into the address field, junk, and
    // an over-long value: none of these is stored.
    await fail("nobody@acme.com");
    await fail("P@ssw0rd.1");
    await fail("not an address");
    await fail(`${"a".repeat(300)}@acme.com`);
    await fail(42);
    expect(await events()).toEqual([]);

    // A real account: recorded once a minute, however often it is tried.
    await fail("jane@acme.com");
    await fail("jane@acme.com");
    await fail("JANE@acme.com");
    expect(await events()).toHaveLength(1);
  });

  it("records a failed passkey sign-in once a minute per caller address", async () => {
    const from = (ip: string) =>
      auditAuthRequest(getDb(), {
        path: "/passkey/verify-authentication",
        request: new Request("https://mail.test/api/auth/x", {
          headers: { "cf-connecting-ip": ip },
        }),
        context: { returned: new Error("bad assertion") },
      });
    await from("203.0.113.1");
    await from("203.0.113.1");
    await from("203.0.113.2");
    const rows = await events();
    expect(rows.map((row) => row.summary)).toEqual([
      "Failed passkey sign-in",
      "Failed passkey sign-in",
    ]);
  });

  it("records a refused password sign-in for an account that has a passkey", async () => {
    await recordFailedSignIn(getDb(), {
      method: "password",
      user: { id: "u-jane", email: "jane@acme.com" },
      reason: "passkey_required",
    });
    const [row] = await events();
    expect(row).toMatchObject({
      action: "auth.sign_in_failed",
      targetId: "u-jane",
      summary:
        "Refused password sign-in for jane@acme.com: the account has a passkey",
      details: { reason: "passkey_required" },
    });
  });

  it("records what an admin does through the auth API, as that admin", async () => {
    const admin = { id: "u-admin", email: "admin@acme.com" };
    const member = await createTestUser({
      id: "u-member",
      email: "member@acme.com",
      role: "member",
    });
    const call = (path: string, body: Record<string, unknown>, returned = {}) =>
      auditAuthRequest(getDb(), {
        path,
        body,
        context: {
          returned,
          session: { user: admin },
          // An impersonation creates a session for the member: never the actor.
          newSession: { user: { id: member.userId, email: "member@acme.com" } },
        },
      });

    await call("/admin/impersonate-user", { userId: member.userId });
    await call("/admin/set-role", { userId: member.userId, role: "admin" });
    await call("/admin/set-user-password", {
      userId: member.userId,
      newPassword: "hunter2-do-not-log",
    });
    await call("/admin/ban-user", { userId: member.userId, banReason: "x" });
    await call(
      "/admin/create-user",
      { email: "new@acme.com", password: "another-secret", role: "member" },
      { user: { id: "u-new", email: "new@acme.com" } },
    );
    await call("/admin/remove-user", { userId: member.userId });
    // Reads are not events.
    await call("/admin/list-users", {});

    const rows = await events();
    expect(rows.map((row) => [row.action, row.summary])).toEqual([
      ["user.impersonated", "Started acting as member@acme.com"],
      ["user.role_changed", "Changed member@acme.com to admin"],
      ["user.updated", "Changed the account member@acme.com: password set"],
      ["user.updated", "Changed the account member@acme.com: banned"],
      ["user.joined", "Created the account new@acme.com"],
      ["user.removed", "Removed member@acme.com"],
    ]);
    for (const row of rows) {
      expect(row).toMatchObject({
        actorType: "user",
        actorUserId: "u-admin",
        actorLabel: "admin@acme.com",
      });
    }
    const logged = JSON.stringify(rows);
    expect(logged).not.toContain("hunter2-do-not-log");
    expect(logged).not.toContain("another-secret");
  });

  it("ignores the server's own account creation, which has no caller", async () => {
    await auditAuthRequest(getDb(), {
      path: "/admin/create-user",
      body: { email: "joiner@acme.com", password: "secret" },
      context: { returned: { user: { id: "u-j", email: "joiner@acme.com" } } },
    });
    expect(await events()).toEqual([]);
  });

  it("records passkeys added and removed, and OAuth client and consent changes", async () => {
    const session = { user: jane };
    await auditAuthRequest(getDb(), {
      path: "/passkey/verify-registration",
      context: { returned: {}, session },
    });
    await auditAuthRequest(getDb(), {
      path: "/passkey/delete-passkey",
      body: { id: "pk-1" },
      context: { returned: {}, session },
    });
    await auditAuthRequest(getDb(), {
      path: "/oauth2/register",
      context: { returned: { client_id: "c-1", client_name: "Claude" } },
    });
    await auditAuthRequest(getDb(), {
      path: "/oauth2/consent",
      body: {
        accept: true,
        scope: "email:read",
        oauth_query: "response_type=code&client_id=c-1&scope=email%3Aread",
      },
      context: { returned: {}, session },
    });
    // Declining consent grants nothing.
    await auditAuthRequest(getDb(), {
      path: "/oauth2/consent",
      body: { accept: false },
      context: { returned: {}, session },
    });
    await auditAuthRequest(getDb(), {
      path: "/oauth2/delete-consent",
      body: { id: "consent-1" },
      context: { returned: {}, session },
    });

    expect(await actions()).toEqual([
      "oauth.client_registered",
      "oauth.consent_granted",
      "oauth.consent_revoked",
      "user.passkey_added",
      "user.passkey_removed",
    ]);
    // The consent names the client it was given to.
    const granted = (await events()).find(
      (row) => row.action === "oauth.consent_granted",
    );
    expect(granted).toMatchObject({
      targetId: "c-1",
      actorUserId: "u-jane",
      details: { scope: "email:read" },
    });
  });

  it("records nothing for other paths or for a failed change", async () => {
    await auditAuthRequest(getDb(), {
      path: "/get-session",
      context: { returned: {}, session: { user: jane } },
    });
    await auditAuthRequest(getDb(), {
      path: "/passkey/delete-passkey",
      context: { returned: new Error("not found"), session: { user: jane } },
    });
    expect(await events()).toEqual([]);
  });
});
