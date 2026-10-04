// docs/specs/SPEC-audit-log.md §3: events for sends and hard deletes, and
// the actor each channel is recorded as.
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { asc } from "drizzle-orm";
import { auditEvents } from "../db/audit-events.schema";
import { blocklist } from "../db/blocklist.schema";
import { outboxEmails } from "../db/outbox-emails.schema";
import { rules } from "../db/rules.schema";
import { senderIdentities } from "../db/sender-identities.schema";
import type {
  EmailSender,
  SendEmailParams,
  SendEmailResult,
} from "../lib/email-sender";
import { evaluateRules } from "../lib/rules/evaluate";
import { sendEmail } from "../lib/send-email";
import {
  applyMigrations,
  authFetch,
  buildSendForm,
  cleanDb,
  createTestEmail,
  createTestPerson,
  createTestSentEmail,
  createTestTemplate,
  createTestUser,
  getDb,
} from "./helpers";
import { CORE_CAPABILITY, MAIL_CAPABILITY } from "../jmap/constants";
import { acct, rid, sys } from "./jmap-ids";

const INBOX = "support@saasmail.test";
const CUSTOMER = "alice@example.com";

async function events(action?: string) {
  const rows = await getDb()
    .select()
    .from(auditEvents)
    .orderBy(asc(auditEvents.action), asc(auditEvents.inbox));
  return rows
    .filter((row) => !action || row.action === action)
    .map((row) => ({
      ...row,
      details: row.details ? JSON.parse(row.details) : null,
    }));
}

function senderReturning(result: SendEmailResult): EmailSender {
  return {
    provider: "demo" as const,
    async send(_params: SendEmailParams) {
      return result;
    },
    maxAttachmentBytes: () => 25 * 1024 * 1024,
    maxMessageBytes: () => 25 * 1024 * 1024,
  };
}

describe("audit events for sends and deletes", () => {
  let userId: string;
  let apiKey: string;

  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDb();
    ({ userId, apiKey } = await createTestUser());
    (env as any).DEMO_MODE = "1";
    const now = Math.floor(Date.now() / 1000);
    await getDb()
      .insert(senderIdentities)
      .values({ email: INBOX, createdAt: now, updatedAt: now });
    await createTestPerson({ id: "p1", email: CUSTOMER });
    await createTestEmail({
      id: "e1",
      personId: "p1",
      recipient: INBOX,
      subject: "Invoice question",
      messageId: "<e1@example.com>",
    });
  });

  afterEach(() => {
    (env as any).DEMO_MODE = "0";
  });

  it("records a composed send with who sent it and where", async () => {
    const res = await authFetch("/api/send", {
      apiKey,
      method: "POST",
      body: buildSendForm({
        to: CUSTOMER,
        fromAddress: INBOX,
        subject: "Welcome",
        bodyHtml: "<p>hi</p>",
        transactional: true,
      }),
    });
    expect(res.status).toBe(201);
    const { id } = (await res.json()) as { id: string };

    const [row] = await events("mail.sent");
    expect(row).toMatchObject({
      actorType: "api_key",
      actorUserId: userId,
      channel: "api",
      targetType: "message",
      targetId: `sent:${id}`,
      inbox: INBOX,
      summary: `Sent 'Welcome' to ${CUSTOMER} from ${INBOX}`,
    });
    expect(row.details).toMatchObject({
      sentEmailId: id,
      to: CUSTOMER,
      status: "sent",
    });
  });

  it("records a reply with the address it followed", async () => {
    const res = await authFetch("/api/send/reply/e1", {
      apiKey,
      method: "POST",
      body: buildSendForm({ fromAddress: INBOX, bodyHtml: "<p>thanks</p>" }),
    });
    expect(res.status).toBe(201);

    const [row] = await events("mail.sent");
    expect(row.summary).toBe(
      `Sent 'Re: Invoice question' to ${CUSTOMER} from ${INBOX}`,
    );
    expect(row.details.repliedTo).toBe("sender");
  });

  it("records a template send with its slug", async () => {
    await createTestTemplate({
      slug: "welcome",
      subject: "Hello there",
      bodyHtml: "<p>Welcome aboard</p>",
    });
    const res = await authFetch("/api/email-templates/welcome/send", {
      apiKey,
      method: "POST",
      body: JSON.stringify({ to: CUSTOMER, fromAddress: INBOX }),
    });
    expect(res.status, await res.clone().text()).toBeLessThan(300);

    const [row] = await events("mail.sent");
    expect(row.details.templateSlug).toBe("welcome");
    expect(row.inbox).toBe(INBOX);
  });

  it("records nothing for a send the provider refused", async () => {
    await sendEmail({
      db: getDb(),
      env: env as unknown as CloudflareBindings,
      payload: {
        to: CUSTOMER,
        fromAddress: INBOX,
        subject: "Nope",
        bodyHtml: "<p>hi</p>",
        transactional: true,
      },
      files: [],
      allowed: { isAdmin: true },
      sender: senderReturning({
        id: null,
        error: { message: "rejected", transient: false },
      }),
    });
    expect(await events("mail.sent")).toEqual([]);
  });

  it("records a rule's auto-reply as the rule, and not its archive", async () => {
    const now = Math.floor(Date.now() / 1000);
    await getDb()
      .insert(rules)
      .values({
        id: "rule-1",
        name: "Out of office",
        inbox: INBOX,
        trigger: "message.received",
        conditions: [],
        actions: [
          { type: "auto_reply", bodyText: "We are away" },
          { type: "archive" },
        ],
        position: 0,
        stopProcessing: 0,
        enabled: 1,
        matchCount: 0,
        createdAt: now,
        updatedAt: now,
      });

    const pending: Promise<unknown>[] = [];
    await evaluateRules(
      getDb(),
      {
        emailId: "e1",
        inbox: INBOX,
        fromAddress: CUSTOMER,
        subject: "Invoice question",
        bodyText: "Hello",
        bodyHtml: null,
        hasAttachments: false,
        spamScore: null,
        headers: {},
        now,
      },
      {
        env: env as unknown as CloudflareBindings,
        ctx: {
          waitUntil: (p: Promise<unknown>) => void pending.push(p),
          passThroughOnException() {},
        } as unknown as ExecutionContext,
      },
    );
    await Promise.allSettled(pending);

    // The auto-reply is a send and is recorded; the archive is routine.
    const rows = await events();
    expect(rows.map((row) => row.action)).toEqual(["mail.sent"]);
    expect(rows[0]).toMatchObject({
      actorType: "rule",
      actorUserId: null,
      actorLabel: "rule Out of office",
      channel: "rule",
      inbox: INBOX,
    });
  });

  it("records a deleted message by its subject", async () => {
    const res = await authFetch("/api/emails/e1", { apiKey, method: "DELETE" });
    expect(res.status).toBe(200);

    const [row] = await events("mail.deleted");
    expect(row).toMatchObject({
      actorType: "api_key",
      targetId: "received:e1",
      inbox: INBOX,
      summary: `Deleted 'Invoice question' from ${INBOX}`,
    });
  });

  it("records a deleted person and their mail as one event", async () => {
    await createTestSentEmail({
      id: "s1",
      personId: "p1",
      fromAddress: INBOX,
      toAddress: CUSTOMER,
    });
    const res = await authFetch("/api/people/p1", { apiKey, method: "DELETE" });
    expect(res.status).toBe(200);

    // One row for the inbox the mail was in, so that inbox's log shows it.
    const rows = await events("mail.deleted");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      inbox: INBOX,
      targetId: null,
      summary: `Deleted 2 messages from ${INBOX}, with the contact ${CUSTOMER}`,
    });
    expect(rows[0].details).toMatchObject({
      person: CUSTOMER,
      count: 2,
      refs: ["received:e1", "sent:s1"],
    });
  });

  it("records a rule's junk mark as the rule, through the rules engine", async () => {
    const now = Math.floor(Date.now() / 1000);
    await getDb()
      .insert(rules)
      .values({
        id: "rule-2",
        name: "Block vendors",
        inbox: INBOX,
        trigger: "message.received",
        conditions: [],
        actions: [{ type: "mark_spam" }],
        position: 0,
        stopProcessing: 0,
        enabled: 1,
        matchCount: 0,
        createdAt: now,
        updatedAt: now,
      });
    await evaluateRules(getDb(), {
      emailId: "e1",
      inbox: INBOX,
      fromAddress: CUSTOMER,
      subject: "Invoice question",
      bodyText: "Hello",
      bodyHtml: null,
      hasAttachments: false,
      spamScore: null,
      headers: {},
      now,
    });

    const rows = await events();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: "mail.spam",
      actorType: "rule",
      actorLabel: "rule Block vendors",
      channel: "rule",
      targetId: "received:e1",
    });
  });

  it("records mail that went out on a manual retry of a failed send", async () => {
    await createTestSentEmail({
      id: "s-failed",
      personId: "p1",
      fromAddress: INBOX,
      toAddress: CUSTOMER,
      subject: "Second try",
      status: "failed",
    });
    const now = Math.floor(Date.now() / 1000);
    await getDb().insert(outboxEmails).values({
      id: "ob-1",
      sentEmailId: "s-failed",
      fromAddress: INBOX,
      toAddress: CUSTOMER,
      subject: "Second try",
      bodyHtml: "<p>hi</p>",
      bodyText: "hi",
      transactional: 1,
      status: "failed",
      attempts: 5,
      lastError: "provider said no",
      nextRetryAt: null,
      createdAt: now,
      updatedAt: now,
    });

    const res = await authFetch("/api/outbox/ob-1/retry", {
      apiKey,
      method: "POST",
    });
    expect(res.status, await res.clone().text()).toBe(200);
    expect(((await res.json()) as { outcome: string }).outcome).toBe("sent");

    const [row] = await events("mail.sent");
    expect(row).toMatchObject({
      actorType: "api_key",
      targetId: "sent:s-failed",
      inbox: INBOX,
      summary: `Retried and sent 'Second try' to ${CUSTOMER} from ${INBOX}`,
    });
    expect(row.details.retried).toBe(true);
  });

  it("records a purge of blocked mail as one row per inbox", async () => {
    await createTestEmail({
      id: "e2",
      personId: "p1",
      recipient: INBOX,
      messageId: "<e2@example.com>",
    });
    await getDb()
      .insert(blocklist)
      .values({
        id: "b1",
        type: "email",
        value: CUSTOMER,
        createdAt: Math.floor(Date.now() / 1000),
      });
    const res = await authFetch("/api/blocklist/mail", {
      apiKey,
      method: "DELETE",
    });
    expect(res.status, await res.clone().text()).toBe(200);

    const rows = await events("mail.deleted");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      inbox: INBOX,
      targetId: null,
      summary: `Deleted 2 messages from ${INBOX}`,
    });
  });

  it("records a JMAP Email/set as the JMAP client, one row for the request", async () => {
    await createTestEmail({
      id: "e2",
      personId: "p1",
      recipient: INBOX,
      messageId: "<e2@example.com>",
    });
    const res = await authFetch("/jmap/api", {
      apiKey,
      method: "POST",
      body: JSON.stringify({
        using: [CORE_CAPABILITY, MAIL_CAPABILITY],
        methodCalls: [
          [
            "Email/set",
            {
              accountId: acct(userId),
              update: {
                [rid("e1")]: { mailboxIds: { [sys(INBOX, "archive")]: true } },
                [rid("e2")]: { mailboxIds: { [sys(INBOX, "archive")]: true } },
              },
            },
            "s",
          ],
        ],
      }),
    });
    expect(res.status).toBe(200);

    const rows = await events("mail.archived");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actorType: "jmap",
      actorUserId: userId,
      channel: "jmap",
      inbox: INBOX,
      summary: `Archived 2 messages in ${INBOX}`,
    });
    expect(rows[0].actorLabel).toMatch(/^JMAP \(sk_/);
  });
});
