import {
  describe,
  it,
  expect,
  beforeAll,
  beforeEach,
  vi,
  afterEach,
} from "vitest";
import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { gmailAccounts } from "../db/gmail-accounts.schema";
import { decryptSecret } from "../lib/crypto";
import { signState } from "../lib/gmail/state";
import {
  getDb,
  applyMigrations,
  cleanDb,
  createTestUser,
  authFetch,
} from "./helpers";

const KEY = "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=";

beforeAll(async () => {
  await applyMigrations();
});

beforeEach(async () => {
  await cleanDb();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Stub the two Google endpoints the callback touches. */
function stubGoogle(
  tokenBody: Record<string, unknown>,
  profileBody: Record<string, unknown> = {
    emailAddress: "collector@xyspace.dev",
    historyId: "4242",
  },
  tokenStatus = 200,
) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const body = url.includes("/token") ? tokenBody : profileBody;
      const status = url.includes("/token") ? tokenStatus : 200;
      return new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });
    }),
  );
}

describe("GET /api/admin/gmail/connect", () => {
  it("returns a Google consent URL", async () => {
    const { apiKey } = await createTestUser({ role: "admin" });
    const res = await authFetch("/api/admin/gmail/connect", { apiKey });
    expect(res.status).toBe(200);

    const body = (await res.json()) as { authUrl: string };
    const url = new URL(body.authUrl);
    expect(url.host).toBe("accounts.google.com");
    expect(url.searchParams.get("client_id")).toBe("test-google-client-id");
    expect(url.searchParams.get("state")).toBeTruthy();
    expect(url.searchParams.get("redirect_uri")).toBe(
      "http://localhost:8080/api/admin/gmail/callback",
    );
  });

  it("returns 503 when the integration is unconfigured", async () => {
    const { apiKey } = await createTestUser({ role: "admin" });
    const saved = env.GOOGLE_OAUTH_CLIENT_ID;
    // @ts-expect-error -- miniflare env is mutable inside a test isolate
    delete env.GOOGLE_OAUTH_CLIENT_ID;
    try {
      const res = await authFetch("/api/admin/gmail/connect", { apiKey });
      expect(res.status).toBe(503);
    } finally {
      // @ts-expect-error -- restore for the rest of the suite
      env.GOOGLE_OAUTH_CLIENT_ID = saved;
    }
  });

  it("rejects an unauthenticated request", async () => {
    const res = await authFetch("/api/admin/gmail/connect");
    expect([401, 403]).toContain(res.status);
  });

  it("rejects a non-admin", async () => {
    const { apiKey } = await createTestUser({
      id: "member-1",
      role: "user",
      email: "member@example.com",
    });
    const res = await authFetch("/api/admin/gmail/connect", { apiKey });
    expect(res.status).toBe(403);
  });
});

describe("GET /api/admin/gmail/callback", () => {
  it("stores the account with an encrypted refresh token", async () => {
    const { userId, apiKey } = await createTestUser({ role: "admin" });
    stubGoogle({
      access_token: "at-1",
      refresh_token: "rt-secret",
      expires_in: 3599,
    });

    const state = await signState(userId, KEY);
    const res = await authFetch(
      `/api/admin/gmail/callback?code=abc&state=${encodeURIComponent(state)}`,
      { apiKey, redirect: "manual" },
    );

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("gmail=connected");

    const [row] = await getDb()
      .select()
      .from(gmailAccounts)
      .where(eq(gmailAccounts.emailAddress, "collector@xyspace.dev"));

    expect(row).toBeDefined();
    expect(row.historyId).toBe("4242");
    expect(row.connectedBy).toBe(userId);
    expect(row.refreshTokenEncrypted).not.toContain("rt-secret");
    expect(await decryptSecret(row.refreshTokenEncrypted, KEY)).toBe(
      "rt-secret",
    );
  });

  it("refuses a grant that returns no refresh token", async () => {
    const { userId, apiKey } = await createTestUser({ role: "admin" });
    stubGoogle({ access_token: "at-1", expires_in: 3599 });

    const state = await signState(userId, KEY);
    const res = await authFetch(
      `/api/admin/gmail/callback?code=abc&state=${encodeURIComponent(state)}`,
      { apiKey, redirect: "manual" },
    );

    expect(res.headers.get("location")).toContain("gmail=error");
    expect(await getDb().select().from(gmailAccounts)).toHaveLength(0);
  });

  it("rejects a forged state without writing a row", async () => {
    const { apiKey } = await createTestUser({ role: "admin" });
    stubGoogle({
      access_token: "at-1",
      refresh_token: "rt-secret",
      expires_in: 3599,
    });

    const res = await authFetch(
      "/api/admin/gmail/callback?code=abc&state=forged.123.deadbeef",
      { apiKey, redirect: "manual" },
    );

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("gmail=error");
    expect(await getDb().select().from(gmailAccounts)).toHaveLength(0);
  });

  it("reconnecting the same mailbox replaces credentials and clears the error", async () => {
    const { userId, apiKey } = await createTestUser({ role: "admin" });
    const now = Math.floor(Date.now() / 1000);
    await getDb().insert(gmailAccounts).values({
      id: "acct-old",
      emailAddress: "collector@xyspace.dev",
      refreshTokenEncrypted: "stale-sealed",
      historyId: "1",
      lastError: "invalid_grant",
      connectedBy: userId,
      createdAt: now,
      updatedAt: now,
    });

    stubGoogle({
      access_token: "at-2",
      refresh_token: "rt-new",
      expires_in: 3599,
    });

    const state = await signState(userId, KEY);
    await authFetch(
      `/api/admin/gmail/callback?code=abc&state=${encodeURIComponent(state)}`,
      { apiKey, redirect: "manual" },
    );

    const rows = await getDb().select().from(gmailAccounts);
    expect(rows).toHaveLength(1);
    expect(rows[0].lastError).toBeNull();
    expect(await decryptSecret(rows[0].refreshTokenEncrypted, KEY)).toBe(
      "rt-new",
    );
  });
});

describe("GET /api/admin/gmail", () => {
  it("lists accounts without leaking token material", async () => {
    const { apiKey } = await createTestUser({ role: "admin" });
    const now = Math.floor(Date.now() / 1000);
    await getDb().insert(gmailAccounts).values({
      id: "acct-1",
      emailAddress: "collector@xyspace.dev",
      refreshTokenEncrypted: "sealed-blob",
      accessToken: "at-cached",
      historyId: "1",
      connectedBy: "test-user-1",
      createdAt: now,
      updatedAt: now,
    });

    const res = await authFetch("/api/admin/gmail", { apiKey });
    expect(res.status).toBe(200);

    const body = await res.text();
    expect(body).toContain("collector@xyspace.dev");
    expect(body).not.toContain("sealed-blob");
    expect(body).not.toContain("at-cached");
    expect(body).not.toContain("refreshTokenEncrypted");
  });

  it("names the admin who connected each mailbox", async () => {
    // The column was written on every connect and reconnect but was in no
    // response, so nothing could ever read it: the row said who, and the API
    // did not.
    const { userId, apiKey } = await createTestUser({
      id: "admin-jane",
      role: "admin",
      name: "Jane Ops",
      email: "jane@example.com",
    });
    const now = Math.floor(Date.now() / 1000);
    await getDb().insert(gmailAccounts).values({
      id: "acct-1",
      emailAddress: "collector@xyspace.dev",
      refreshTokenEncrypted: "sealed-blob",
      historyId: "1",
      connectedBy: userId,
      createdAt: now,
      updatedAt: now,
    });

    const res = await authFetch("/api/admin/gmail", { apiKey });
    const body = (await res.json()) as {
      accounts: Array<{
        connectedBy: { id: string; name: string | null; email: string | null };
      }>;
    };
    expect(body.accounts[0].connectedBy).toEqual({
      id: "admin-jane",
      name: "Jane Ops",
      email: "jane@example.com",
    });
  });

  it("keeps listing a mailbox whose connecting admin was deleted", async () => {
    // `connected_by` carries no foreign key, so the id outlives the user. An
    // inner join here would drop the mailbox from the list entirely — the
    // account would vanish from the UI while still syncing.
    const { apiKey } = await createTestUser({ role: "admin" });
    const now = Math.floor(Date.now() / 1000);
    await getDb().insert(gmailAccounts).values({
      id: "acct-1",
      emailAddress: "collector@xyspace.dev",
      refreshTokenEncrypted: "sealed-blob",
      historyId: "1",
      connectedBy: "admin-long-gone",
      createdAt: now,
      updatedAt: now,
    });

    const res = await authFetch("/api/admin/gmail", { apiKey });
    const body = (await res.json()) as {
      accounts: Array<{
        id: string;
        connectedBy: { id: string; name: string | null } | null;
      }>;
    };
    expect(body.accounts).toHaveLength(1);
    expect(body.accounts[0].connectedBy).toEqual({
      id: "admin-long-gone",
      name: null,
      email: null,
    });
  });

  it("reports connectedBy as null on a row that predates the column", async () => {
    const { apiKey } = await createTestUser({ role: "admin" });
    const now = Math.floor(Date.now() / 1000);
    await getDb().insert(gmailAccounts).values({
      id: "acct-1",
      emailAddress: "collector@xyspace.dev",
      refreshTokenEncrypted: "sealed-blob",
      historyId: "1",
      connectedBy: null,
      createdAt: now,
      updatedAt: now,
    });

    const res = await authFetch("/api/admin/gmail", { apiKey });
    const body = (await res.json()) as {
      accounts: Array<{ connectedBy: unknown }>;
    };
    expect(body.accounts[0].connectedBy).toBeNull();
  });

  it("returns lastGapAt when a gap was recorded", async () => {
    const { apiKey } = await createTestUser({ role: "admin" });
    const now = Math.floor(Date.now() / 1000);
    await getDb()
      .insert(gmailAccounts)
      .values({
        id: "acct-1",
        emailAddress: "collector@xyspace.dev",
        refreshTokenEncrypted: "sealed-blob",
        historyId: "1",
        lastGapAt: now - 3600,
        connectedBy: "test-user-1",
        createdAt: now,
        updatedAt: now,
      });

    const res = await authFetch("/api/admin/gmail", { apiKey });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      accounts: Array<{ id: string; lastGapAt: number | null }>;
    };
    expect(body.accounts[0].lastGapAt).toBe(now - 3600);
  });

  it("returns lastGapAt as null when no gap has occurred", async () => {
    const { apiKey } = await createTestUser({ role: "admin" });
    const now = Math.floor(Date.now() / 1000);
    await getDb().insert(gmailAccounts).values({
      id: "acct-1",
      emailAddress: "collector@xyspace.dev",
      refreshTokenEncrypted: "sealed-blob",
      historyId: "1",
      connectedBy: "test-user-1",
      createdAt: now,
      updatedAt: now,
    });

    const res = await authFetch("/api/admin/gmail", { apiKey });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      accounts: Array<{ id: string; lastGapAt: number | null }>;
    };
    expect(body.accounts[0].lastGapAt).toBeNull();
  });
});

describe("DELETE /api/admin/gmail/{id}", () => {
  it("removes the account", async () => {
    const { apiKey } = await createTestUser({ role: "admin" });
    const now = Math.floor(Date.now() / 1000);
    await getDb().insert(gmailAccounts).values({
      id: "acct-1",
      emailAddress: "collector@xyspace.dev",
      refreshTokenEncrypted: "sealed",
      historyId: "1",
      connectedBy: "test-user-1",
      createdAt: now,
      updatedAt: now,
    });

    const res = await authFetch("/api/admin/gmail/acct-1", {
      method: "DELETE",
      apiKey,
    });
    expect(res.status).toBe(200);
    expect(await getDb().select().from(gmailAccounts)).toHaveLength(0);
  });

  it("answers 404 for an id that is not connected, and deletes nothing", async () => {
    // `success: true` for a mailbox that was never here tells an operator
    // theirs is gone while the one they meant is still connected and syncing.
    const { apiKey } = await createTestUser({ role: "admin" });
    const now = Math.floor(Date.now() / 1000);
    await getDb().insert(gmailAccounts).values({
      id: "acct-1",
      emailAddress: "collector@xyspace.dev",
      refreshTokenEncrypted: "sealed",
      historyId: "1",
      createdAt: now,
      updatedAt: now,
    });

    const res = await authFetch("/api/admin/gmail/acct-nope", {
      method: "DELETE",
      apiKey,
    });
    expect(res.status).toBe(404);
    expect(await getDb().select().from(gmailAccounts)).toHaveLength(1);
  });
});
