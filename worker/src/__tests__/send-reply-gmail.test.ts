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
import {
  applyMigrations,
  cleanDb,
  createTestUser,
  createTestPerson,
  createTestEmail,
  authFetch,
  getDb,
  buildSendForm,
} from "./helpers";
import { emails } from "../db/emails.schema";
import { sentEmails } from "../db/sent-emails.schema";
import { senderIdentities } from "../db/sender-identities.schema";
import { gmailAccounts } from "../db/gmail-accounts.schema";
import { outboxEmails } from "../db/outbox-emails.schema";
import { encryptSecret } from "../lib/crypto";

// Matches TOKEN_ENCRYPTION_KEY in vitest.config.test.ts.
const KEY = "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=";
const SEND_URL = "https://gmail.googleapis.com/gmail/v1/users/me/messages/send";

async function seedGmailAccount(overrides: Record<string, unknown> = {}) {
  const now = Math.floor(Date.now() / 1000);
  await getDb()
    .insert(gmailAccounts)
    .values({
      id: "acct-1",
      emailAddress: "collector@xyspace.dev",
      refreshTokenEncrypted: await encryptSecret("rt-1", KEY),
      // Cached and unexpired, so resolving a sender never hits the network
      // for a token refresh — only the send call itself does.
      accessToken: "cached-at",
      expiresAt: now + 3600,
      historyId: "1",
      connectedBy: "user-1",
      createdAt: now,
      updatedAt: now,
      ...overrides,
    });
}

async function seedGmailIdentity(overrides: Record<string, unknown> = {}) {
  const now = Math.floor(Date.now() / 1000);
  await getDb()
    .insert(senderIdentities)
    .values({
      email: "support@acme.dev",
      displayName: "Support",
      source: "gmail",
      gmailAccountId: "acct-1",
      createdAt: now,
      updatedAt: now,
      ...overrides,
    });
}

/** Stub the Gmail send endpoint to return a fixed id/threadId. */
function stubGmailSend(reply: { id: string; threadId: string }) {
  return vi.fn(async () => {
    return new Response(JSON.stringify(reply), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
}

describe("send router — Gmail reply routing", () => {
  let apiKey: string;

  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDb();
    ({ apiKey } = await createTestUser({ role: "admin" }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    (env as any).DEMO_MODE = "0";
  });

  it("replies from a Gmail-mapped inbox via Gmail and persists both gmail ids", async () => {
    await seedGmailAccount();
    await seedGmailIdentity();

    const person = await createTestPerson({
      id: "p-gmail",
      email: "customer@example.com",
    });
    await createTestEmail({
      id: "rcv-gmail",
      personId: person.id,
      recipient: "support@acme.dev",
      subject: "Question",
      messageId: "parent@example.com",
    });
    // Simulate the parent having arrived via Gmail sync (Slice 3), which is
    // what makes this reply thread instead of starting a new conversation.
    await getDb()
      .update(emails)
      .set({ gmailThreadId: "thread-parent-1" })
      .where(eq(emails.id, "rcv-gmail"));

    const fetchMock = stubGmailSend({
      id: "18abc",
      threadId: "thread-parent-1",
    });
    vi.stubGlobal("fetch", fetchMock);

    const res = await authFetch("/api/send/reply/rcv-gmail", {
      apiKey,
      method: "POST",
      body: buildSendForm({
        fromAddress: "support@acme.dev",
        bodyHtml: "<p>Thanks for reaching out.</p>",
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string };

    // Confirms Gmail was actually the transport: nothing else calls this URL.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe(SEND_URL);
    const sentBody = JSON.parse((init as RequestInit).body as string);
    expect(sentBody.threadId).toBe("thread-parent-1");

    const db = getDb();
    const rows = await db
      .select()
      .from(sentEmails)
      .where(eq(sentEmails.id, body.id));
    expect(rows).toHaveLength(1);
    expect(rows[0].gmailMessageId).toBe("18abc");
    expect(rows[0].gmailThreadId).toBe("thread-parent-1");
  });

  it("replies from a Cloudflare inbox unaffected — same provider, both gmail columns null", async () => {
    // DemoSender stands in for "the configured provider" so this doesn't hit
    // a real network call — same technique send-router.test.ts uses.
    (env as any).DEMO_MODE = "1";
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const person = await createTestPerson({
      id: "p-cf",
      email: "a@example.com",
    });
    await createTestEmail({
      id: "rcv-cf",
      personId: person.id,
      recipient: "me@saasmail.test",
      subject: "hi",
      messageId: "cf@example.com",
    });

    const res = await authFetch("/api/send/reply/rcv-cf", {
      apiKey,
      method: "POST",
      body: buildSendForm({
        fromAddress: "me@saasmail.test",
        bodyHtml: "<p>reply</p>",
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string };

    // Proves DemoSender (not GmailSender) actually handled the send: Gmail's
    // endpoint was never hit, and DemoSender's id has its own recognizable
    // shape.
    expect(fetchMock).not.toHaveBeenCalled();

    const db = getDb();
    const rows = await db
      .select()
      .from(sentEmails)
      .where(eq(sentEmails.id, body.id));
    expect(rows).toHaveLength(1);
    expect(rows[0].resendId).toMatch(/^demo_/);
    expect(rows[0].gmailMessageId).toBeNull();
    expect(rows[0].gmailThreadId).toBeNull();
  });

  it("POST /api/send/ (bulk) still uses the configured provider even when fromAddress is Gmail-mapped", async () => {
    await seedGmailAccount();
    await seedGmailIdentity();
    // DemoSender stands in for "the configured provider" here too.
    (env as any).DEMO_MODE = "1";
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const res = await authFetch("/api/send", {
      apiKey,
      method: "POST",
      body: buildSendForm({
        to: "bulk-recipient@example.com",
        fromAddress: "support@acme.dev",
        subject: "Campaign",
        bodyHtml: "<p>Hi</p>",
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; status: string };
    expect(body.status).toBe("sent");

    // Quota protection: bulk mail must never reach Gmail's API, even though
    // fromAddress is a Gmail-mapped inbox.
    expect(fetchMock).not.toHaveBeenCalled();

    const db = getDb();
    const rows = await db
      .select()
      .from(sentEmails)
      .where(eq(sentEmails.id, body.id));
    expect(rows).toHaveLength(1);
    expect(rows[0].resendId).toMatch(/^demo_/);
    expect(rows[0].gmailMessageId).toBeNull();
    expect(rows[0].gmailThreadId).toBeNull();
  });

  it("a Gmail send that fails transiently returns an error and queues nothing", async () => {
    await seedGmailAccount();
    await seedGmailIdentity();

    const person = await createTestPerson({
      id: "p-gmail-fail",
      email: "customer2@example.com",
    });
    await createTestEmail({
      id: "rcv-gmail-fail",
      personId: person.id,
      recipient: "support@acme.dev",
      subject: "Question",
      messageId: "parent-fail@example.com",
    });

    // Gmail's send endpoint rejects with a rate-limit (429) — the canonical
    // transient failure that, for every other provider, would be queued for
    // a cron retry.
    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({ error: { message: "Rate limit exceeded" } }),
        { status: 429, headers: { "content-type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const res = await authFetch("/api/send/reply/rcv-gmail-fail", {
      apiKey,
      method: "POST",
      body: buildSendForm({
        fromAddress: "support@acme.dev",
        bodyHtml: "<p>Thanks for reaching out.</p>",
      }),
    });

    // Surfaced as an error, not a 201 with a "retrying" status — there is
    // nothing in flight for the caller to wait on.
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/gmail/i);
    // Tells the caller plainly that nothing is in flight.
    expect(body.error).toMatch(/not queued for retry/i);
    // Never leaks token material into the surfaced error.
    expect(body.error).not.toMatch(/bearer|access.?token|refresh.?token/i);

    // The behavior change under test: no outbox row was ever created for
    // this attempt — asserting only the error status would still pass even
    // if this were silently queued behind a different provider.
    const outboxRows = await getDb().select().from(outboxEmails);
    expect(outboxRows).toHaveLength(0);

    // Nothing was persisted as a (misleading) sent/failed audit row either.
    const sentRows = await getDb().select().from(sentEmails);
    expect(sentRows).toHaveLength(0);
  });

  it("a reply that FELL BACK off Gmail (revoked grant) still queues on a transient failure, unchanged", async () => {
    // Gmail-mapped, but the cached token is gone and refresh will fail —
    // createSenderForInbox falls back to the configured provider.
    await seedGmailAccount({ accessToken: null, expiresAt: null });
    await seedGmailIdentity();

    const person = await createTestPerson({
      id: "p-fallback",
      email: "customer3@example.com",
    });
    await createTestEmail({
      id: "rcv-fallback",
      personId: person.id,
      recipient: "support@acme.dev",
      subject: "Question",
      messageId: "parent-fallback@example.com",
    });

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("oauth2.googleapis.com")) {
        // The revoked grant: token refresh itself fails, which is what
        // forces the fallback in the first place.
        return new Response(JSON.stringify({ error: "invalid_grant" }), {
          status: 400,
          headers: { "content-type": "application/json" },
        });
      }
      // The configured provider (Resend, via RESEND_API_KEY in the test
      // env) rejects transiently.
      return new Response(
        JSON.stringify({
          name: "rate_limit_exceeded",
          message: "Rate limit exceeded, please try again later",
        }),
        { status: 429, headers: { "content-type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const res = await authFetch("/api/send/reply/rcv-fallback", {
      apiKey,
      method: "POST",
      body: buildSendForm({
        fromAddress: "support@acme.dev",
        bodyHtml: "<p>Thanks for reaching out.</p>",
      }),
    });

    // Queued exactly like any other provider's transient failure: 201 with
    // a "retrying" status, not a hard error.
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; status: string };
    expect(body.status).toBe("retrying");

    const outboxRows = await getDb()
      .select()
      .from(outboxEmails)
      .where(eq(outboxEmails.sentEmailId, body.id));
    expect(outboxRows).toHaveLength(1);
    expect(outboxRows[0].status).toBe("pending");

    const sentRows = await getDb()
      .select()
      .from(sentEmails)
      .where(eq(sentEmails.id, body.id));
    expect(sentRows).toHaveLength(1);
    expect(sentRows[0].status).toBe("retrying");
    // Confirms this really did fall back off Gmail: no gmail ids recorded.
    expect(sentRows[0].gmailMessageId).toBeNull();
    expect(sentRows[0].gmailThreadId).toBeNull();
  });
});
