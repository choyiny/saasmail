// docs/gmail.md and docs/outlook.md: a reply from an inbox mapped to a Gmail
// or Outlook mailbox goes out through it at once or not at all, under the
// fork's send controls and idempotency; other mail from that inbox keeps the
// configured provider.
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
  authFetch,
  buildSendForm,
  cleanDb,
  createTestEmail,
  createTestPerson,
  createTestTemplate,
  createTestUser,
  getDb,
} from "./helpers";
import { gmailAccounts } from "../db/gmail-accounts.schema";
import { outlookAccounts } from "../db/outlook-accounts.schema";
import { outboxEmails } from "../db/outbox-emails.schema";
import { sentEmails } from "../db/sent-emails.schema";
import { senderIdentities } from "../db/sender-identities.schema";
import { sequenceEmails } from "../db/sequence-emails.schema";
import { sequenceEnrollments } from "../db/sequence-enrollments.schema";
import { sequences } from "../db/sequences.schema";
import { encryptSecret } from "../lib/crypto";
import { saveProviderConfig } from "../lib/oauth-providers";
import { processOutbox } from "../lib/outbox";
import { handleQueueBatch } from "../lib/queue-router";
import { setDailySendLimits, setSendingPaused } from "../lib/sending-controls";

// Matches TOKEN_ENCRYPTION_KEY in vitest.config.test.ts.
const KEY = "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=";

type Provider = {
  name: "gmail" | "outlook";
  inbox: string;
  sendUrl: string;
  /** The provider's answer to an accepted send. */
  accepted: () => Response;
  seed: () => Promise<void>;
  /** The inbox left mapped to an account row that no longer exists. */
  deleteAccount: () => Promise<void>;
  disconnectPath: string;
};

const PROVIDERS: Provider[] = [
  {
    name: "gmail",
    inbox: "support@acme.dev",
    sendUrl: "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
    accepted: () =>
      new Response(JSON.stringify({ id: "g-1", threadId: "t-1" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    async seed() {
      const now = Math.floor(Date.now() / 1000);
      await getDb()
        .insert(gmailAccounts)
        .values({
          id: "acct-1",
          emailAddress: "support@acme.dev",
          refreshTokenEncrypted: await encryptSecret("rt-1", KEY),
          accessToken: "cached-at",
          expiresAt: now + 3600,
          historyId: "1",
          connectedBy: "user-1",
          createdAt: now,
          updatedAt: now,
        });
      await getDb().insert(senderIdentities).values({
        email: "support@acme.dev",
        displayName: "Support",
        source: "gmail",
        gmailAccountId: "acct-1",
        createdAt: now,
        updatedAt: now,
      });
    },
    async deleteAccount() {
      await getDb().delete(gmailAccounts).where(eq(gmailAccounts.id, "acct-1"));
    },
    disconnectPath: "/api/admin/gmail/acct-1",
  },
  {
    name: "outlook",
    inbox: "jane@contoso.com",
    sendUrl: "https://graph.microsoft.com/v1.0/me/sendMail",
    // Graph accepts with 202 and no body, so no id.
    accepted: () => new Response(null, { status: 202 }),
    async seed() {
      const now = Math.floor(Date.now() / 1000);
      await saveProviderConfig(
        getDb(),
        env,
        "microsoft",
        { clientId: "ms-client", clientSecret: "ms-secret", tenant: null },
        null,
      );
      await getDb()
        .insert(outlookAccounts)
        .values({
          id: "ol-1",
          emailAddress: "jane@contoso.com",
          refreshTokenEncrypted: await encryptSecret("rt-1", KEY),
          accessToken: "cached-at",
          expiresAt: now + 3600,
          syncFrom: now - 1000,
          createdAt: now,
          updatedAt: now,
        });
      await getDb().insert(senderIdentities).values({
        email: "jane@contoso.com",
        displayName: "Jane",
        source: "outlook",
        outlookAccountId: "ol-1",
        createdAt: now,
        updatedAt: now,
      });
    },
    async deleteAccount() {
      await getDb()
        .delete(outlookAccounts)
        .where(eq(outlookAccounts.id, "ol-1"));
    },
    disconnectPath: "/api/admin/outlook/ol-1",
  },
];

const mutableEnv = env as unknown as Record<string, unknown>;
let saved: Record<string, unknown>;
/** The configured provider here: Cloudflare's send binding, mocked. */
let cloudflareSend: ReturnType<typeof vi.fn>;

beforeAll(async () => {
  await applyMigrations();
});

beforeEach(async () => {
  await cleanDb();
  saved = {
    RESEND_API_KEY: mutableEnv.RESEND_API_KEY,
    EMAIL: mutableEnv.EMAIL,
    TOKEN_ENCRYPTION_KEY: mutableEnv.TOKEN_ENCRYPTION_KEY,
  };
  cloudflareSend = vi.fn(async () => ({ messageId: "<cf-1@acme.dev>" }));
  mutableEnv.RESEND_API_KEY = "";
  mutableEnv.EMAIL = { send: cloudflareSend };
});

afterEach(() => {
  Object.assign(mutableEnv, saved);
  vi.unstubAllGlobals();
});

describe.each(PROVIDERS)("a reply from an inbox mapped to $name", (p) => {
  let apiKey: string;

  beforeEach(async () => {
    ({ apiKey } = await createTestUser({ role: "admin" }));
    await p.seed();
    const person = await createTestPerson({
      id: "p-1",
      email: "customer@example.com",
    });
    await createTestEmail({
      id: "rcv-1",
      personId: person.id,
      recipient: p.inbox,
      subject: "Question",
      messageId: "parent@example.com",
    });
  });

  /** Fetch answers in order; the token endpoints are never reached (cached). */
  function stubMailbox(...answers: Array<() => Response | Promise<Response>>) {
    const sends: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url !== p.sendUrl) throw new Error(`unexpected fetch: ${url}`);
        sends.push(url);
        const answer = answers[Math.min(sends.length, answers.length) - 1];
        return answer();
      }),
    );
    return sends;
  }

  function reply(key?: string) {
    return authFetch("/api/send/reply/rcv-1", {
      apiKey,
      method: "POST",
      ...(key ? { headers: { "Idempotency-Key": key } } : {}),
      body: buildSendForm({
        fromAddress: p.inbox,
        bodyHtml: "<p>Thanks for reaching out.</p>",
      }),
    });
  }

  async function nothingStored() {
    expect(await getDb().select().from(sentEmails)).toHaveLength(0);
    expect(await getDb().select().from(outboxEmails)).toHaveLength(0);
  }

  it("(a) at the daily cap: the fork's daily-limit response, nothing sent", async () => {
    await setDailySendLimits(getDb(), { api: 0 });
    const sends = stubMailbox(p.accepted);

    const res = await reply();

    expect(res.status).toBe(429);
    expect(sends).toHaveLength(0);
    await nothingStored();
  });

  it("(b) while sending is paused: refused, nothing stored or queued", async () => {
    await setSendingPaused(getDb(), true);
    const sends = stubMailbox(p.accepted);

    const res = await reply();

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "MAILBOX_SEND_NOT_HELD" });
    expect(sends).toHaveLength(0);
    expect(cloudflareSend).not.toHaveBeenCalled();
    await nothingStored();
  });

  it("(c) a provider 4xx: 502, and a retry with the same key sends", async () => {
    const sends = stubMailbox(
      () =>
        new Response(JSON.stringify({ error: { message: "bad request" } }), {
          status: 400,
          headers: { "content-type": "application/json" },
        }),
      p.accepted,
    );

    const first = await reply("key-4xx");
    expect(first.status).toBe(502);
    expect(await first.json()).toMatchObject({ code: "SEND_FAILED" });
    await nothingStored();

    const retry = await reply("key-4xx");
    expect(retry.status).toBe(201);
    expect(sends).toHaveLength(2);
    expect(await getDb().select().from(sentEmails)).toHaveLength(1);
    expect(cloudflareSend).not.toHaveBeenCalled();
  });

  it("(d) accepted but the answer is lost: 502, and a retry with the same key replays it", async () => {
    const sends = stubMailbox(() => {
      throw new TypeError("network connection lost");
    });

    const first = await reply("key-lost");
    expect(first.status).toBe(502);
    const body = (await first.json()) as { error: string; code: string };
    expect(body.code).toBe("SEND_FAILED");
    expect(body.error).toMatch(/Sent folder/);

    const retry = await reply("key-lost");
    expect(retry.status).toBe(502);
    expect(sends).toHaveLength(1);
    expect(cloudflareSend).not.toHaveBeenCalled();
    await nothingStored();
  });

  it("(e) mapped to a deleted account: 502, never through Cloudflare", async () => {
    await p.deleteAccount();
    const sends = stubMailbox(p.accepted);

    const res = await reply();

    expect(res.status).toBe(502);
    expect(sends).toHaveLength(0);
    expect(cloudflareSend).not.toHaveBeenCalled();
    await nothingStored();
  });

  it("(e) mapped, with TOKEN_ENCRYPTION_KEY missing: 502, never through Cloudflare", async () => {
    mutableEnv.TOKEN_ENCRYPTION_KEY = "";
    const sends = stubMailbox(p.accepted);

    const res = await reply();

    expect(res.status).toBe(502);
    expect(sends).toHaveLength(0);
    expect(cloudflareSend).not.toHaveBeenCalled();
    await nothingStored();
  });

  it("(e) after a real disconnect the inbox is Cloudflare's, and the reply goes through it", async () => {
    const disconnect = await authFetch(p.disconnectPath, {
      apiKey,
      method: "DELETE",
    });
    expect(disconnect.ok).toBe(true);
    const sends = stubMailbox(p.accepted);

    const res = await reply();

    expect(res.status).toBe(201);
    expect(sends).toHaveLength(0);
    expect(cloudflareSend).toHaveBeenCalledTimes(1);
  });
});

describe.each(PROVIDERS)(
  "mail from an inbox mapped to $name that is not a reply",
  (p) => {
    beforeEach(async () => {
      await createTestUser({ role: "admin" });
      await p.seed();
      await createTestPerson({ id: "p-1", email: "customer@example.com" });
    });

    function noMailboxFetch() {
      const sends: string[] = [];
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: RequestInfo | URL) => {
          sends.push(String(input));
          throw new Error(`unexpected fetch: ${String(input)}`);
        }),
      );
      return sends;
    }

    it("an outbox row written before the mapping drains through the configured provider", async () => {
      const db = getDb();
      const now = Math.floor(Date.now() / 1000);
      await db.insert(sentEmails).values({
        id: "se-1",
        personId: "p-1",
        fromAddress: p.inbox,
        toAddress: "customer@example.com",
        subject: "Hi",
        bodyHtml: "<p>Hi</p>",
        messageId: "<mid-1@acme.dev>",
        status: "retrying",
        sentAt: now - 100,
        createdAt: now - 100,
      });
      await db.insert(outboxEmails).values({
        id: "ob-1",
        sentEmailId: "se-1",
        fromAddress: p.inbox,
        toAddress: "customer@example.com",
        subject: "Hi",
        bodyHtml: "<p>Hi</p>",
        headers: JSON.stringify({ "Message-ID": "<mid-1@acme.dev>" }),
        transactional: 1,
        status: "pending",
        attempts: 1,
        lastError: "quota exceeded",
        nextRetryAt: now - 10,
        createdAt: now - 100,
        updatedAt: now - 100,
      });
      const sends = noMailboxFetch();

      await processOutbox(env as unknown as CloudflareBindings);

      expect(sends).toHaveLength(0);
      expect(cloudflareSend).toHaveBeenCalledTimes(1);
      const [row] = await db
        .select()
        .from(sentEmails)
        .where(eq(sentEmails.id, "se-1"));
      expect(row.status).toBe("sent");
    });

    it("a sequence step goes through the configured provider", async () => {
      const db = getDb();
      const now = Math.floor(Date.now() / 1000);
      await createTestTemplate({ slug: "welcome" });
      await db.insert(sequences).values({
        id: "seq-1",
        name: "Onboarding",
        steps: JSON.stringify([
          { order: 1, templateSlug: "welcome", delayHours: 0 },
        ]),
        createdAt: now,
        updatedAt: now,
      });
      await db.insert(sequenceEnrollments).values({
        id: "enr-1",
        sequenceId: "seq-1",
        personId: "p-1",
        status: "active",
        variables: "{}",
        fromAddress: p.inbox,
        enrolledAt: now,
      });
      await db.insert(sequenceEmails).values({
        id: "step-1",
        enrollmentId: "enr-1",
        stepOrder: 1,
        templateSlug: "welcome",
        scheduledAt: now - 10,
        status: "queued",
      });
      const sends = noMailboxFetch();
      const message = {
        body: { sequenceEmailId: "step-1" },
        ack: vi.fn(),
        retry: vi.fn(),
      };

      await handleQueueBatch(
        { messages: [message] } as unknown as MessageBatch<unknown>,
        env as unknown as CloudflareBindings,
      );

      expect(sends).toHaveLength(0);
      expect(cloudflareSend).toHaveBeenCalledTimes(1);
      const [step] = await db
        .select()
        .from(sequenceEmails)
        .where(eq(sequenceEmails.id, "step-1"));
      expect(step.status).toBe("sent");
    });
  },
);
