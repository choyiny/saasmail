/**
 * Contract tests: the REAL frontend client against the REAL worker.
 *
 * Every other test in this repo sits on one side of the seam. The frontend
 * suite does `vi.mock("@/lib/api")`, so the path strings in `src/lib/api.ts`
 * are never evaluated; every worker test writes its own URL by hand, so it
 * asserts the route the author meant rather than the one the client sends.
 * Nothing compared the two — which is how `fetchGmailAccounts` shipped
 * requesting `/api/admin/gmail/` (trailing slash) against a route registered
 * as `/api/admin/gmail`, leaving the entire connected-mailboxes UI dead while
 * 114 frontend tests and the whole worker suite stayed green.
 *
 * So these tests import the client functions themselves and let them build
 * their own URLs, methods and bodies. `fetch` is stubbed to do exactly one
 * thing to the request — prefix an origin, because a Worker cannot fetch a
 * root-relative path — and then hand it to the real worker via
 * `exports.default.fetch`. The path is otherwise passed through byte for
 * byte: no normalisation, no trailing-slash repair.
 *
 * Assertions are on the EFFECT, never on the URL string. A request that falls
 * through to the SPA catch-all cannot return a seeded row or delete one, so a
 * path that does not resolve fails here.
 */
import {
  describe,
  it,
  expect,
  beforeAll,
  beforeEach,
  afterEach,
  vi,
} from "vitest";
import { exports } from "cloudflare:workers";
import {
  disconnectGmailAccount,
  fetchGmailAccounts,
  startGmailConnect,
} from "../../../src/lib/api";
import { gmailAccounts } from "../db/gmail-accounts.schema";
import { getDb, applyMigrations, cleanDb, createTestUser } from "./helpers";

/** Every request the client made during one test, in order. */
let requested: Array<{ method: string; path: string }> = [];

/**
 * Point the client's `fetch` at the real worker.
 *
 * The only change to what the client sent is the `http://localhost` origin.
 * Anything else here — trimming a slash, rebuilding the URL through `new
 * URL()` — would repair the very defect these tests exist to catch.
 */
function routeClientAtWorker(apiKey: string) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      requested.push({ method: init?.method ?? "GET", path });
      const headers = new Headers(init?.headers);
      // The browser sends a session cookie (`credentials: "include"`); tests
      // authenticate with an API key, which the same middleware accepts.
      headers.set("Authorization", `Bearer ${apiKey}`);
      return exports.default.fetch(`http://localhost${path}`, {
        ...init,
        headers,
      });
    }),
  );
}

async function seedAccount(id: string, emailAddress: string) {
  const now = Math.floor(Date.now() / 1000);
  await getDb()
    .insert(gmailAccounts)
    .values({
      id,
      emailAddress,
      refreshTokenEncrypted: "sealed-blob",
      accessToken: "at-cached",
      historyId: "1",
      lastSyncedAt: now - 60,
      connectedBy: "test-user-1",
      createdAt: now,
      updatedAt: now,
    });
  return now;
}

beforeAll(async () => {
  await applyMigrations();
});

beforeEach(async () => {
  await cleanDb();
  requested = [];
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("src/lib/api.ts Gmail client against the real worker", () => {
  it("fetchGmailAccounts() reaches the list route and returns the stored mailbox", async () => {
    const { apiKey } = await createTestUser({ role: "admin" });
    routeClientAtWorker(apiKey);
    const connectedAt = await seedAccount("acct-1", "collector@acme.dev");

    const accounts = await fetchGmailAccounts();

    // Only the list handler can produce this. The SPA catch-all answers
    // `index.html` (or a 404 with no body in this environment), so a path
    // that does not resolve cannot reach these assertions.
    expect(accounts).toHaveLength(1);
    expect(accounts[0].id).toBe("acct-1");
    expect(accounts[0].emailAddress).toBe("collector@acme.dev");
    expect(accounts[0].lastSyncedAt).toBe(connectedAt - 60);
    expect(accounts[0].lastError).toBeNull();
  });

  it("startGmailConnect() reaches the consent route and gets a Google URL", async () => {
    const { apiKey } = await createTestUser({ role: "admin" });
    routeClientAtWorker(apiKey);

    const { authUrl } = await startGmailConnect();

    const url = new URL(authUrl);
    expect(url.host).toBe("accounts.google.com");
    expect(url.searchParams.get("redirect_uri")).toBe(
      "http://localhost:8080/api/admin/gmail/callback",
    );
    expect(url.searchParams.get("state")).toBeTruthy();
    expect(url.searchParams.get("login_hint")).toBeNull();
  });

  it("startGmailConnect(email) passes the reconnect mailbox through as a query parameter", async () => {
    const { apiKey } = await createTestUser({ role: "admin" });
    routeClientAtWorker(apiKey);

    // The address needs encoding — the client owns that, and a route that
    // rejected the encoded form would 400 rather than answer.
    const { authUrl } = await startGmailConnect("ops+eu@acme.dev");

    expect(new URL(authUrl).searchParams.get("login_hint")).toBe(
      "ops+eu@acme.dev",
    );
  });

  it("disconnectGmailAccount() reaches the delete route and removes the row", async () => {
    const { apiKey } = await createTestUser({ role: "admin" });
    routeClientAtWorker(apiKey);
    await seedAccount("acct-1", "collector@acme.dev");
    await seedAccount("acct-2", "other@acme.dev");

    const result = await disconnectGmailAccount("acct-1");

    expect(result.success).toBe(true);
    const rows = await getDb().select().from(gmailAccounts);
    expect(rows.map((r) => r.id)).toEqual(["acct-2"]);
  });

  it("sends only paths the worker routes — nothing that lands on the SPA catch-all", async () => {
    const { apiKey } = await createTestUser({ role: "admin" });
    routeClientAtWorker(apiKey);
    await seedAccount("acct-1", "collector@acme.dev");
    await fetchGmailAccounts();
    await startGmailConnect("collector@acme.dev");
    await disconnectGmailAccount("acct-1");

    // Replay every captured method+path against the worker. The catch-all is
    // the only thing that answers a request no route matched, and it never
    // answers JSON — so this fails for a client path that stopped resolving
    // even if the effect assertions above were weakened or deleted.
    //
    // The content type is the whole signal, deliberately. The replayed DELETE
    // now meets an id its first run already removed, and the route answers
    // that 404 rather than `success: true` for a mailbox that was never here
    // — a 404 from a matched route and a 404 from the catch-all are different
    // things, and only the JSON body tells them apart.
    expect(requested).toHaveLength(3);
    for (const { method, path } of requested) {
      const res = await exports.default.fetch(`http://localhost${path}`, {
        method,
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      expect(
        {
          request: `${method} ${path}`,
          routed: (res.headers.get("content-type") ?? "").includes("json"),
        },
        `${method} ${path} fell through to the SPA catch-all`,
      ).toEqual({ request: `${method} ${path}`, routed: true });
    }
  });
});
