import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { autoReplyLog } from "../db/auto-reply-log.schema";
import { blocklist } from "../db/blocklist.schema";
import { mailboxMessageState } from "../db/mailbox-message-state.schema";
import { outboxEmails } from "../db/outbox-emails.schema";
import { rules } from "../db/rules.schema";
import { senderIdentities } from "../db/sender-identities.schema";
import { sentEmails } from "../db/sent-emails.schema";
import { suppressions } from "../db/suppressions.schema";
import type {
  EmailSender,
  SendEmailParams,
  SendEmailResult,
} from "../lib/email-sender";
import { runAutoReply } from "../lib/rules/auto-reply";
import { replyToEmail } from "../lib/send-email";
import {
  applyMigrations,
  cleanDb,
  createTestEmail,
  createTestPerson,
  getDb,
} from "./helpers";

const INBOX = "support@saasmail.test";
const CUSTOMER = "customer@example.com";
const NOW = 1_800_000_000;

beforeAll(applyMigrations);
beforeEach(cleanDb);

function fakeSender(
  sendImpl?: (params: SendEmailParams) => Promise<SendEmailResult>,
) {
  const sent: SendEmailParams[] = [];
  const send = vi.fn(async (params: SendEmailParams) => {
    sent.push(params);
    if (sendImpl) return sendImpl(params);
    return { id: "provider-1", error: null };
  });
  const sender: EmailSender = {
    provider: "demo",
    send,
    maxAttachmentBytes: () => 25 * 1024 * 1024,
  };
  return { sender, sent, send };
}

async function seed(
  rawHeaders: Record<string, string> = {},
  senderAddress = CUSTOMER,
) {
  await createTestPerson({
    id: "auto-reply-person",
    email: senderAddress,
  });
  await createTestEmail({
    id: "auto-reply-email",
    personId: "auto-reply-person",
    recipient: INBOX,
    subject: "Question",
    bodyText: "Could you help?",
    messageId: "<incoming@example.com>",
    rawHeaders: JSON.stringify(rawHeaders),
  });
  await getDb().insert(senderIdentities).values({
    email: INBOX,
    displayName: "Support",
    displayMode: "thread",
    signatureHtml: "<p>Support team</p>",
    createdAt: NOW,
    updatedAt: NOW,
  });
  await getDb()
    .insert(rules)
    .values({
      id: "auto-reply-rule",
      name: "Auto reply",
      inbox: INBOX,
      trigger: "message.received",
      conditions: [],
      actions: [{ type: "auto_reply", bodyText: "Thanks" }],
      position: 0,
      stopProcessing: 0,
      enabled: 1,
      matchCount: 0,
      createdAt: NOW,
      updatedAt: NOW,
    });
}

async function run(
  sender: EmailSender,
  overrides: Partial<Parameters<typeof runAutoReply>[2]> = {},
) {
  await runAutoReply(getDb(), env as unknown as CloudflareBindings, {
    ruleId: "auto-reply-rule",
    emailId: "auto-reply-email",
    inbox: INBOX,
    bodyText: "<b>Hello</b>\nNext",
    now: NOW,
    sender,
    ...overrides,
  });
}

async function expectNoAttempt(sender: EmailSender) {
  await run(sender);
  expect(sender.send).not.toHaveBeenCalled();
  expect(await getDb().select().from(autoReplyLog)).toHaveLength(0);
}

describe("auto-reply guards", () => {
  it.each([
    [{ "Auto-Submitted": "auto-replied" }],
    [{ Precedence: "bulk" }],
    [{ "List-Id": "<list.example.com>" }],
    [{ "List-Unsubscribe": "<mailto:leave@example.com>" }],
  ])("skips automated inbound mail %o", async (headers) => {
    await seed(headers);
    const { sender } = fakeSender();
    await expectNoAttempt(sender);
  });

  it.each([
    "mailer-daemon@example.com",
    "postmaster+dsn@example.com",
    "noreply@example.com",
    "no-reply+tag@example.com",
    "do-not-reply@example.com",
  ])("skips automated sender %s", async (senderAddress) => {
    await seed({}, senderAddress);
    const { sender } = fakeSender();
    await expectNoAttempt(sender);
  });

  it("skips mail from our own sender identities", async () => {
    await seed();
    await getDb().insert(senderIdentities).values({
      email: CUSTOMER,
      displayMode: "thread",
      createdAt: NOW,
      updatedAt: NOW,
    });
    const { sender } = fakeSender();
    await expectNoAttempt(sender);
  });

  it("skips blocked senders", async () => {
    await seed();
    await getDb().insert(blocklist).values({
      id: "blocked-auto-reply",
      type: "email",
      value: CUSTOMER,
      createdAt: NOW,
    });
    const { sender } = fakeSender();
    await expectNoAttempt(sender);
  });

  it("skips suppressed senders", async () => {
    await seed();
    await getDb().insert(suppressions).values({
      id: "suppressed-auto-reply",
      email: CUSTOMER,
      reason: "manual",
      createdAt: NOW,
    });
    const { sender } = fakeSender();
    await expectNoAttempt(sender);
  });

  it("skips messages already marked as spam", async () => {
    await seed();
    await getDb().insert(mailboxMessageState).values({
      inbox: INBOX,
      messageKind: "received",
      messageId: "auto-reply-email",
      spamAt: NOW,
      updatedBy: null,
      updatedAt: NOW,
    });
    const { sender } = fakeSender();
    await expectNoAttempt(sender);
  });

  it("atomically claims a sender under concurrent delivery", async () => {
    await seed();
    const { sender, send } = fakeSender();

    await Promise.all([run(sender), run(sender)]);

    expect(send).toHaveBeenCalledTimes(1);
    const logs = await getDb()
      .select()
      .from(autoReplyLog)
      .where(eq(autoReplyLog.ruleId, "auto-reply-rule"));
    expect(logs).toHaveLength(1);
  });

  it("enforces the 24-hour sender window and allows exactly 24h later", async () => {
    await seed();
    const { sender, send } = fakeSender();

    await run(sender, { now: NOW });
    await run(sender, { now: NOW + 24 * 60 * 60 - 1 });
    expect(send).toHaveBeenCalledTimes(1);

    await run(sender, { now: NOW + 24 * 60 * 60 });
    expect(send).toHaveBeenCalledTimes(2);

    const logs = await getDb()
      .select()
      .from(autoReplyLog)
      .where(eq(autoReplyLog.ruleId, "auto-reply-rule"));
    expect(logs).toEqual([
      expect.objectContaining({
        ruleId: "auto-reply-rule",
        sender: CUSTOMER,
        sentAt: NOW + 24 * 60 * 60,
      }),
    ]);
  });

  it("migration deduplicates legacy rows and keeps the latest sent_at", async () => {
    await seed();

    await env.DB.prepare(
      "DROP INDEX IF EXISTS auto_reply_log_rule_sender_unique",
    ).run();
    await env.DB.prepare(
      "CREATE INDEX auto_reply_log_rule_sender_sent_idx ON auto_reply_log(rule_id, sender, sent_at)",
    ).run();
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO auto_reply_log (rule_id, sender, sent_at) VALUES (?, ?, ?)",
      ).bind("auto-reply-rule", CUSTOMER, NOW - 20),
      env.DB.prepare(
        "INSERT INTO auto_reply_log (rule_id, sender, sent_at) VALUES (?, ?, ?)",
      ).bind("auto-reply-rule", CUSTOMER, NOW - 10),
    ]);

    await env.DB.prepare(
      `
      DELETE FROM auto_reply_log
      WHERE rowid NOT IN (
        SELECT (
          SELECT latest.rowid
          FROM auto_reply_log AS latest
          WHERE latest.rule_id = grouped.rule_id
            AND latest.sender = grouped.sender
          ORDER BY latest.sent_at DESC, latest.rowid DESC
          LIMIT 1
        )
        FROM auto_reply_log AS grouped
        GROUP BY grouped.rule_id, grouped.sender
      )
    `,
    ).run();
    await env.DB.prepare(
      "DROP INDEX auto_reply_log_rule_sender_sent_idx",
    ).run();
    await env.DB.prepare(
      "CREATE UNIQUE INDEX auto_reply_log_rule_sender_unique ON auto_reply_log(rule_id, sender)",
    ).run();

    expect(await getDb().select().from(autoReplyLog)).toEqual([
      expect.objectContaining({
        ruleId: "auto-reply-rule",
        sender: CUSTOMER,
        sentAt: NOW - 10,
      }),
    ]);
  });
});

describe("auto-reply sending", () => {
  it("writes the rate-limit log even when the send throws", async () => {
    await seed();
    const { sender } = fakeSender(async () => {
      throw new Error("transport exploded");
    });

    await run(sender);

    expect(await getDb().select().from(autoReplyLog)).toEqual([
      expect.objectContaining({
        ruleId: "auto-reply-rule",
        sender: CUSTOMER,
        sentAt: NOW,
      }),
    ]);
  });

  it("threads the reply, escapes plain text, appends the signature, and adds the automation header", async () => {
    await seed();
    const { sender, sent } = fakeSender();

    await run(sender);

    expect(sent).toHaveLength(1);
    expect(sent[0]).toEqual(
      expect.objectContaining({
        to: CUSTOMER,
        subject: "Re: Question",
        text: "<b>Hello</b>\nNext",
        html: "<p>&lt;b&gt;Hello&lt;/b&gt;<br>Next</p><div data-signature><p>Support team</p></div>",
        headers: expect.objectContaining({
          "Auto-Submitted": "auto-replied",
          "In-Reply-To": "<incoming@example.com>",
          References: "<incoming@example.com>",
        }),
      }),
    );

    const [stored] = await getDb().select().from(sentEmails);
    expect(stored).toEqual(
      expect.objectContaining({
        fromAddress: INBOX,
        toAddress: CUSTOMER,
        subject: "Re: Question",
        inReplyTo: "<incoming@example.com>",
      }),
    );
  });

  it("does not leave provider failures in the retry outbox", async () => {
    await seed();
    const { sender } = fakeSender(async () => ({
      id: null,
      error: { message: "temporary", transient: true },
    }));

    await run(sender);

    expect(await getDb().select().from(outboxEmails)).toHaveLength(0);
    const [stored] = await getDb().select().from(sentEmails);
    expect(stored.status).toBe("failed");
  });
});

describe("manual reply threading", () => {
  it("sets References equal to In-Reply-To when the original has a Message-ID", async () => {
    const person = await createTestPerson({
      id: "manual-reply-person",
      email: "manual@example.com",
    });
    await createTestEmail({
      id: "manual-reply-email",
      personId: person.id,
      recipient: INBOX,
      subject: "Manual question",
      messageId: "<manual-original@example.com>",
    });
    const { sender, sent } = fakeSender();

    const result = await replyToEmail({
      db: getDb(),
      env: env as unknown as CloudflareBindings,
      emailId: "manual-reply-email",
      payload: {
        fromAddress: INBOX,
        bodyHtml: "<p>Manual reply</p>",
      },
      files: [],
      allowed: { isAdmin: true, inboxes: [] },
      sender,
    });

    expect(result.ok).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0].headers?.["In-Reply-To"]).toBe(
      "<manual-original@example.com>",
    );
    expect(sent[0].headers?.References).toBe(sent[0].headers?.["In-Reply-To"]);
  });
});
