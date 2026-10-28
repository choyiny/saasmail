// docs/users-and-api-keys.md: what a password session can
// do before its account has a passkey, and what is left of it afterwards.
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { eq, sql } from "drizzle-orm";
import { oauthConsents, passkeys, sessions, users } from "../db/auth.schema";
import { revokeOnFirstPasskey } from "../auth/first-passkey";
import worker from "../index";
import { applyMigrations, cleanDb, getDb } from "./helpers";
import {
  type Credentials,
  Jar,
  createUserWithPassword,
  getAccessToken,
  signIn,
} from "./mcp-helpers";

const ADMIN: Credentials = {
  name: "Owner",
  email: "owner@saasmail.test",
  password: "correct-horse-battery",
};

async function userId(email: string): Promise<string> {
  const [row] = await getDb()
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, email));
  return row.id;
}

async function addPasskey(forUser: string, createdAt = new Date()) {
  await getDb()
    .insert(passkeys)
    .values({
      id: `pk-${forUser}-${createdAt.getTime()}`,
      name: "Laptop",
      publicKey: "pk",
      userId: forUser,
      credentialID: `cred-${createdAt.getTime()}`,
      counter: 0,
      deviceType: "singleDevice",
      backedUp: false,
      createdAt,
    });
}

// Production rules: the gate and the limiter are on. Their own env object:
// the auth instance is cached per env and reads the flag once.
const gatedEnv = {
  ...env,
  DISABLE_PASSKEY_GATE: "false",
} as unknown as CloudflareBindings;
const gatedFetch = (path: string, init?: RequestInit) =>
  worker.fetch(new Request(`http://localhost${path}`, init), gatedEnv, {
    waitUntil: () => {},
    passThroughOnException: () => {},
  } as unknown as ExecutionContext);

const gatedRpc = (accessToken: string, method: string) =>
  gatedFetch("/mcp", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: {} }),
  });

const authCall = (path: string, cookie: string, body?: unknown) =>
  gatedFetch(`/api/auth${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      Cookie: cookie,
      "Content-Type": "application/json",
      Origin: "http://localhost:8080",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

beforeAll(async () => {
  await applyMigrations();
});

describe("a session whose account has no passkey yet", () => {
  let cookie: string;

  beforeEach(async () => {
    await cleanDb();
    await createUserWithPassword(ADMIN, "admin");
    const jar = new Jar();
    await signIn(jar, ADMIN);
    cookie = jar.header;
  });

  it("cannot use better-auth's admin or account endpoints", async () => {
    for (const [path, body] of [
      ["/admin/list-users", undefined],
      ["/admin/impersonate-user", { userId: "someone" }],
      [
        "/change-password",
        { currentPassword: ADMIN.password, newPassword: "another-pass-123" },
      ],
      ["/change-email", { newEmail: "attacker@example.com" }],
      ["/oauth2/consent", { accept: true }],
    ] as const) {
      const res = await authCall(path, cookie, body);
      expect(res.status, path).toBe(403);
      expect(await res.json(), path).toMatchObject({
        code: "PASSKEY_REQUIRED",
      });
    }
  });

  it("can still read its session and start registering a passkey", async () => {
    expect((await authCall("/get-session", cookie)).status).toBe(200);
    const options = await authCall(
      "/passkey/generate-register-options",
      cookie,
    );
    expect(options.status).not.toBe(403);
  });

  it("is let through once the account has a passkey", async () => {
    await addPasskey(await userId(ADMIN.email));
    const res = await authCall("/admin/list-users", cookie);
    expect(res.status).toBe(200);
  });
});

describe("registering the first passkey", () => {
  beforeEach(async () => {
    await cleanDb();
    await createUserWithPassword(ADMIN, "admin");
  });

  it("ends the account's other sessions and OAuth grants, and keeps the one that registered", async () => {
    // An OAuth grant and two sessions, all opened with the password alone.
    await getAccessToken(ADMIN, "openid email:read");
    const other = new Jar();
    await signIn(other, ADMIN);
    const id = await userId(ADMIN.email);
    const before = await getDb()
      .select()
      .from(sessions)
      .where(eq(sessions.userId, id));
    expect(before.length).toBeGreaterThanOrEqual(2);
    expect(
      await getDb()
        .select()
        .from(oauthConsents)
        .where(eq(oauthConsents.userId, id)),
    ).toHaveLength(1);

    const current = before[0].token;
    await addPasskey(id);
    const ctx = {
      path: "/passkey/verify-registration",
      context: {
        returned: { ok: true },
        session: { user: { id }, session: { token: current } },
      },
    };
    expect(await revokeOnFirstPasskey(getDb(), ctx)).toBe(true);

    const after = await getDb()
      .select({ token: sessions.token })
      .from(sessions)
      .where(eq(sessions.userId, id));
    expect(after.map((row) => row.token)).toEqual([current]);
    expect(
      await getDb()
        .select()
        .from(oauthConsents)
        .where(eq(oauthConsents.userId, id)),
    ).toEqual([]);

    // A second passkey changes nothing.
    const jar = new Jar();
    await signIn(jar, ADMIN);
    await addPasskey(id, new Date(Date.now() + 5));
    expect(await revokeOnFirstPasskey(getDb(), ctx)).toBe(false);
    const [{ n }] = await getDb().all<{ n: number }>(
      sql`SELECT COUNT(*) AS n FROM sessions WHERE user_id = ${id}`,
    );
    expect(Number(n)).toBe(2);
  });

  it("does nothing when the registration failed", async () => {
    const id = await userId(ADMIN.email);
    await addPasskey(id);
    const result = await revokeOnFirstPasskey(getDb(), {
      path: "/passkey/verify-registration",
      context: {
        returned: new Response(null, { status: 400 }),
        session: { user: { id }, session: { token: "t" } },
      },
    });
    expect(result).toBe(false);
  });
});

describe("an MCP token minted before the account's first passkey", () => {
  beforeEach(async () => {
    await cleanDb();
    await createUserWithPassword(ADMIN, "admin");
  });

  it("is refused; one minted after it works", async () => {
    const token = await getAccessToken(ADMIN, "openid email:read");
    const id = await userId(ADMIN.email);
    await addPasskey(id, new Date(Date.now() + 60_000));

    const refused = await gatedRpc(token, "tools/list");
    expect(refused.status).toBe(401);
    expect(await refused.json()).toEqual({
      error: "token predates passkey registration",
    });

    await getDb()
      .update(passkeys)
      .set({ createdAt: new Date(Date.now() - 60 * 60_000) })
      .where(eq(passkeys.userId, id));
    expect((await gatedRpc(token, "tools/list")).status).toBe(200);
  });
});

describe("refusing a password for an account with a passkey", () => {
  beforeEach(async () => {
    await cleanDb();
    await createUserWithPassword(ADMIN, "admin");
    await addPasskey(await userId(ADMIN.email));
  });

  it("is counted, so it cannot be used to probe for accounts without limit", async () => {
    const attempt = () =>
      gatedFetch("/api/auth/sign-in/email", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "cf-connecting-ip": "203.0.113.50",
        },
        body: JSON.stringify({ email: ADMIN.email, password: "anything" }),
      });
    for (let i = 0; i < 3; i++) {
      expect((await attempt()).status).toBe(403);
    }
    const limited = await attempt();
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("X-Retry-After"))).toBeGreaterThan(0);
  });
});
