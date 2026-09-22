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
});
