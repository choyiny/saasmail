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
import {
  createSenderForInbox,
  GmailSenderUnavailableError,
} from "../lib/email-sender/for-inbox";
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
    // Gmail secrets ARE supplied, so the only reason this falls back is the
    // identity's source discrimination ("cloudflare" !== "gmail") — not the
    // secrets guard. Omitting the secrets here would make this test pass
    // even if that source check were deleted or inverted.
    await seedIdentity({ source: "cloudflare" });

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

  it("falls back rather than throwing for an unknown from-address", async () => {
    // Gmail secrets ARE supplied (see note above) so this exercises the
    // identity-lookup miss, not the secrets guard.
    const sender = await createSenderForInbox(
      getDb(),
      {
        RESEND_API_KEY: "re_test",
        ...GMAIL_ENV,
      } as unknown as CloudflareBindings,
      "nobody@acme.dev",
    );

    expect(sender.provider).toBe("resend");
  });

  it("normalises case and whitespace before looking up the inbox", async () => {
    // sender_identities.email is stored lowercased. A from-address that
    // merely differs in case or has stray whitespace must still resolve.
    await seedGmailAccount();
    await seedIdentity({ source: "gmail", gmailAccountId: "acct-1" });
    vi.stubGlobal("fetch", vi.fn());

    const sender = await createSenderForInbox(
      getDb(),
      GMAIL_ENV,
      "  Support@Acme.DEV  ",
    );

    expect(sender.provider).toBe("gmail");
  });

  it("refuses rather than falling back when the mapped gmail_accounts row is missing", async () => {
    // No gmail_accounts row for "acct-missing" — a dangling gmailAccountId,
    // reachable because there is no foreign-key check on that column. The
    // inbox still SAYS it sends through Google, so handing the reply to
    // Resend would put a Workspace address behind a provider that domain's
    // SPF/DKIM does not authorise.
    await seedIdentity({ source: "gmail", gmailAccountId: "acct-missing" });

    await expect(
      createSenderForInbox(
        getDb(),
        {
          RESEND_API_KEY: "re_test",
          ...GMAIL_ENV,
        } as unknown as CloudflareBindings,
        "support@acme.dev",
      ),
    ).rejects.toBeInstanceOf(GmailSenderUnavailableError);
  });

  it("refuses rather than falling back when a token cannot be resolved", async () => {
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

    const err = await createSenderForInbox(
      getDb(),
      {
        RESEND_API_KEY: "re_test",
        ...GMAIL_ENV,
      } as unknown as CloudflareBindings,
      "support@acme.dev",
    ).then(
      (s) => s,
      (e) => e,
    );

    expect(err).toBeInstanceOf(GmailSenderUnavailableError);
    // A classification, never the underlying error's text: this frame ends
    // in a D1 UPDATE that binds the access token and the sealed refresh
    // token, and a D1 error carries its bound parameters.
    expect((err as GmailSenderUnavailableError).code).toBe("invalid_grant");
    expect((err as Error).message).not.toMatch(/rt-1|cached-at|bearer/i);
  });

  it("still falls back quietly for an inbox that is not Gmail-mapped at all", async () => {
    // The distinction the refusals above depend on. A cloudflare-source
    // inbox has no Google mailbox to fail to reach, and the configured
    // provider IS its transport — refusing here would break replying on
    // every ordinary inbox.
    await seedGmailAccount();
    await seedIdentity({ source: "cloudflare", gmailAccountId: null });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("Google must not be contacted for this inbox");
      }),
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
