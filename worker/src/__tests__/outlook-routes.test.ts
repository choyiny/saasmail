import {
  describe,
  it,
  expect,
  beforeAll,
  beforeEach,
  afterEach,
  vi,
} from "vitest";
import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { outlookAccounts } from "../db/outlook-accounts.schema";
import { senderIdentities } from "../db/sender-identities.schema";
import { sentEmails } from "../db/sent-emails.schema";
import { outboxEmails } from "../db/outbox-emails.schema";
import { decryptSecret, encryptSecret } from "../lib/crypto";
import { signState } from "../lib/gmail/state";
import { saveProviderConfig } from "../lib/oauth-providers";
import {
  applyMigrations,
  authFetch,
  buildSendForm,
  cleanDb,
  createTestEmail,
  createTestPerson,
  createTestUser,
  getDb,
} from "./helpers";

const KEY = "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=";
const MAILBOX = "jane@contoso.com";
const SEND_URL = "https://graph.microsoft.com/v1.0/me/sendMail";

beforeAll(async () => {
  await applyMigrations();
});

beforeEach(async () => {
  await cleanDb();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function setUpMicrosoft(tenant: string | null = null) {
  await saveProviderConfig(
    getDb(),
    env,
    "microsoft",
    { clientId: "ms-client", clientSecret: "ms-secret", tenant },
    null,
  );
}

async function seedAccount(
  over: Partial<typeof outlookAccounts.$inferInsert> = {},
) {
  const now = Math.floor(Date.now() / 1000);
  await getDb()
    .insert(outlookAccounts)
    .values({
      id: "ol-1",
      emailAddress: MAILBOX,
      refreshTokenEncrypted: await encryptSecret("rt-1", KEY),
      accessToken: "cached-at",
      expiresAt: now + 3600,
      syncFrom: now - 1000,
      createdAt: now,
      updatedAt: now,
      ...over,
    });
}

/** Microsoft's token endpoint and Graph's /me, as the callback sees them. */
function stubMicrosoft(opts: {
  profile?: {
    mail?: string | null;
    userPrincipalName?: string;
    proxyAddresses?: string[];
  };
  refreshToken?: string | null;
  sendStatus?: number;
  calls?: Array<{ url: string; init?: RequestInit }>;
}) {
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    opts.calls?.push({ url, init });
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });
    if (new URL(url).hostname === "login.microsoftonline.com") {
      return json({
        access_token: "at-1",
        expires_in: 3600,
        ...(opts.refreshToken === null
          ? {}
          : { refresh_token: opts.refreshToken ?? "rt-new" }),
      });
    }
    if (url.startsWith("https://graph.microsoft.com/v1.0/me?")) {
      return json(
        opts.profile ?? {
          mail: "Jane@Contoso.com",
          userPrincipalName: "jane@contoso.com",
          proxyAddresses: ["SMTP:jane@contoso.com", "smtp:sales@contoso.com"],
        },
      );
    }
    if (url === SEND_URL) {
      return new Response(null, { status: opts.sendStatus ?? 202 });
    }
    throw new Error(`unexpected fetch in test: ${url}`);
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

describe("connecting an Outlook mailbox", () => {
  it("refuses to start until Microsoft is set up, and says where", async () => {
    const { apiKey } = await createTestUser({ role: "admin" });
    const res = await authFetch("/api/admin/outlook/connect", { apiKey });
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: string }).error).toMatch(
      /Microsoft settings/,
    );
  });

  it("hands back a sign-in URL for any account, or the configured tenant", async () => {
    const { apiKey } = await createTestUser({ role: "admin" });
    await setUpMicrosoft();
    let res = await authFetch("/api/admin/outlook/connect", { apiKey });
    let url = new URL(((await res.json()) as { authUrl: string }).authUrl);
    expect(url.origin + url.pathname).toBe(
      "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
    );
    expect(url.searchParams.get("client_id")).toBe("ms-client");
    expect(url.searchParams.get("redirect_uri")).toMatch(
      /\/api\/admin\/outlook\/callback$/,
    );
    const scopes = url.searchParams.get("scope")!.split(" ");
    expect(scopes).toEqual(
      expect.arrayContaining([
        "offline_access",
        "https://graph.microsoft.com/Mail.ReadWrite",
        "https://graph.microsoft.com/Mail.Send",
      ]),
    );

    await setUpMicrosoft("contoso.onmicrosoft.com");
    res = await authFetch("/api/admin/outlook/connect", { apiKey });
    url = new URL(((await res.json()) as { authUrl: string }).authUrl);
    expect(url.pathname).toBe("/contoso.onmicrosoft.com/oauth2/v2.0/authorize");
  });

  it("stores the mailbox on callback, with its token sealed and sync starting now", async () => {
    const { userId, apiKey } = await createTestUser({ role: "admin" });
    await setUpMicrosoft();
    stubMicrosoft({});
    const state = await signState(userId, KEY);
    const before = Math.floor(Date.now() / 1000);

    const res = await authFetch(
      `/api/admin/outlook/callback?code=abc&state=${encodeURIComponent(state)}`,
      { apiKey, redirect: "manual" },
    );

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/inboxes?outlook=connected");
    const [row] = await getDb().select().from(outlookAccounts);
    expect(row.emailAddress).toBe(MAILBOX);
    expect(row.syncFrom).toBeGreaterThanOrEqual(before);
    expect(row.refreshTokenEncrypted).not.toContain("rt-new");
    expect(await decryptSecret(row.refreshTokenEncrypted, KEY)).toBe("rt-new");
    expect(row.connectedBy).toBe(userId);
  });

  it("refuses a reconnect that signed in as a different mailbox", async () => {
    const { userId, apiKey } = await createTestUser({ role: "admin" });
    await setUpMicrosoft();
    stubMicrosoft({});
    const state = await signState(
      userId,
      KEY,
      Math.floor(Date.now() / 1000),
      "other@contoso.com",
    );

    const res = await authFetch(
      `/api/admin/outlook/callback?code=abc&state=${encodeURIComponent(state)}`,
      { apiKey, redirect: "manual" },
    );

    const location = new URL(res.headers.get("location")!, "http://x");
    expect(location.searchParams.get("outlook")).toBe("wrong_account");
    expect(location.searchParams.get("outlook_granted")).toBe(MAILBOX);
    expect(await getDb().select().from(outlookAccounts)).toHaveLength(0);
  });

  it("uses the sign-in name for a personal account with no mail address", async () => {
    const { userId, apiKey } = await createTestUser({ role: "admin" });
    await setUpMicrosoft();
    stubMicrosoft({
      profile: { mail: null, userPrincipalName: "Someone@Outlook.com" },
    });
    const state = await signState(userId, KEY);
    await authFetch(
      `/api/admin/outlook/callback?code=abc&state=${encodeURIComponent(state)}`,
      { apiKey, redirect: "manual" },
    );
    const [row] = await getDb().select().from(outlookAccounts);
    expect(row.emailAddress).toBe("someone@outlook.com");
  });

  it("lists mailboxes without any token, and disconnecting unmaps their inboxes", async () => {
    const { apiKey } = await createTestUser({ role: "admin" });
    await seedAccount();
    const now = Math.floor(Date.now() / 1000);
    await getDb().insert(senderIdentities).values({
      email: MAILBOX,
      source: "outlook",
      outlookAccountId: "ol-1",
      createdAt: now,
      updatedAt: now,
    });

    const list = await authFetch("/api/admin/outlook", { apiKey });
    const text = await list.text();
    expect(text).not.toContain("cached-at");
    expect(JSON.parse(text).accounts[0]).toMatchObject({
      id: "ol-1",
      emailAddress: MAILBOX,
      backfill: { status: "pending", progress: 0 },
    });

    const del = await authFetch("/api/admin/outlook/ol-1", {
      apiKey,
      method: "DELETE",
    });
    expect(del.status).toBe(200);
    expect(await getDb().select().from(outlookAccounts)).toHaveLength(0);
    const [identity] = await getDb().select().from(senderIdentities);
    expect(identity).toMatchObject({
      source: "cloudflare",
      outlookAccountId: null,
    });
  });
});

describe("mapping an inbox to an Outlook mailbox", () => {
  function patch(apiKey: string, email: string, body: unknown) {
    return authFetch(`/api/admin/inboxes/${encodeURIComponent(email)}`, {
      apiKey,
      method: "PATCH",
      body: JSON.stringify(body),
    });
  }

  beforeEach(async () => {
    await setUpMicrosoft();
    // Already imported, so mapping does not start a real job in the
    // background of these tests.
    await seedAccount({ backfillCompletedAt: 1 });
  });

  it("maps the mailbox's own address and its aliases", async () => {
    const { apiKey } = await createTestUser({ role: "admin" });
    stubMicrosoft({});

    for (const address of [MAILBOX, "sales@contoso.com"]) {
      const res = await patch(apiKey, address, { outlookAccountId: "ol-1" });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({
        source: "outlook",
        outlookAccountId: "ol-1",
        gmailAccountId: null,
      });
    }
  });

  it("refuses an address the mailbox does not receive, saving nothing", async () => {
    const { apiKey } = await createTestUser({ role: "admin" });
    stubMicrosoft({});
    const res = await patch(apiKey, "stranger@contoso.com", {
      source: "outlook",
      outlookAccountId: "ol-1",
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(
      /does not receive mail as stranger@contoso\.com/,
    );
    expect(await getDb().select().from(senderIdentities)).toHaveLength(0);
  });

  it("refuses a body that names both providers' mailboxes", async () => {
    const { apiKey } = await createTestUser({ role: "admin" });
    const res = await patch(apiKey, MAILBOX, {
      gmailAccountId: "g-1",
      outlookAccountId: "ol-1",
    });
    expect(res.status).toBe(400);
  });

  it("unmaps with source cloudflare", async () => {
    const { apiKey } = await createTestUser({ role: "admin" });
    stubMicrosoft({});
    await patch(apiKey, MAILBOX, { outlookAccountId: "ol-1" });
    const res = await patch(apiKey, MAILBOX, { source: "cloudflare" });
    expect(await res.json()).toMatchObject({
      source: "cloudflare",
      outlookAccountId: null,
    });
  });
});

describe("replying from an Outlook-mapped inbox", () => {
  async function setUpThread() {
    await setUpMicrosoft();
    await seedAccount();
    const now = Math.floor(Date.now() / 1000);
    await getDb().insert(senderIdentities).values({
      email: MAILBOX,
      displayName: "Jane",
      source: "outlook",
      outlookAccountId: "ol-1",
      createdAt: now,
      updatedAt: now,
    });
    const person = await createTestPerson({
      id: "p-1",
      email: "customer@example.com",
    });
    await createTestEmail({
      id: "rcv-1",
      personId: person.id,
      recipient: MAILBOX,
      subject: "Question",
      messageId: "parent@example.com",
    });
  }

  function reply(apiKey: string) {
    return authFetch("/api/send/reply/rcv-1", {
      apiKey,
      method: "POST",
      body: buildSendForm({
        fromAddress: MAILBOX,
        bodyHtml: "<p>Thanks for reaching out.</p>",
      }),
    });
  }

  it("sends through Graph as MIME carrying the Message-ID it records", async () => {
    const { apiKey } = await createTestUser({ role: "admin" });
    await setUpThread();
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    stubMicrosoft({ calls });

    const res = await reply(apiKey);

    expect(res.status).toBe(201);
    const send = calls.filter((c) => c.url === SEND_URL);
    expect(send).toHaveLength(1);
    const headers = new Headers(send[0].init!.headers);
    expect(headers.get("Content-Type")).toBe("text/plain");
    const mime = atob(String(send[0].init!.body));
    expect(mime).toMatch(/^From: .*jane@contoso\.com/m);
    expect(mime).toMatch(/^In-Reply-To: <?parent@example\.com>?/m);

    const [row] = await getDb().select().from(sentEmails);
    expect(row.status).toBe("sent");
    expect(mime).toContain(`Message-ID: ${row.messageId}`);
    // Sent directly, never queued for another provider to retry.
    expect(await getDb().select().from(outboxEmails)).toHaveLength(0);
  });

  it("replaces a Sent Items mirror the sync wrote while the send was in flight", async () => {
    const { apiKey } = await createTestUser({ role: "admin" });
    await setUpThread();
    const now = Math.floor(Date.now() / 1000);
    // Graph files the Sent copy as it answers 202. A cron tick landing
    // before the send path's insert mirrors it — simulated here by writing
    // that mirror from inside the sendMail call itself.
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input) !== SEND_URL) throw new Error(String(input));
        const mime = atob(String(init!.body));
        const messageId = mime.match(/^Message-ID: (.+)$/m)![1].trim();
        await getDb()
          .insert(sentEmails)
          .values([
            {
              id: "mirrored-by-cron",
              fromAddress: MAILBOX,
              toAddress: "customer@example.com",
              subject: "Re: Question",
              messageId,
              status: "sent",
              outlookMessageId: "s-race",
              sentAt: now,
              createdAt: now,
            },
            {
              // Another message from the same inbox: must survive.
              id: "unrelated-mirror",
              fromAddress: MAILBOX,
              toAddress: "someone@example.com",
              subject: "Other",
              messageId: "<other@contoso.com>",
              status: "sent",
              outlookMessageId: "s-other",
              sentAt: now,
              createdAt: now,
            },
          ]);
        return new Response(null, { status: 202 });
      }),
    );

    const res = await reply(apiKey);

    expect(res.status).toBe(201);
    const { id } = (await res.json()) as { id: string };
    const ids = (await getDb().select().from(sentEmails)).map((r) => r.id);
    expect(ids.sort()).toEqual([id, "unrelated-mirror"].sort());
  });

  it("refuses rather than reroutes when the mailbox's grant is dead", async () => {
    const { apiKey } = await createTestUser({ role: "admin" });
    await setUpThread();
    await getDb()
      .update(outlookAccounts)
      .set({ accessToken: null, expiresAt: null });
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              error: "invalid_grant",
              error_description: "revoked",
            }),
            { status: 400, headers: { "content-type": "application/json" } },
          ),
      ),
    );

    const res = await reply(apiKey);

    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: string }).error).toMatch(
      /Microsoft mailbox/,
    );
    expect(await getDb().select().from(sentEmails)).toHaveLength(0);
    expect(await getDb().select().from(outboxEmails)).toHaveLength(0);
    const [row] = await getDb()
      .select()
      .from(outlookAccounts)
      .where(eq(outlookAccounts.id, "ol-1"));
    expect(row.lastError).toBe("invalid_grant");
  });
});
