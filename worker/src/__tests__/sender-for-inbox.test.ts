import {
  describe,
  it,
  expect,
  beforeAll,
  beforeEach,
  afterEach,
  vi,
} from "vitest";
import { senderIdentities } from "../db/sender-identities.schema";
import { gmailAccounts } from "../db/gmail-accounts.schema";
import { encryptSecret } from "../lib/crypto";
import { createSenderForInbox } from "../lib/email-sender/for-inbox";
import { getDb, applyMigrations, cleanDb } from "./helpers";

const KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
const GMAIL_ENV = {
  GOOGLE_OAUTH_CLIENT_ID: "cid",
  GOOGLE_OAUTH_CLIENT_SECRET: "csecret",
  TOKEN_ENCRYPTION_KEY: KEY,
} as unknown as CloudflareBindings;

async function seedGmailAccount(overrides: Record<string, unknown> = {}) {
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

async function seedIdentity(overrides: Record<string, unknown> = {}) {
  const now = Math.floor(Date.now() / 1000);
  await getDb()
    .insert(senderIdentities)
    .values({
      email: "support@acme.dev",
      displayName: "Support",
      source: "cloudflare",
      createdAt: now,
      updatedAt: now,
      ...overrides,
    });
}

beforeAll(async () => {
  await applyMigrations();
});

beforeEach(async () => {
  await cleanDb();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createSenderForInbox", () => {
  it("returns a GmailSender for a Gmail-mapped inbox with a usable cached token", async () => {
    await seedGmailAccount();
    await seedIdentity({ source: "gmail", gmailAccountId: "acct-1" });
    const fetchFn = vi.fn();
    vi.stubGlobal("fetch", fetchFn);

    const sender = await createSenderForInbox(
      getDb(),
      GMAIL_ENV,
      "support@acme.dev",
    );

    expect(sender.provider).toBe("gmail");
    // The cached, unexpired token should be used without hitting Google.
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("returns the configured provider for a Cloudflare inbox, unchanged", async () => {
    await seedIdentity({ source: "cloudflare" });

    const sender = await createSenderForInbox(
      getDb(),
      { RESEND_API_KEY: "re_test" } as unknown as CloudflareBindings,
      "support@acme.dev",
    );

    expect(sender.provider).toBe("resend");
  });

  it("falls back rather than throwing for an unknown from-address", async () => {
    const sender = await createSenderForInbox(
      getDb(),
      { RESEND_API_KEY: "re_test" } as unknown as CloudflareBindings,
      "nobody@acme.dev",
    );

    expect(sender.provider).toBe("resend");
  });

  it("falls back when the mapped gmail_accounts row is missing", async () => {
    // No gmail_accounts row for "acct-missing" — a dangling gmailAccountId,
    // reachable because there is no foreign-key check on that column.
    await seedIdentity({ source: "gmail", gmailAccountId: "acct-missing" });

    const sender = await createSenderForInbox(
      getDb(),
      {
        RESEND_API_KEY: "re_test",
        ...GMAIL_ENV,
      } as unknown as CloudflareBindings,
      "support@acme.dev",
    );

    expect(sender.provider).toBe("resend");
  });

  it("falls back rather than throwing when token refresh fails (revoked grant)", async () => {
    await seedGmailAccount({ accessToken: null, expiresAt: null });
    await seedIdentity({ source: "gmail", gmailAccountId: "acct-1" });
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

    const sender = await createSenderForInbox(
      getDb(),
      {
        RESEND_API_KEY: "re_test",
        ...GMAIL_ENV,
      } as unknown as CloudflareBindings,
      "support@acme.dev",
    );

    expect(sender.provider).toBe("resend");
  });
});
