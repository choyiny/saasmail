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

  it("replaces a mirror the sync wrote while this send was in flight, and leaves another mailbox's alone", async () => {
    // Gmail files a Sent copy the instant it answers 2xx, and emits the
    // history record with it. A cron tick landing between that 2xx and this
    // reply's `sent_emails` insert mirrors saasmail's own reply onto the
    // timeline — one reply, two rows, permanently. The send path's row is the
    // authoritative one (it has the draft body and the id handed back to the
    // caller), so it clears the mirror for its own (Gmail id, inbox) pair.
    await seedGmailAccount();
    await seedGmailIdentity();

    const person = await createTestPerson({
      id: "p-race",
      email: "customer-race@example.com",
    });
    await createTestEmail({
      id: "rcv-race",
      personId: person.id,
      recipient: "support@acme.dev",
      subject: "Question",
      messageId: "parent-race@example.com",
    });

    const now = Math.floor(Date.now() / 1000);
    await getDb()
      .insert(sentEmails)
      .values([
        {
          // What the racing cron tick wrote: same Gmail id, same inbox.
          id: "mirrored-by-cron",
          personId: person.id,
          fromAddress: "support@acme.dev",
          toAddress: "customer-race@example.com",
          subject: "Re: Question",
          bodyText: "mirrored from the Sent folder",
          status: "sent",
          gmailMessageId: "18race",
          gmailThreadId: "thread-race",
          sentAt: now,
          createdAt: now,
        },
        {
          // A DIFFERENT mailbox's row carrying the same id. Gmail message ids
          // are unique per mailbox, not globally, so this is a real row that
          // must survive untouched.
          id: "other-mailbox",
          personId: person.id,
          fromAddress: "billing@acme.dev",
          toAddress: "customer-race@example.com",
          subject: "Unrelated",
          bodyText: "another mailbox's message",
          status: "sent",
          gmailMessageId: "18race",
          gmailThreadId: "thread-other",
          sentAt: now,
          createdAt: now,
        },
      ]);

    vi.stubGlobal(
      "fetch",
      stubGmailSend({ id: "18race", threadId: "thread-race" }),
    );

    const res = await authFetch("/api/send/reply/rcv-race", {
      apiKey,
      method: "POST",
      body: buildSendForm({
        fromAddress: "support@acme.dev",
        bodyHtml: "<p>Thanks for reaching out.</p>",
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string };

    const rows = await getDb()
      .select()
      .from(sentEmails)
      .where(eq(sentEmails.gmailMessageId, "18race"));
    // One row for support@, one for billing@ — never two for support@.
    expect(rows.map((r) => r.id).sort()).toEqual(
      ["other-mailbox", body.id].sort(),
    );
    const ours = rows.find((r) => r.fromAddress === "support@acme.dev")!;
    expect(ours.id).toBe(body.id);
    expect(ours.bodyHtml).toBe("<p>Thanks for reaching out.</p>");
  });

  it("drops a parent thread id that belongs to a DIFFERENT Gmail mailbox", async () => {
    // Gmail thread ids are per-mailbox. Handing one mailbox's thread to
    // another's users/me/messages/send gets a 400, which is terminal, and a
    // terminal Gmail failure is never queued — so this would be a reply that
    // can never be sent. Losing the threading is the better outcome.
    await seedGmailAccount();
    await seedGmailAccount({
      id: "acct-2",
      emailAddress: "other@xyspace.dev",
    });
    await seedGmailIdentity();
    await seedGmailIdentity({
      email: "billing@acme.dev",
      displayName: "Billing",
      gmailAccountId: "acct-2",
    });

    const person = await createTestPerson({
      id: "p-cross",
      email: "customer-cross@example.com",
    });
    // The parent was synced into billing@acme.dev — acct-2's mailbox.
    await createTestEmail({
      id: "rcv-cross",
      personId: person.id,
      recipient: "billing@acme.dev",
      subject: "Question",
      messageId: "parent-cross@example.com",
    });
    await getDb()
      .update(emails)
      .set({ gmailThreadId: "thread-acct-2" })
      .where(eq(emails.id, "rcv-cross"));

    const fetchMock = stubGmailSend({ id: "18cross", threadId: "thread-new" });
    vi.stubGlobal("fetch", fetchMock);

    // ...but the reply goes out from support@acme.dev, which is acct-1.
    const res = await authFetch("/api/send/reply/rcv-cross", {
      apiKey,
      method: "POST",
      body: buildSendForm({
        fromAddress: "support@acme.dev",
        bodyHtml: "<p>Thanks for reaching out.</p>",
      }),
    });

    // Sent, not refused.
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string };

    const sentBody = JSON.parse(
      (fetchMock.mock.calls[0][1] as RequestInit).body as string,
    );
    // The other mailbox's thread id never reached Gmail.
    expect(sentBody.threadId).toBeUndefined();

    // And the row records the thread Gmail actually assigned.
    const rows = await getDb()
      .select()
      .from(sentEmails)
      .where(eq(sentEmails.id, body.id));
    expect(rows[0].gmailThreadId).toBe("thread-new");
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

  it("sizes a Gmail reply's attachment with Gmail's budget, not the configured provider's", async () => {
    // The Gmail-only install, which is the natural deployment for this
    // feature: no provider configured, so createEmailSender returns
    // NoopSender and its attachment budget is 0. Sizing the reply with it
    // 413s every attachment Gmail would have accepted.
    const originalResend = (env as any).RESEND_API_KEY;
    (env as any).RESEND_API_KEY = "";
    try {
      await seedGmailAccount();
      await seedGmailIdentity();

      const person = await createTestPerson({
        id: "p-attach",
        email: "customer6@example.com",
      });
      await createTestEmail({
        id: "rcv-attach",
        personId: person.id,
        recipient: "support@acme.dev",
        subject: "Question",
        messageId: "parent-attach@example.com",
      });
      // A Cloudflare-side inbox and parent, for the control below.
      await createTestEmail({
        id: "rcv-attach-cf",
        personId: person.id,
        recipient: "me@saasmail.test",
        subject: "Question",
        messageId: "parent-attach-cf@example.com",
      });

      const fetchMock = stubGmailSend({
        id: "18attach",
        threadId: "thread-attach",
      });
      vi.stubGlobal("fetch", fetchMock);

      const attachment = {
        name: "invoice.pdf",
        type: "application/pdf",
        bytes: new Uint8Array(4096).fill(7),
      };

      const res = await authFetch("/api/send/reply/rcv-attach", {
        apiKey,
        method: "POST",
        body: buildSendForm(
          {
            fromAddress: "support@acme.dev",
            bodyHtml: "<p>Attached.</p>",
          },
          [attachment],
        ),
      });
      expect(res.status).toBe(201);

      // The attachment really travelled through GmailSender.
      const body = JSON.parse(
        (fetchMock.mock.calls[0][1] as RequestInit).body as string,
      );
      expect(atob(body.raw.replace(/-/g, "+").replace(/_/g, "/"))).toContain(
        "invoice.pdf",
      );

      // CONTROL: the identical attachment on a NON-Gmail inbox still gets
      // the configured provider's budget (0 here) and is refused. Without
      // this, a globally-raised limit would pass the assertion above.
      const cfRes = await authFetch("/api/send/reply/rcv-attach-cf", {
        apiKey,
        method: "POST",
        body: buildSendForm(
          {
            fromAddress: "me@saasmail.test",
            bodyHtml: "<p>Attached.</p>",
          },
          [attachment],
        ),
      });
      expect(cfRes.status).toBe(413);
    } finally {
      (env as any).RESEND_API_KEY = originalResend;
    }
  });

  it("refuses an unauthorized inbox before the attachment budget can reveal anything about it", async () => {
    // The budget is Gmail's for a Gmail-mapped inbox and the configured
    // provider's otherwise, so a 413's limitBytes says which. Resolving it
    // before the permission check would make that a pre-auth oracle: a
    // scoped member could learn which addresses are connected to Gmail by
    // sending an oversized attachment at each one.
    const originalResend = (env as any).RESEND_API_KEY;
    (env as any).RESEND_API_KEY = "";
    try {
      await seedGmailAccount();
      await seedGmailIdentity();

      // A member who owns no inboxes at all.
      const { apiKey: memberKey } = await createTestUser({
        id: "u-outsider",
        role: "member",
        email: "outsider@x.com",
      });

      const person = await createTestPerson({
        id: "p-oracle",
        email: "customer7@example.com",
      });
      await createTestEmail({
        id: "rcv-oracle",
        personId: person.id,
        recipient: "support@acme.dev",
        subject: "Question",
        messageId: "parent-oracle@example.com",
      });

      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);

      // Over NoopSender's budget of 0 and well under Gmail's, so the two
      // budgets give different statuses — which is precisely the leak.
      const probe = (from: string) =>
        authFetch("/api/send/reply/rcv-oracle", {
          apiKey: memberKey,
          method: "POST",
          body: buildSendForm({ fromAddress: from, bodyHtml: "<p>a</p>" }, [
            { name: "probe.pdf", bytes: new Uint8Array(4096).fill(1) },
          ]),
        });

      const gmailMapped = await probe("support@acme.dev");
      const notMapped = await probe("me@saasmail.test");

      // Identical refusals. Without the check the unmapped address answers
      // 413 (NoopSender's budget of 0) and the mapped one does not — one
      // request each and the caller knows which inboxes are on Gmail.
      expect(gmailMapped.status).toBe(403);
      expect(notMapped.status).toBe(403);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      (env as any).RESEND_API_KEY = originalResend;
    }
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

  it("a grant revoked UNDER a still-valid cached token is surfaced, recorded and re-authorized once", async () => {
    // The gap the other revocation test cannot reach: the cached access
    // token is present and unexpired, so nothing refreshes and nothing ever
    // discovers that Google killed the grant. Gmail answers 401, and without
    // the forced re-authorization below this fails identically on every
    // resend for up to an hour — no outbox row, no audit row, no lastError.
    await seedGmailAccount();
    await seedGmailIdentity();

    const person = await createTestPerson({
      id: "p-revoked",
      email: "customer4@example.com",
    });
    await createTestEmail({
      id: "rcv-revoked",
      personId: person.id,
      recipient: "support@acme.dev",
      subject: "Question",
      messageId: "parent-revoked@example.com",
    });

    let refreshAttempts = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("oauth2.googleapis.com")) {
        refreshAttempts++;
        return new Response(JSON.stringify({ error: "invalid_grant" }), {
          status: 400,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(
        JSON.stringify({ error: { message: "Invalid Credentials" } }),
        { status: 401, headers: { "content-type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const res = await authFetch("/api/send/reply/rcv-revoked", {
      apiKey,
      method: "POST",
      body: buildSendForm({
        fromAddress: "support@acme.dev",
        bodyHtml: "<p>Thanks for reaching out.</p>",
      }),
    });

    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string };
    // The 401 was acted on rather than passed through: exactly one forced
    // refresh, which is what turns an invisible revocation into a recorded one.
    expect(refreshAttempts).toBe(1);
    // The user is told to reconnect, NOT to press send again — resending is
    // futile until the grant is restored.
    expect(body.error).toMatch(/reconnect this mailbox/i);
    expect(body.error).not.toMatch(/send it again/i);
    expect(body.error).not.toMatch(/bearer|access.?token|refresh.?token/i);

    // Visible in GET /api/admin/gmail, exactly as a sync-side revocation is.
    const accounts = await getDb()
      .select()
      .from(gmailAccounts)
      .where(eq(gmailAccounts.id, "acct-1"));
    expect(accounts[0].lastError).toBe("invalid_grant");
    // And the dead token is gone, so the NEXT reply takes the refresh path in
    // createSenderForInbox and degrades to the configured provider.
    expect(accounts[0].accessToken).toBeNull();

    // The no-queue rule still holds on this path.
    expect(await getDb().select().from(outboxEmails)).toHaveLength(0);
    expect(await getDb().select().from(sentEmails)).toHaveLength(0);
  });

  it("a merely stale cached token is re-authorized and the reply goes out", async () => {
    // Same 401, but the grant is alive — the cached token had simply been
    // invalidated early. One forced refresh and the reply must succeed
    // rather than becoming a 502 the user has to retry by hand.
    await seedGmailAccount();
    await seedGmailIdentity();

    const person = await createTestPerson({
      id: "p-stale",
      email: "customer5@example.com",
    });
    await createTestEmail({
      id: "rcv-stale",
      personId: person.id,
      recipient: "support@acme.dev",
      subject: "Question",
      messageId: "parent-stale@example.com",
    });

    let sendAttempts = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("oauth2.googleapis.com")) {
        return new Response(
          JSON.stringify({ access_token: "fresh-at", expires_in: 3600 }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      sendAttempts++;
      if (sendAttempts === 1) {
        return new Response(
          JSON.stringify({ error: { message: "Invalid Credentials" } }),
          { status: 401, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({ id: "18stale", threadId: "thread-stale" }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const res = await authFetch("/api/send/reply/rcv-stale", {
      apiKey,
      method: "POST",
      body: buildSendForm({
        fromAddress: "support@acme.dev",
        bodyHtml: "<p>Thanks for reaching out.</p>",
      }),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string };
    // Retried exactly once, and the retry carried the refreshed token.
    expect(sendAttempts).toBe(2);
    const secondInit = fetchMock.mock.calls.at(-1)![1] as RequestInit;
    expect((secondInit.headers as Record<string, string>).Authorization).toBe(
      "Bearer fresh-at",
    );

    const rows = await getDb()
      .select()
      .from(sentEmails)
      .where(eq(sentEmails.id, body.id));
    expect(rows).toHaveLength(1);
    expect(rows[0].gmailMessageId).toBe("18stale");
  });

  it("does not wrap 'send it again' around a Gmail 2xx that carried no message id", async () => {
    // Gmail accepted the reply, so it is already on its way to the customer.
    // The route still answers 502 — there is no `sent_emails` row to hand
    // back — but the advice must not be to press send again, which would
    // deliver a second copy.
    await seedGmailAccount();
    await seedGmailIdentity();

    const person = await createTestPerson({
      id: "p-noid",
      email: "customer-noid@example.com",
    });
    await createTestEmail({
      id: "rcv-noid",
      personId: person.id,
      recipient: "support@acme.dev",
      subject: "Question",
      messageId: "parent-noid@example.com",
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("<html>Service Unavailable</html>", {
            status: 200,
            headers: { "content-type": "text/html" },
          }),
      ),
    );

    const res = await authFetch("/api/send/reply/rcv-noid", {
      apiKey,
      method: "POST",
      body: buildSendForm({
        fromAddress: "support@acme.dev",
        bodyHtml: "<p>Thanks for reaching out.</p>",
      }),
    });

    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/do not send it again/i);
    expect(body.error).not.toMatch(/send it again to retry/i);
    expect(body.error).not.toMatch(/did not accept/i);
    // And nothing is queued, so the outbox cannot resend it either.
    expect(await getDb().select().from(outboxEmails)).toHaveLength(0);
  });

  it("refuses a Gmail-mapped reply whose token cannot be resolved, instead of sending it through the configured provider", async () => {
    // The reply used to fall back here, and that is the failure this pins.
    // On this install the configured provider IS reachable (RESEND_API_KEY
    // is set in the test env), so the old code sent a Workspace address's
    // reply through Resend — DKIM-signed by the wrong service, absent from
    // the user's own Gmail Sent folder, and retried on a 15-minute loop.
    // On a Gmail-only install the same fallback is NoopSender, and the user
    // got a 201 and a cleared draft for a reply that was never sent.
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
        // One failed request to Google's token endpoint. This is a transient
        // blip, not a verdict about which transport this inbox uses.
        return new Response("upstream unavailable", { status: 503 });
      }
      throw new Error(`no other transport may be reached: ${url}`);
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

    // 502, not 201 — the composer keeps the draft open.
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/was not sent/i);
    expect(body.error).not.toMatch(/rt-1|cached-at|bearer/i);

    // Nothing was written and nothing is in flight: no row claiming a send,
    // and nothing for the cron to re-attempt through the wrong provider.
    expect(await getDb().select().from(sentEmails)).toHaveLength(0);
    expect(await getDb().select().from(outboxEmails)).toHaveLength(0);
    // Only Google was contacted. A call to any other host would mean the
    // reply had been handed to a transport this inbox does not send from.
    // Compare the parsed host, not a substring of the URL: a substring match
    // also accepts https://evil.example/?x=oauth2.googleapis.com, so it would
    // pass for a request to exactly the host this assertion exists to rule out.
    expect(
      fetchMock.mock.calls.map(([u]) => new URL(String(u)).host),
    ).toStrictEqual(fetchMock.mock.calls.map(() => "oauth2.googleapis.com"));
  });
});
