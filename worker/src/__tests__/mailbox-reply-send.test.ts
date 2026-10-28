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
import { eq, sql } from "drizzle-orm";
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
import { attachments } from "../db/attachments.schema";
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
    R2: mutableEnv.R2,
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

  // Spec § 5.3: an unknown outcome keeps the key and the daily slot (the
  // message may be out); a definite refusal, a 429 included, gives both back.
  it.each([
    {
      label: "a 5xx",
      answer: () => new Response("backend error", { status: 503 }),
      unknown: true,
    },
    ...(p.name === "gmail"
      ? [
          {
            label: "a 2xx without a message id",
            answer: () =>
              new Response("<html>ok</html>", {
                status: 200,
                headers: { "content-type": "text/html" },
              }),
            unknown: true,
          },
        ]
      : []),
    {
      label: "a 429",
      answer: () =>
        new Response(JSON.stringify({ error: { message: "rate limited" } }), {
          status: 429,
          headers: { "content-type": "application/json" },
        }),
      unknown: false,
    },
  ])(
    "$label: the key and the daily slot are kept only when the outcome is unknown",
    async ({ answer, unknown }) => {
      await setDailySendLimits(getDb(), { api: 1 });
      const sends = stubMailbox(answer, p.accepted);

      const first = await reply("key-first");
      expect(first.status).toBe(502);
      expect(await first.json()).toMatchObject({ code: "SEND_FAILED" });

      const retry = await reply("key-first");
      if (unknown) {
        // Replayed: not sent again, and no second slot taken.
        expect(retry.status).toBe(502);
        expect(retry.headers.get("Idempotency-Replayed")).toBe("true");
        const other = await reply("key-other");
        expect(other.status).toBe(429);
        expect(await other.json()).toMatchObject({
          code: "DAILY_SEND_LIMIT_REACHED",
        });
        expect(sends).toHaveLength(1);
        await nothingStored();
      } else {
        // The key and the only slot were given back: the retry sends.
        expect(retry.status).toBe(201);
        expect(sends).toHaveLength(2);
        expect(await getDb().select().from(sentEmails)).toHaveLength(1);
      }
      expect(cloudflareSend).not.toHaveBeenCalled();
    },
  );

  // Spec § 5.1: the refusal follows the sender the reply resolves to, not the
  // inbox's mapping; an inbox that falls back to the configured provider is
  // held while paused, like any other.
  it("while paused, a mailbox reply with a file stores nothing; the same inbox falling back is held", async () => {
    await setSendingPaused(getDb(), true);
    const sends = stubMailbox(p.accepted);
    const objects = async () =>
      (await (env as unknown as CloudflareBindings).R2.list()).objects
        .map((o) => o.key)
        .filter((key) => key.startsWith("attachments/sent/"));
    const before = new Set(await objects());
    const withFile = () =>
      authFetch("/api/send/reply/rcv-1", {
        apiKey,
        method: "POST",
        body: buildSendForm(
          { fromAddress: p.inbox, bodyHtml: "<p>See attached.</p>" },
          [
            {
              name: "quote.pdf",
              type: "application/pdf",
              bytes: new Uint8Array([37, 80, 68, 70]),
            },
          ],
        ),
      });

    const refused = await withFile();
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({
      code: "MAILBOX_SEND_NOT_HELD",
    });
    await nothingStored();
    expect(await getDb().select().from(attachments)).toHaveLength(0);
    expect((await objects()).filter((key) => !before.has(key))).toEqual([]);

    // No TOKEN_ENCRYPTION_KEY: the mapping falls back to the configured
    // provider (as upstream), and that send is held as usual.
    mutableEnv.TOKEN_ENCRYPTION_KEY = "";
    const held = await withFile();
    expect(held.status).toBe(201);
    expect(await held.json()).toMatchObject({
      status: "retrying",
      paused: true,
    });
    expect(await getDb().select().from(outboxEmails)).toHaveLength(1);
    expect(await getDb().select().from(attachments)).toHaveLength(1);
    expect(sends).toHaveLength(0);
    expect(cloudflareSend).not.toHaveBeenCalled();
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

  function replyWithFile(key: string) {
    return authFetch("/api/send/reply/rcv-1", {
      apiKey,
      method: "POST",
      headers: { "Idempotency-Key": key },
      body: buildSendForm(
        { fromAddress: p.inbox, bodyHtml: "<p>See attached.</p>" },
        [
          {
            name: "quote.pdf",
            type: "application/pdf",
            bytes: new Uint8Array([37, 80, 68, 70]),
          },
        ],
      ),
    });
  }

  /** The same key replays without a second send, and keeps the only slot. */
  async function keyAndSlotKept(key: string, sends: string[]) {
    const retry = await replyWithFile(key);
    expect(retry.status).toBe(502);
    expect(retry.headers.get("Idempotency-Replayed")).toBe("true");
    const other = await reply("key-other");
    expect(other.status).toBe(429);
    expect(sends).toHaveLength(1);
    expect(cloudflareSend).not.toHaveBeenCalled();
  }

  it("an unknown outcome keeps its key and slot even when the attachment cleanup throws", async () => {
    await setDailySendLimits(getDb(), { api: 1 });
    const sends = stubMailbox(
      () => new Response("backend error", { status: 503 }),
      p.accepted,
    );
    const r2 = saved.R2 as R2Bucket;
    mutableEnv.R2 = new Proxy(r2, {
      get(target, prop) {
        if (prop === "delete") {
          return async () => {
            throw new Error("R2 unavailable");
          };
        }
        const value = Reflect.get(target, prop, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });

    const first = await replyWithFile("key-cleanup");
    expect(first.status).toBe(502);
    expect(await first.json()).toMatchObject({ code: "SEND_FAILED" });
    await keyAndSlotKept("key-cleanup", sends);
  });

  it("accepted, then its Sent row cannot be written: 502, and the key and slot are kept", async () => {
    await setDailySendLimits(getDb(), { api: 1 });
    const sends = stubMailbox(p.accepted, p.accepted);
    await getDb().run(
      sql`CREATE TRIGGER fail_sent_insert BEFORE INSERT ON sent_emails BEGIN SELECT RAISE(ABORT, 'injected'); END`,
    );
    try {
      const first = await replyWithFile("key-unrecorded");
      expect(first.status).toBe(502);
      const body = (await first.json()) as { error: string; code: string };
      expect(body.code).toBe("SEND_FAILED");
      expect(body.error).toMatch(/sent this message/);
      expect(body.error).toMatch(/Do not send it again/);
      await keyAndSlotKept("key-unrecorded", sends);
      await nothingStored();
      // The staged file of a reply that has no row is discarded.
      expect(await getDb().select().from(attachments)).toHaveLength(0);
    } finally {
      await getDb().run(sql`DROP TRIGGER IF EXISTS fail_sent_insert`);
    }
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
