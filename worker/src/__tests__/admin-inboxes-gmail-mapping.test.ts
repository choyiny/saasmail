import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { env } from "cloudflare:workers";
import {
  applyMigrations,
  authFetch,
  cleanDb,
  createTestEmail,
  createTestPerson,
  createTestUser,
  getDb,
} from "./helpers";
import { senderIdentities } from "../db/sender-identities.schema";
import { emails } from "../db/emails.schema";
import { sentEmails } from "../db/sent-emails.schema";
import { gmailAccounts } from "../db/gmail-accounts.schema";
import { encryptSecret } from "../lib/crypto";
import { eq } from "drizzle-orm";

// Matches TOKEN_ENCRYPTION_KEY in vitest.config.test.ts.
const KEY = "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=";
const SEND_AS_URL =
  "https://gmail.googleapis.com/gmail/v1/users/me/settings/sendAs";

beforeAll(async () => {
  await applyMigrations();
});

beforeEach(async () => {
  await cleanDb();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function seedGmailAccount(overrides: Record<string, unknown> = {}) {
  const now = Math.floor(Date.now() / 1000);
  await getDb()
    .insert(gmailAccounts)
    .values({
      id: "acct-1",
      emailAddress: "collector@acme.dev",
      refreshTokenEncrypted: await encryptSecret("rt-1", KEY),
      // Cached and unexpired, so the sendAs lookup is the ONLY network call
      // the mapping makes: a stub that fires proves the guard ran.
      accessToken: "cached-at",
      expiresAt: now + 3600,
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
      email: "a@x.com",
      displayName: "Original",
      source: "cloudflare",
      gmailAccountId: null,
      createdAt: now,
      updatedAt: now,
      ...overrides,
    });
}

type SendAsReply =
  | { addresses: string[] }
  // Raw entries, for the fields beyond the address itself (verificationStatus,
  // isPrimary) that decide whether Gmail would actually send from an address.
  | { entries: Array<Record<string, unknown>> }
  | { status: number }
  | { networkError: true };

/**
 * Stub fetch for the sendAs lookup. Any other URL throws, so a test can never
 * pass on a request that never reached the guard it claims to exercise.
 */
function stubSendAs(reply: SendAsReply) {
  const fn = vi.fn(async (input: RequestInfo | URL) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    if (!url.startsWith(SEND_AS_URL)) {
      throw new Error(`unexpected fetch in test: ${url}`);
    }
    if ("networkError" in reply) throw new TypeError("network failure");
    if ("status" in reply) {
      return new Response(JSON.stringify({ error: { message: "boom" } }), {
        status: reply.status,
        headers: { "content-type": "application/json" },
      });
    }
    const sendAs =
      "entries" in reply
        ? reply.entries
        : reply.addresses.map((a) => ({ sendAsEmail: a }));
    return new Response(JSON.stringify({ sendAs }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

function patchInbox(apiKey: string, email: string, body: unknown) {
  return authFetch(`/api/admin/inboxes/${encodeURIComponent(email)}`, {
    apiKey,
    method: "PATCH",
    body: JSON.stringify(body),
  });
}

function rowsFor(email: string) {
  return getDb()
    .select()
    .from(senderIdentities)
    .where(eq(senderIdentities.email, email));
}

function calledSendAs(fn: ReturnType<typeof stubSendAs>) {
  return fn.mock.calls.some(([input]) => String(input).startsWith(SEND_AS_URL));
}

describe("admin inboxes router — Gmail mapping", () => {
  it("PATCH persists source and gmailAccountId into sender_identities", async () => {
    const { apiKey } = await createTestUser({ role: "admin" });
    await seedGmailAccount();
    const fetchMock = stubSendAs({ addresses: ["a@x.com"] });

    const res = await patchInbox(apiKey, "a@x.com", {
      source: "gmail",
      gmailAccountId: "acct-1",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      source: string;
      gmailAccountId: string | null;
    };
    expect(body.source).toBe("gmail");
    expect(body.gmailAccountId).toBe("acct-1");
    expect(calledSendAs(fetchMock)).toBe(true);

    const rows = await rowsFor("a@x.com");
    expect(rows[0].source).toBe("gmail");
    expect(rows[0].gmailAccountId).toBe("acct-1");
  });

  it("accepts a mapping whose sendAs entry differs only in case and spacing", async () => {
    const { apiKey } = await createTestUser({ role: "admin" });
    await seedGmailAccount();
    stubSendAs({ addresses: ["  Support@Acme.DEV  "] });

    const res = await patchInbox(apiKey, "support@acme.dev", {
      source: "gmail",
      gmailAccountId: "acct-1",
    });
    expect(res.status).toBe(200);

    const rows = await rowsFor("support@acme.dev");
    expect(rows[0].source).toBe("gmail");
    expect(rows[0].gmailAccountId).toBe("acct-1");
  });

  it("accepts an alias whose verification has completed", async () => {
    const { apiKey } = await createTestUser({ role: "admin" });
    await seedGmailAccount();
    stubSendAs({
      entries: [
        { sendAsEmail: "collector@acme.dev", isPrimary: true },
        { sendAsEmail: "a@x.com", verificationStatus: "accepted" },
      ],
    });

    const res = await patchInbox(apiKey, "a@x.com", {
      source: "gmail",
      gmailAccountId: "acct-1",
    });
    expect(res.status).toBe(200);
    expect((await rowsFor("a@x.com"))[0].gmailAccountId).toBe("acct-1");
  });

  it("accepts an address Gmail never asks to be verified", async () => {
    const { apiKey } = await createTestUser({ role: "admin" });
    await seedGmailAccount();
    // Gmail populates verificationStatus only for custom from-aliases: the
    // account's own address and Workspace-managed aliases report
    // "verificationStatusUnspecified" and are perfectly sendable. Rejecting
    // anything that is not literally "accepted" would refuse those.
    stubSendAs({
      entries: [
        {
          sendAsEmail: "a@x.com",
          isPrimary: true,
          verificationStatus: "verificationStatusUnspecified",
        },
      ],
    });

    const res = await patchInbox(apiKey, "a@x.com", {
      source: "gmail",
      gmailAccountId: "acct-1",
    });
    expect(res.status).toBe(200);
    expect((await rowsFor("a@x.com"))[0].gmailAccountId).toBe("acct-1");
  });

  it("rejects with 400 an alias whose verification is still pending, leaving the row untouched", async () => {
    const { apiKey } = await createTestUser({ role: "admin" });
    await seedGmailAccount();
    await seedIdentity();
    // Gmail refuses to put a pending alias in a From: header, so accepting the
    // mapping would hand the operator a green light that dies on the first
    // reply — and the rejection message tells them to verify it first.
    const fetchMock = stubSendAs({
      entries: [
        { sendAsEmail: "collector@acme.dev", isPrimary: true },
        { sendAsEmail: "a@x.com", verificationStatus: "pending" },
      ],
    });

    const res = await patchInbox(apiKey, "a@x.com", {
      source: "gmail",
      gmailAccountId: "acct-1",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/a@x\.com/);
    expect(calledSendAs(fetchMock)).toBe(true);

    const rows = await rowsFor("a@x.com");
    expect(rows).toHaveLength(1);
    expect(rows[0].source).toBe("cloudflare");
    expect(rows[0].gmailAccountId).toBeNull();
  });

  it("rejects with 400 when the address is not in the account's sendAs list, leaving the row untouched", async () => {
    const { apiKey } = await createTestUser({ role: "admin" });
    await seedGmailAccount();
    await seedIdentity();
    const fetchMock = stubSendAs({
      addresses: ["collector@acme.dev", "someone-else@acme.dev"],
    });

    const res = await patchInbox(apiKey, "a@x.com", {
      source: "gmail",
      gmailAccountId: "acct-1",
      displayName: "Renamed",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/a@x\.com/);
    expect(body.error).toMatch(/send/i);
    // The guard really ran — the rejection is not some earlier validation.
    expect(calledSendAs(fetchMock)).toBe(true);

    // Nothing from the request applied — not the mapping, not the rename.
    const rows = await rowsFor("a@x.com");
    expect(rows).toHaveLength(1);
    expect(rows[0].displayName).toBe("Original");
    expect(rows[0].source).toBe("cloudflare");
    expect(rows[0].gmailAccountId).toBeNull();
  });

  it("checks again when an already-mapped inbox is re-pointed at a different account", async () => {
    const { apiKey } = await createTestUser({ role: "admin" });
    await seedGmailAccount();
    await seedGmailAccount({
      id: "acct-2",
      emailAddress: "other@acme.dev",
    });
    await seedIdentity({ source: "gmail", gmailAccountId: "acct-1" });
    // Swapping the connected mailbox is a normal admin operation, and the new
    // account may not be able to send as this inbox even though the old one
    // could.
    const fetchMock = stubSendAs({ addresses: ["other@acme.dev"] });

    const res = await patchInbox(apiKey, "a@x.com", {
      gmailAccountId: "acct-2",
    });
    expect(res.status).toBe(400);
    expect(calledSendAs(fetchMock)).toBe(true);

    const rows = await rowsFor("a@x.com");
    expect(rows[0].source).toBe("gmail");
    expect(rows[0].gmailAccountId).toBe("acct-1");
  });

  it("normalises the inbox address before checking it against the sendAs list", async () => {
    const { apiKey } = await createTestUser({ role: "admin" });
    await seedGmailAccount();
    // Only the Gmail side of the comparison is normalised by listSendAs; a
    // mixed-case route param must be normalised too, or a valid mapping is
    // rejected — and, worse, a row is stored under a key the send path (which
    // lowercases) can never find.
    stubSendAs({ addresses: ["support@acme.dev"] });

    const res = await patchInbox(apiKey, "Support@Acme.Dev", {
      source: "gmail",
      gmailAccountId: "acct-1",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { email: string };
    expect(body.email).toBe("support@acme.dev");

    const rows = await rowsFor("support@acme.dev");
    expect(rows).toHaveLength(1);
    expect(rows[0].gmailAccountId).toBe("acct-1");
    // And nothing was written under the un-normalised key.
    expect(await rowsFor("Support@Acme.Dev")).toHaveLength(0);
  });

  it("does not create a row at all when an unmapped inbox fails the sendAs check", async () => {
    const { apiKey } = await createTestUser({ role: "admin" });
    await seedGmailAccount();
    stubSendAs({ addresses: ["collector@acme.dev"] });

    const res = await patchInbox(apiKey, "new@x.com", {
      source: "gmail",
      gmailAccountId: "acct-1",
    });
    expect(res.status).toBe(400);
    expect(await rowsFor("new@x.com")).toHaveLength(0);
  });

  it("rejects with 502 when the sendAs lookup returns an error, leaving the row untouched", async () => {
    const { apiKey } = await createTestUser({ role: "admin" });
    await seedGmailAccount();
    await seedIdentity();
    const fetchMock = stubSendAs({ status: 500 });

    const res = await patchInbox(apiKey, "a@x.com", {
      source: "gmail",
      gmailAccountId: "acct-1",
    });
    const raw = await res.text();
    expect(res.status).toBe(502);
    const body = JSON.parse(raw) as { error: string };
    expect(body.error).toMatch(/could not.*verif/i);
    expect(body.error).toMatch(/try again/i);
    // No token material may ride along on the failure — not the cached access
    // token, not the sealed refresh token, not an Authorization header, and
    // not a stray extra field carrying any of them.
    expect(raw).not.toMatch(/cached-at|rt-1|bearer|token/i);
    expect(Object.keys(body)).toEqual(["error"]);
    expect(calledSendAs(fetchMock)).toBe(true);

    // An unverifiable mapping must never be saved.
    const rows = await rowsFor("a@x.com");
    expect(rows).toHaveLength(1);
    expect(rows[0].source).toBe("cloudflare");
    expect(rows[0].gmailAccountId).toBeNull();
  });

  it("rejects with 502 when the sendAs lookup fails outright, leaving the row untouched", async () => {
    const { apiKey } = await createTestUser({ role: "admin" });
    await seedGmailAccount();
    await seedIdentity();
    const fetchMock = stubSendAs({ networkError: true });

    const res = await patchInbox(apiKey, "a@x.com", {
      source: "gmail",
      gmailAccountId: "acct-1",
    });
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/could not.*verif/i);
    expect(calledSendAs(fetchMock)).toBe(true);

    const rows = await rowsFor("a@x.com");
    expect(rows).toHaveLength(1);
    expect(rows[0].source).toBe("cloudflare");
    expect(rows[0].gmailAccountId).toBeNull();
  });

  it("rejects with 502 when the mapped Gmail account does not exist, leaving the row untouched", async () => {
    const { apiKey } = await createTestUser({ role: "admin" });
    await seedIdentity();
    // No gmail_accounts row: there is no token to check with, so the mapping
    // is unverifiable and must not be saved.
    stubSendAs({ addresses: ["a@x.com"] });

    const res = await patchInbox(apiKey, "a@x.com", {
      source: "gmail",
      gmailAccountId: "acct-missing",
    });
    expect(res.status).toBe(502);

    const rows = await rowsFor("a@x.com");
    expect(rows[0].source).toBe("cloudflare");
    expect(rows[0].gmailAccountId).toBeNull();
  });

  it("rejects with 503 when Gmail integration is not configured, leaving the row untouched", async () => {
    const { apiKey } = await createTestUser({ role: "admin" });
    await seedGmailAccount();
    await seedIdentity();
    stubSendAs({ addresses: ["a@x.com"] });

    // Each of the three secrets on its own: without any one of them there is
    // no token to check with, and "try again" would be the wrong advice.
    const secrets = [
      "GOOGLE_OAUTH_CLIENT_ID",
      "GOOGLE_OAUTH_CLIENT_SECRET",
      "TOKEN_ENCRYPTION_KEY",
    ];
    for (const secret of secrets) {
      const bindings = env as Record<string, unknown>;
      const saved = bindings[secret];
      delete bindings[secret];
      try {
        const res = await patchInbox(apiKey, "a@x.com", {
          source: "gmail",
          gmailAccountId: "acct-1",
        });
        expect(res.status, `unset ${secret}`).toBe(503);
        const body = (await res.json()) as { error: string };
        expect(body.error).toMatch(/not configured/i);
      } finally {
        bindings[secret] = saved;
      }

      const rows = await rowsFor("a@x.com");
      expect(rows[0].source, `unset ${secret}`).toBe("cloudflare");
      expect(rows[0].gmailAccountId).toBeNull();
    }
  });

  it("GET list returns source and gmailAccountId for an inbox mapped through PATCH", async () => {
    const { apiKey } = await createTestUser({ role: "admin" });
    await seedGmailAccount();
    stubSendAs({ addresses: ["a@x.com"] });

    // A real round trip: the mapping is written by PATCH and read back by the
    // list route, so a write that lands somewhere the list does not read is
    // caught here.
    const patched = await patchInbox(apiKey, "a@x.com", {
      source: "gmail",
      gmailAccountId: "acct-1",
    });
    expect(patched.status).toBe(200);

    const list = await authFetch("/api/admin/inboxes", { apiKey });
    expect(list.status).toBe(200);
    const rows = (await list.json()) as Array<{
      email: string;
      source: string;
      gmailAccountId: string | null;
    }>;
    const row = rows.find((r) => r.email === "a@x.com");
    expect(row?.source).toBe("gmail");
    expect(row?.gmailAccountId).toBe("acct-1");
  });

  it("a partial update that omits source/gmailAccountId leaves them unchanged without re-checking Gmail", async () => {
    const { apiKey } = await createTestUser({ role: "admin" });
    await seedGmailAccount();
    await seedIdentity({ source: "gmail", gmailAccountId: "acct-1" });
    // Renaming an inbox must not depend on Gmail being reachable: the mapping
    // itself is unchanged and was already checked when it was saved.
    const fetchMock = stubSendAs({ addresses: ["a@x.com"] });

    const res = await patchInbox(apiKey, "a@x.com", { displayName: "Renamed" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      source: string;
      gmailAccountId: string | null;
    };
    expect(body.source).toBe("gmail");
    expect(body.gmailAccountId).toBe("acct-1");
    expect(calledSendAs(fetchMock)).toBe(false);

    const rows = await rowsFor("a@x.com");
    expect(rows[0].displayName).toBe("Renamed");
    expect(rows[0].source).toBe("gmail");
    expect(rows[0].gmailAccountId).toBe("acct-1");
  });

  it("clears gmailAccountId when a body names only source cloudflare", async () => {
    // "Unmapped" has to mean unmapped to the cron too. Leaving the id behind
    // kept the inbox receiving through Google while replies left through the
    // configured provider.
    const { apiKey } = await createTestUser({ role: "admin" });
    await seedGmailAccount();
    await seedIdentity({
      displayName: "Keep me",
      source: "gmail",
      gmailAccountId: "acct-1",
    });

    const res = await patchInbox(apiKey, "a@x.com", { source: "cloudflare" });

    expect(res.status).toBe(200);
    const rows = await rowsFor("a@x.com");
    expect(rows[0].source).toBe("cloudflare");
    expect(rows[0].gmailAccountId).toBeNull();
    // Unmapping is not a reset of the rest of the row.
    expect(rows[0].displayName).toBe("Keep me");
  });

  it("rejects a body that asks for cloudflare and a mailbox at once", async () => {
    const { apiKey } = await createTestUser({ role: "admin" });
    await seedGmailAccount();
    const fetchMock = stubSendAs({ addresses: ["a@x.com"] });

    const res = await patchInbox(apiKey, "a@x.com", {
      source: "cloudflare",
      gmailAccountId: "acct-1",
    });

    expect(res.status).toBe(400);
    // Refused before anything was asked of Google, and before anything was
    // written.
    expect(calledSendAs(fetchMock)).toBe(false);
    expect(await rowsFor("a@x.com")).toHaveLength(0);
  });

  it("forgets the old mailbox's Gmail thread ids when an inbox is re-pointed", async () => {
    // Gmail thread ids are per-mailbox and nothing records which account
    // issued one. Left behind, the next reply on any pre-remap thread hands
    // the OLD account's id to the NEW account's messages.send: 4xx, terminal,
    // never queued — so every historical thread 502s forever while the UI
    // says to send it again, and the only exit is a manual D1 UPDATE.
    const { apiKey } = await createTestUser({ role: "admin" });
    await seedGmailAccount();
    await seedGmailAccount({ id: "acct-2", emailAddress: "other@acme.dev" });
    await seedIdentity({ source: "gmail", gmailAccountId: "acct-1" });

    const person = await createTestPerson({ id: "p-1", email: "c@ex.com" });
    await createTestEmail({
      id: "rcv-old",
      personId: person.id,
      recipient: "a@x.com",
      subject: "Before the remap",
      messageId: "old@ex.com",
    });
    const now = Math.floor(Date.now() / 1000);
    await getDb()
      .update(emails)
      .set({ gmailMessageId: "m-old", gmailThreadId: "th-acct-1" })
      .where(eq(emails.id, "rcv-old"));
    await getDb().insert(sentEmails).values({
      id: "snt-old",
      personId: person.id,
      fromAddress: "a@x.com",
      toAddress: "c@ex.com",
      subject: "Re: Before the remap",
      status: "sent",
      gmailMessageId: "m-old-sent",
      gmailThreadId: "th-acct-1",
      sentAt: now,
      createdAt: now,
    });
    // A row on a DIFFERENT inbox, whose mapping this PATCH does not touch.
    await createTestEmail({
      id: "rcv-other",
      personId: person.id,
      recipient: "b@x.com",
      subject: "Another inbox",
      messageId: "other@ex.com",
    });
    await getDb()
      .update(emails)
      .set({ gmailThreadId: "th-elsewhere" })
      .where(eq(emails.id, "rcv-other"));

    stubSendAs({ addresses: ["a@x.com"] });
    const res = await patchInbox(apiKey, "a@x.com", {
      source: "gmail",
      gmailAccountId: "acct-2",
    });
    expect(res.status).toBe(200);
    expect((await rowsFor("a@x.com"))[0].gmailAccountId).toBe("acct-2");

    const [received] = await getDb()
      .select()
      .from(emails)
      .where(eq(emails.id, "rcv-old"));
    expect(received.gmailThreadId).toBeNull();
    const [sent] = await getDb()
      .select()
      .from(sentEmails)
      .where(eq(sentEmails.id, "snt-old"));
    expect(sent.gmailThreadId).toBeNull();
    // Only this inbox's threads are forgotten.
    const [untouched] = await getDb()
      .select()
      .from(emails)
      .where(eq(emails.id, "rcv-other"));
    expect(untouched.gmailThreadId).toBe("th-elsewhere");
  });

  it("leaves the stored threads alone when the mapping did not change", async () => {
    // Renaming an inbox must not cost it its Gmail threading.
    const { apiKey } = await createTestUser({ role: "admin" });
    await seedGmailAccount();
    await seedIdentity({ source: "gmail", gmailAccountId: "acct-1" });
    const person = await createTestPerson({ id: "p-2", email: "d@ex.com" });
    await createTestEmail({
      id: "rcv-keep",
      personId: person.id,
      recipient: "a@x.com",
      subject: "Keep me threaded",
      messageId: "keep@ex.com",
    });
    await getDb()
      .update(emails)
      .set({ gmailThreadId: "th-acct-1" })
      .where(eq(emails.id, "rcv-keep"));

    const res = await patchInbox(apiKey, "a@x.com", {
      displayName: "Renamed",
    });
    expect(res.status).toBe(200);

    const [row] = await getDb()
      .select()
      .from(emails)
      .where(eq(emails.id, "rcv-keep"));
    expect(row.gmailThreadId).toBe("th-acct-1");
  });

  it("rejects a non-null gmailGroupAddress with 400 and leaves the row untouched", async () => {
    const { apiKey } = await createTestUser({ role: "admin" });
    await seedIdentity();

    const res = await patchInbox(apiKey, "a@x.com", {
      source: "gmail",
      gmailAccountId: "acct-1",
      gmailGroupAddress: "group@example.com",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/group/i);
    expect(body.error).toMatch(/not supported/i);

    // Nothing from the same request applied — not even the other fields.
    const rows = await rowsFor("a@x.com");
    expect(rows).toHaveLength(1);
    expect(rows[0].displayName).toBe("Original");
    expect(rows[0].source).toBe("cloudflare");
    expect(rows[0].gmailAccountId).toBeNull();
  });

  it("rejects source gmail with no account id, without asking Gmail anything", async () => {
    // The sendAs guard only runs when an account id is present, so this is
    // the one shape that could write a "gmail" row nothing ever verified.
    const { apiKey } = await createTestUser({ role: "admin" });
    await seedIdentity();
    const fetchFn = stubSendAs({ addresses: ["a@x.com"] });

    const res = await patchInbox(apiKey, "a@x.com", {
      source: "gmail",
      gmailAccountId: null,
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/gmailAccountId/);
    // Refused before any lookup — there is no mailbox to ask.
    expect(calledSendAs(fetchFn)).toBe(false);

    const rows = await rowsFor("a@x.com");
    expect(rows).toHaveLength(1);
    expect(rows[0].source).toBe("cloudflare");
    expect(rows[0].gmailAccountId).toBeNull();
    expect(rows[0].displayName).toBe("Original");
  });

  it("PATCH rejects a source value outside the enum with 400", async () => {
    const { apiKey } = await createTestUser({ role: "admin" });
    const res = await patchInbox(apiKey, "a@x.com", { source: "outlook" });
    expect(res.status).toBe(400);
  });

  it("returns 403 for a non-admin caller", async () => {
    const { apiKey } = await createTestUser({
      id: "u-mem",
      role: "member",
      email: "m@x.com",
    });
    const res = await patchInbox(apiKey, "a@x.com", { source: "gmail" });
    expect(res.status).toBe(403);
  });
});
