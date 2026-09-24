import {
  describe,
  it,
  expect,
  beforeAll,
  beforeEach,
  vi,
  afterEach,
} from "vitest";
import { eq } from "drizzle-orm";
import { gmailAccounts } from "../db/gmail-accounts.schema";
import { decryptSecret, encryptSecret } from "../lib/crypto";
import { getAccessToken } from "../lib/gmail/token";
import { GoogleAuthError } from "../lib/gmail/oauth";
import { getDb, applyMigrations } from "./helpers";

const KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
const CFG = { clientId: "cid", clientSecret: "csecret", encryptionKey: KEY };

async function seed(overrides: Record<string, unknown> = {}) {
  const now = Math.floor(Date.now() / 1000);
  await getDb()
    .insert(gmailAccounts)
    .values({
      id: "acct-1",
      emailAddress: "collector@xyspace.dev",
      refreshTokenEncrypted: await encryptSecret("rt-1", KEY),
      accessToken: "cached-at",
      expiresAt: now + 3600,
      historyId: "1",
      connectedBy: "user-1",
      createdAt: now,
      updatedAt: now,
      ...overrides,
    });
}

beforeAll(async () => {
  await applyMigrations();
});

beforeEach(async () => {
  await getDb().delete(gmailAccounts);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("getAccessToken", () => {
  it("returns the cached token without calling Google", async () => {
    await seed();
    const fetchFn = vi.fn();
    vi.stubGlobal("fetch", fetchFn);
    expect(await getAccessToken(getDb(), "acct-1", CFG)).toBe("cached-at");
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("refreshes and persists when the token is expired", async () => {
    await seed({ accessToken: "stale", expiresAt: 1 });
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ access_token: "fresh-at", expires_in: 3599 }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
      ),
    );

    expect(await getAccessToken(getDb(), "acct-1", CFG)).toBe("fresh-at");

    const [row] = await getDb()
      .select()
      .from(gmailAccounts)
      .where(eq(gmailAccounts.id, "acct-1"));
    expect(row.accessToken).toBe("fresh-at");
    expect(row.expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  it("re-seals and stores a rotated refresh token when Google issues one", async () => {
    await seed({ accessToken: "stale", expiresAt: 1 });
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              access_token: "fresh-at",
              refresh_token: "rt-rotated",
              expires_in: 3599,
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
      ),
    );

    expect(await getAccessToken(getDb(), "acct-1", CFG)).toBe("fresh-at");

    const [row] = await getDb()
      .select()
      .from(gmailAccounts)
      .where(eq(gmailAccounts.id, "acct-1"));
    expect(await decryptSecret(row.refreshTokenEncrypted, KEY)).toBe(
      "rt-rotated",
    );
  });

  it("refreshes when the token expires inside the 60-second margin", async () => {
    const now = Math.floor(Date.now() / 1000);
    await seed({ accessToken: "almost-stale", expiresAt: now + 30 });
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ access_token: "fresh-at", expires_in: 3599 }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
      ),
    );
    expect(await getAccessToken(getDb(), "acct-1", CFG)).toBe("fresh-at");
  });

  it("records lastError and rethrows on a revoked grant", async () => {
    await seed({ accessToken: null, expiresAt: null });
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: "invalid_grant" }), {
            status: 400,
            headers: { "content-type": "application/json" },
          }),
      ),
    );

    await expect(getAccessToken(getDb(), "acct-1", CFG)).rejects.toBeInstanceOf(
      GoogleAuthError,
    );

    const [row] = await getDb()
      .select()
      .from(gmailAccounts)
      .where(eq(gmailAccounts.id, "acct-1"));
    expect(row.lastError).toMatch(/invalid_grant/);
  });

  it("throws for an unknown account", async () => {
    await expect(getAccessToken(getDb(), "nope", CFG)).rejects.toThrow();
  });
});
