// docs/archive/SPEC-reply-to.md §3: a reply follows the original's Reply-To unless the caller
// asks for the sender, never mails one of our own inboxes, and stays on the
// original sender's timeline.
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { emails } from "../db/emails.schema";
import { senderIdentities } from "../db/sender-identities.schema";
import { sentEmails } from "../db/sent-emails.schema";
import type {
  EmailSender,
  SendEmailParams,
  SendEmailResult,
} from "../lib/email-sender";
import {
  replyToEmail,
  type ReplyEmailFailure,
  type ReplyEmailResult,
  type ReplyEmailSuccess,
} from "../lib/send-email";
import { computeConversationId } from "../lib/conversation-id";
import { MAX_CC_ENTRIES } from "../lib/send-limits";
import {
  applyMigrations,
  authFetch,
  buildSendForm,
  cleanDb,
  createTestEmail,
  createTestPerson,
  createTestSentEmail,
  createTestUser,
  getDb,
} from "./helpers";

const ADMIN = { isAdmin: true } as const;
const INBOX = "support@saasmail.test";
const OTHER_INBOX = "billing@saasmail.test";
const SENDER = "noreply@acme.com";

const list = (...addresses: string[]) =>
  JSON.stringify(addresses.map((email) => ({ email, name: null })));

function recorder() {
  const calls: SendEmailParams[] = [];
  const sender: EmailSender = {
    provider: "demo" as const,
    async send(params: SendEmailParams): Promise<SendEmailResult> {
      calls.push(params);
      return { id: "provider-1", error: null };
    },
    maxAttachmentBytes: () => 25 * 1024 * 1024,
    maxMessageBytes: () => 25 * 1024 * 1024,
  };
  return { sender, calls };
}

type ReplyOptions = {
  recipient?: "reply_to" | "sender";
  cc?: { email: string; name?: string | null }[];
  fromAddress?: string;
};

async function reply(emailId: string, options: ReplyOptions = {}) {
  const probe = recorder();
  const result = await replyToEmail({
    db: getDb(),
    env: env as unknown as CloudflareBindings,
    emailId,
    payload: {
      fromAddress: options.fromAddress ?? INBOX,
      bodyHtml: "<p>thanks</p>",
      ...(options.cc ? { cc: options.cc } : {}),
    },
    files: [],
    allowed: ADMIN,
    sender: probe.sender,
    ...(options.recipient ? { recipient: options.recipient } : {}),
  });
  return { result, call: probe.calls[0] };
}

function sent(result: ReplyEmailResult): ReplyEmailSuccess {
  if (!result.ok) {
    throw new Error(`reply failed: ${(result as ReplyEmailFailure).code}`);
  }
  return result as ReplyEmailSuccess;
}

describe("replyToEmail and Reply-To", () => {
  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDb();
    const now = Math.floor(Date.now() / 1000);
    await getDb()
      .insert(senderIdentities)
      .values(
        [INBOX, OTHER_INBOX].map((email) => ({
          email,
          createdAt: now,
          updatedAt: now,
        })),
      );
    await createTestPerson({ id: "p1", email: SENDER });
  });

  async function received(
    overrides: { replyTo?: string | null; rawHeaders?: string } = {},
  ) {
    await createTestEmail({
      id: "e1",
      personId: "p1",
      recipient: INBOX,
      messageId: "<ticket-1@acme.com>",
      ...overrides,
    });
  }

  it("addresses the reply to the Reply-To and keeps it on the sender's timeline", async () => {
    await received({ replyTo: list("help@acme.com") });

    const { result, call } = await reply("e1");
    const ok = sent(result);
    expect(call.to).toBe("help@acme.com");
    expect(ok.to).toBe("help@acme.com");
    expect(ok.repliedTo).toBe("reply_to");

    const [row] = await getDb()
      .select()
      .from(sentEmails)
      .where(eq(sentEmails.id, ok.id));
    expect(row.toAddress).toBe("help@acme.com");
    expect(row.personId).toBe("p1");
  });

  it("puts the first Reply-To in To and the rest in Cc, once each", async () => {
    await received({
      replyTo: list("help@acme.com", "b@acme.com", "c@acme.com"),
    });

    const { result, call } = await reply("e1", {
      cc: [{ email: "B@acme.com", name: "Bee" }, { email: "boss@acme.com" }],
    });
    const ok = sent(result);
    expect(call.to).toBe("help@acme.com");
    expect(call.cc).toEqual([
      "Bee <b@acme.com>",
      "boss@acme.com",
      "c@acme.com",
    ]);

    const [row] = await getDb()
      .select({ cc: sentEmails.cc })
      .from(sentEmails)
      .where(eq(sentEmails.id, ok.id));
    expect(
      (JSON.parse(row.cc!) as { email: string }[]).map((c) => c.email),
    ).toEqual(["b@acme.com", "boss@acme.com", "c@acme.com"]);
  });

  it("never exceeds the Cc limit when Reply-To adds addresses", async () => {
    await received({
      replyTo: list("help@acme.com", "b@acme.com", "c@acme.com"),
    });
    const full = Array.from({ length: MAX_CC_ENTRIES - 1 }, (_, i) => ({
      email: `cc${i}@acme.com`,
    }));

    const { call } = await reply("e1", { cc: full });
    expect(call.cc).toHaveLength(MAX_CC_ENTRIES);
    expect(call.cc![MAX_CC_ENTRIES - 1]).toBe("b@acme.com");
  });

  it("answers the sender when the Reply-To is one of our inboxes", async () => {
    await received({ replyTo: list(OTHER_INBOX) });

    const { result, call } = await reply("e1");
    expect(call.to).toBe(SENDER);
    expect(sent(result).repliedTo).toBe("sender");
  });

  it("skips our own inboxes inside a longer Reply-To list", async () => {
    await received({ replyTo: list("Billing@SaaSMail.test", "help@acme.com") });

    const { result, call } = await reply("e1");
    expect(call.to).toBe("help@acme.com");
    expect(call.cc ?? []).toEqual([]);
    expect(sent(result).repliedTo).toBe("reply_to");
  });

  it("does not reply to the address it is sending from", async () => {
    // An admin may send from an address that is not a configured inbox.
    await received({ replyTo: list("alias@saasmail.test") });

    const { result, call } = await reply("e1", {
      fromAddress: "alias@saasmail.test",
    });
    expect(call.to).toBe(SENDER);
    expect(sent(result).repliedTo).toBe("sender");
  });

  it('answers the sender when asked with recipient: "sender"', async () => {
    await received({ replyTo: list("help@acme.com", "b@acme.com") });

    const { result, call } = await reply("e1", { recipient: "sender" });
    const ok = sent(result);
    expect(call.to).toBe(SENDER);
    expect(call.cc ?? []).toEqual([]);
    expect(ok.to).toBe(SENDER);
    expect(ok.repliedTo).toBe("sender");
  });

  it("answers the sender when there is no Reply-To", async () => {
    await received();

    const { result, call } = await reply("e1");
    expect(call.to).toBe(SENDER);
    expect(sent(result).repliedTo).toBe("sender");
  });

  it("leaves a reply to one of our sent messages unchanged", async () => {
    await createTestSentEmail({
      id: "s1",
      personId: "p1",
      fromAddress: INBOX,
      toAddress: "customer@acme.com",
    });

    const { result, call } = await reply("s1");
    const ok = sent(result);
    expect(call.to).toBe("customer@acme.com");
    expect(ok.to).toBe("customer@acme.com");
    expect(ok.repliedTo).toBe("sender");
  });

  it("uses the raw_headers Reply-To of an older row and stores it", async () => {
    await received({
      replyTo: null,
      rawHeaders: JSON.stringify({
        "reply-to": "Help Desk <Help@Acme.com>",
      }),
    });

    const { result, call } = await reply("e1");
    expect(call.to).toBe("help@acme.com");
    expect(sent(result).repliedTo).toBe("reply_to");

    const [row] = await getDb()
      .select({ replyTo: emails.replyTo })
      .from(emails)
      .where(eq(emails.id, "e1"));
    expect(JSON.parse(row.replyTo!)).toEqual([
      { email: "help@acme.com", name: "Help Desk" },
    ]);
  });

  it("does not store anything for an older row without a Reply-To", async () => {
    await received({ replyTo: null, rawHeaders: "{}" });

    await reply("e1");
    const [row] = await getDb()
      .select({ replyTo: emails.replyTo })
      .from(emails)
      .where(eq(emails.id, "e1"));
    expect(row.replyTo).toBeNull();
  });

  it("does not copy the address the reply is already addressed to", async () => {
    // A reply-all composer carries the original's Cc; here that Cc is also
    // where the sender asked for replies.
    await received({ replyTo: list("team@acme.com") });

    const { result, call } = await reply("e1", {
      cc: [{ email: "Team@acme.com" }, { email: "boss@acme.com" }],
    });
    const ok = sent(result);
    expect(call.to).toBe("team@acme.com");
    expect(call.cc).toEqual(["boss@acme.com"]);
    expect(ok.cc).toEqual(["boss@acme.com"]);

    const [row] = await getDb()
      .select({ cc: sentEmails.cc })
      .from(sentEmails)
      .where(eq(sentEmails.id, ok.id));
    expect(
      (JSON.parse(row.cc!) as { email: string }[]).map((c) => c.email),
    ).toEqual(["boss@acme.com"]);
  });

  it("sends no Cc at all when the only Cc was the new To", async () => {
    await received({ replyTo: list("team@acme.com") });

    const { result, call } = await reply("e1", {
      cc: [{ email: "team@acme.com" }],
    });
    expect(call.to).toBe("team@acme.com");
    expect(call.cc ?? []).toEqual([]);
    expect(sent(result).cc).toEqual([]);
  });

  it("reports every address a reply was copied to", async () => {
    // The first Reply-To address is the sender itself; the second still
    // receives a copy, and the caller is told.
    await received({ replyTo: list(SENDER, "desk@acme.com") });

    const { result, call } = await reply("e1");
    const ok = sent(result);
    expect(call.to).toBe(SENDER);
    expect(call.cc).toEqual(["desk@acme.com"]);
    expect(ok.to).toBe(SENDER);
    expect(ok.cc).toEqual(["desk@acme.com"]);
    expect(ok.repliedTo).toBe("reply_to");
  });

  it("reports no copies when there are none", async () => {
    await received({ replyTo: list("help@acme.com") });
    expect(sent((await reply("e1")).result).cc).toEqual([]);
  });

  it("keeps a one-to-one reply out of any group conversation", async () => {
    await received({ replyTo: list("help@acme.com") });

    const ok = sent((await reply("e1")).result);
    const [row] = await getDb()
      .select({ conversationId: sentEmails.conversationId })
      .from(sentEmails)
      .where(eq(sentEmails.id, ok.id));
    expect(row.conversationId).toBeNull();
  });

  it("keeps a reply in the group conversation it was written in", async () => {
    // The thread is the sender plus bob; the message asks for replies at a
    // third address. The reply is delivered there and stays in the thread.
    const conversationId = await computeConversationId(INBOX, [
      SENDER,
      "bob@other.com",
    ]);
    expect(conversationId).not.toBeNull();
    await createTestEmail({
      id: "e1",
      personId: "p1",
      recipient: INBOX,
      messageId: "<ticket-1@acme.com>",
      conversationId,
      cc: list("bob@other.com"),
      replyTo: list("desk@acme.com", "second@acme.com"),
    });

    const { result, call } = await reply("e1", {
      cc: [{ email: "bob@other.com" }],
    });
    const ok = sent(result);
    expect(call.to).toBe("desk@acme.com");
    expect(call.cc).toEqual(["bob@other.com", "second@acme.com"]);

    const [row] = await getDb()
      .select({ conversationId: sentEmails.conversationId })
      .from(sentEmails)
      .where(eq(sentEmails.id, ok.id));
    expect(row.conversationId).toBe(conversationId);
  });

  it("does not store the Reply-To of a message re-attributed during the send", async () => {
    await createTestPerson({ id: "p2", email: "real-person@acme.com" });
    await received({
      replyTo: null,
      rawHeaders: JSON.stringify({ "reply-to": "help@acme.com" }),
    });

    // The provider call is where a concurrent re-attribution can land: the
    // row was read before it and the write-back comes after.
    const probe = recorder();
    const original = probe.sender.send.bind(probe.sender);
    probe.sender.send = async (params: SendEmailParams) => {
      await getDb()
        .update(emails)
        .set({ personId: "p2", rawHeaders: "{}", replyTo: null })
        .where(eq(emails.id, "e1"));
      return original(params);
    };
    await replyToEmail({
      db: getDb(),
      env: env as unknown as CloudflareBindings,
      emailId: "e1",
      payload: { fromAddress: INBOX, bodyHtml: "<p>thanks</p>" },
      files: [],
      allowed: ADMIN,
      sender: probe.sender,
    });

    const [row] = await getDb()
      .select({ replyTo: emails.replyTo })
      .from(emails)
      .where(eq(emails.id, "e1"));
    expect(row.replyTo).toBeNull();
  });
});

describe("POST /api/send/reply/{emailId} recipient", () => {
  let apiKey: string;

  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDb();
    ({ apiKey } = await createTestUser());
    (env as any).DEMO_MODE = "1";
    await createTestPerson({ id: "p1", email: SENDER });
    await createTestEmail({
      id: "e1",
      personId: "p1",
      recipient: INBOX,
      messageId: "<ticket-1@acme.com>",
      replyTo: list("help@acme.com"),
    });
  });

  afterEach(() => {
    (env as any).DEMO_MODE = "0";
  });

  function post(payload: Record<string, unknown>) {
    return authFetch("/api/send/reply/e1", {
      apiKey,
      method: "POST",
      body: buildSendForm({
        fromAddress: INBOX,
        bodyHtml: "<p>thanks</p>",
        ...payload,
      }),
    });
  }

  it("follows the Reply-To by default and says where the reply went", async () => {
    const res = await post({});
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      to: string;
      repliedTo: string;
      cc: string[];
    };
    expect(body.to).toBe("help@acme.com");
    expect(body.repliedTo).toBe("reply_to");
    expect(body.cc).toEqual([]);
  });

  it('answers the sender with recipient: "sender"', async () => {
    const res = await post({ recipient: "sender" });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { to: string; repliedTo: string };
    expect(body.to).toBe(SENDER);
    expect(body.repliedTo).toBe("sender");
  });

  it("rejects an unknown recipient value with 400", async () => {
    const res = await post({ recipient: "everyone" });
    expect(res.status).toBe(400);
  });
});
