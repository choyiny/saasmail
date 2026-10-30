// docs/suppressions.md (bounces and complaints): a Cloudflare Email Sending
// event, shaped like the live bounce, through the Worker's own queue entry
// point; correlation by Message-ID only; and the MCP reply refusal.
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
import { eq, sql } from "drizzle-orm";
import worker from "../index";
import {
  applyMigrations,
  authFetch,
  cleanDb,
  createTestEmail,
  createTestPerson,
  createTestSentEmail,
  createTestUser,
  getDb,
} from "./helpers";
import { bouncedEvent } from "./fixtures/cloudflare-events";
import { auditEvents } from "../db/audit-events.schema";
import { deliveryEvents } from "../db/delivery-events.schema";
import { sentEmails } from "../db/sent-emails.schema";
import { suppressions } from "../db/suppressions.schema";
import { recordDeliveryEvent } from "../lib/delivery/record";
import { parseCloudflareEvent } from "../lib/delivery/cloudflare";
import type { DeliveryEvent } from "../lib/delivery/types";
import { handleQueueBatch } from "../lib/queue-router";
import { utcDay } from "../lib/sending-controls";
import { users } from "../db/auth.schema";
import {
  ALL_SCOPES,
  type Credentials,
  callTool,
  createUserWithPassword,
  getAccessToken,
} from "./mcp-helpers";

const INBOX = "support@saasmail.test";
const DEAD = "user@example.net";

function queueMessage(body: unknown, attempts = 1) {
  return {
    id: `m-${Math.random()}`,
    timestamp: new Date(),
    body,
    attempts,
    ack: vi.fn(),
    retry: vi.fn(),
  };
}

function batchOf(message: ReturnType<typeof queueMessage>) {
  return {
    queue: "test",
    messages: [message],
    ackAll: vi.fn(),
    retryAll: vi.fn(),
  } as unknown as MessageBatch<unknown>;
}

async function jmapChangeCount(): Promise<number> {
  const [row] = await getDb().all<{ n: number }>(
    sql`SELECT COUNT(*) AS n FROM jmap_changes`,
  );
  return Number(row.n);
}

beforeAll(applyMigrations);

describe("a live-shaped Cloudflare bounce through the Worker's queue handler", () => {
  const PROBE_ID = "<USqTqpXPXfJyWqfzFvY5FMJqq0maVELIyXPA@snowlan.app>";
  const PROBE_TO = "no-such-mailbox-4f2k@gmail.com";
  const FROM = "hello@snowlan.app";
  let apiKey: string;

  beforeEach(async () => {
    await cleanDb();
    ({ apiKey } = await createTestUser());
    (env as any).DEMO_MODE = "0";
  });

  // The fields the 2026-10-29 probe on a live instance showed: the bracketed
  // id the send binding returned, a numeric SMTP code, no bounce.reason.
  const probeBody = {
    type: "cf.email.sending.message.bounced",
    source: { type: "email.sending", domain: "snowlan.app" },
    payload: {
      eventId: "7c1f9e0a-3b52-4d7e-9a61-2f0c8d4b5e93",
      messageId: PROBE_ID,
      sender: FROM,
      recipient: PROBE_TO,
      subject: "Probe",
      terminal: true,
      delivery: {
        status: "bounced",
        provider: "gmail",
        smtpStatusCode: 550,
        smtpEnhancedStatusCode: "5.1.1",
      },
      bounce: { type: "hard", classification: "permanent_failure" },
    },
    metadata: {
      eventSubscriptionId: "557a431b0000000000000000000000",
      eventSchemaVersion: 1,
      eventTimestamp: "2026-10-29T23:24:16.000Z",
    },
  };

  it("attaches to its message and shows on the timeline, without writing sent_emails or the JMAP change log", async () => {
    await createTestPerson({ id: "p-probe", email: PROBE_TO });
    await createTestSentEmail({
      id: "se-probe",
      personId: "p-probe",
      fromAddress: FROM,
      toAddress: PROBE_TO,
      messageId: PROBE_ID,
    });
    // Positive control: the trigger that turns a sent_emails UPDATE into a
    // JMAP change exists here, so "no new change" below is not vacuous.
    const [trigger] = await getDb().all<{ name: string }>(
      sql`SELECT name FROM sqlite_master WHERE type = 'trigger' AND name = 'jmap_sent_emails_update'`,
    );
    expect(trigger?.name).toBe("jmap_sent_emails_update");

    const sentBefore = await getDb().select().from(sentEmails);
    const changesBefore = await jmapChangeCount();

    const message = queueMessage(probeBody, 1);
    await worker.queue(batchOf(message), env as unknown as CloudflareBindings);

    // Correlated on the first attempt: acked, not delayed.
    expect(message.retry).not.toHaveBeenCalled();
    expect(message.ack).toHaveBeenCalledOnce();
    const [row] = await getDb().select().from(deliveryEvents);
    expect(row).toMatchObject({
      id: "cloudflare:7c1f9e0a-3b52-4d7e-9a61-2f0c8d4b5e93",
      sentEmailId: "se-probe",
      messageId: PROBE_ID,
      recipient: PROBE_TO,
      smtpStatus: "550 5.1.1",
      occurredAt: Math.floor(Date.parse("2026-10-29T23:24:16.000Z") / 1000),
    });
    const [suppression] = await getDb().select().from(suppressions);
    expect(suppression).toMatchObject({
      email: PROBE_TO,
      reason: "hard_bounce",
    });

    // Decision 4: the event lives in delivery_events only.
    expect(await getDb().select().from(sentEmails)).toEqual(sentBefore);
    expect(await jmapChangeCount()).toBe(changesBefore);

    // Audited on the queue channel, without the address.
    const audit = (await getDb().select().from(auditEvents)).filter(
      (e) => e.action === "mail.bounced",
    );
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      channel: "queue",
      targetId: "sent:se-probe",
    });
    expect(JSON.stringify(audit[0])).not.toContain(PROBE_TO);

    // The badge's data on the person timeline.
    const timeline = await (
      await authFetch("/api/emails/by-person/p-probe", { apiKey })
    ).json<any>();
    const sent = timeline.emails.find((e: any) => e.id === "se-probe");
    expect(sent.deliveryProblems).toEqual([
      {
        kind: "bounced",
        bounceType: "hard",
        recipient: PROBE_TO,
        smtpStatus: "550 5.1.1",
        detail: null,
        occurredAt: row.occurredAt,
      },
    ]);
  });
});

describe("correlation is by Message-ID only", () => {
  let apiKey: string;

  beforeEach(async () => {
    await cleanDb();
    ({ apiKey } = await createTestUser());
    (env as any).DEMO_MODE = "0";
  });

  it("two messages to one recipient never take each other's bounce", async () => {
    const now = Math.floor(Date.now() / 1000);
    await createTestPerson({ id: "p-1", email: DEAD });
    await createTestSentEmail({
      id: "se-older",
      personId: "p-1",
      fromAddress: INBOX,
      toAddress: DEAD,
      messageId: "<older-1@saasmail.test>",
      sentAt: now - 120,
    });
    await createTestSentEmail({
      id: "se-newer",
      personId: "p-1",
      fromAddress: INBOX,
      toAddress: DEAD,
      messageId: "<newer-2@saasmail.test>",
      sentAt: now - 60,
    });

    // The older message's bounce, its id without angle brackets.
    const forOlder = queueMessage(
      bouncedEvent({ eventId: "ev-older", messageId: "older-1@saasmail.test" }),
      1,
    );
    await handleQueueBatch(
      batchOf(forOlder),
      env as unknown as CloudflareBindings,
    );
    expect(forOlder.ack).toHaveBeenCalledOnce();

    // A bounce for the same recipient naming a message this server never
    // sent: recorded on its second attempt, attached to neither message.
    const forUnknown = queueMessage(
      bouncedEvent({
        eventId: "ev-unknown",
        messageId: "<elsewhere@saasmail.test>",
      }),
      2,
    );
    await handleQueueBatch(
      batchOf(forUnknown),
      env as unknown as CloudflareBindings,
    );
    expect(forUnknown.ack).toHaveBeenCalledOnce();

    const rows = await getDb()
      .select({
        id: deliveryEvents.id,
        sentEmailId: deliveryEvents.sentEmailId,
        messageId: deliveryEvents.messageId,
      })
      .from(deliveryEvents)
      .orderBy(deliveryEvents.id);
    expect(rows).toEqual([
      {
        id: "cloudflare:ev-older",
        sentEmailId: "se-older",
        messageId: "<older-1@saasmail.test>",
      },
      {
        id: "cloudflare:ev-unknown",
        sentEmailId: null,
        messageId: "<elsewhere@saasmail.test>",
      },
    ]);

    const timeline = await (
      await authFetch("/api/emails/by-person/p-1", { apiKey })
    ).json<any>();
    const byId = (id: string) => timeline.emails.find((e: any) => e.id === id);
    expect(byId("se-older").deliveryProblems).toHaveLength(1);
    expect(byId("se-newer").deliveryProblems).toEqual([]);
  });
});

describe("the MCP reply_email refusal", () => {
  const ADMIN: Credentials = {
    name: "Owner",
    email: "owner@saasmail.test",
    password: "correct-horse-battery",
  };
  let token: string;
  let userId: string;

  beforeEach(async () => {
    await cleanDb();
    await createUserWithPassword(ADMIN, "admin");
    const [row] = await getDb()
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, ADMIN.email));
    userId = row.id;
    token = await getAccessToken(ADMIN, ALL_SCOPES);
    // No provider call: a reply is recorded as sent.
    (env as any).DEMO_MODE = "1";
  });

  afterEach(() => {
    (env as any).DEMO_MODE = "0";
  });

  it("is a tool error naming the address and the fix; nothing is stored and the daily slot comes back", async () => {
    await createTestPerson({ id: "p-dead", email: DEAD });
    await createTestEmail({
      id: "rcv-dead",
      personId: "p-dead",
      recipient: INBOX,
      messageId: "<rcv-dead@example.net>",
    });
    await createTestPerson({ id: "p-ok", email: "fine@example.com" });
    await createTestEmail({
      id: "rcv-ok",
      personId: "p-ok",
      recipient: INBOX,
      messageId: "<rcv-ok@example.com>",
    });
    await recordDeliveryEvent(
      getDb(),
      parseCloudflareEvent(bouncedEvent()) as DeliveryEvent,
    );
    // One MCP send left today.
    const today = utcDay(Math.floor(Date.now() / 1000));
    await getDb().run(
      sql`INSERT INTO send_counters (user_id, channel, day, count) VALUES (${userId}, 'mcp', ${today}, 199)`,
    );
    const args = (emailId: string) => ({
      emailId,
      fromAddress: INBOX,
      bodyHtml: "<p>Thanks</p>",
    });

    const refused = await callTool(token, "reply_email", args("rcv-dead"));
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain(DEAD);
    expect(refused.text).toContain("Suppressions page");
    expect(await getDb().select().from(sentEmails)).toEqual([]);

    // The refusal took no slot: the last one still sends, and then the cap holds.
    const sent = await callTool(token, "reply_email", args("rcv-ok"));
    expect(sent.isError).toBe(false);
    const over = await callTool(token, "reply_email", args("rcv-ok"));
    expect(over.text).toContain("DAILY_SEND_LIMIT_REACHED");
    expect(await getDb().select().from(sentEmails)).toHaveLength(1);
  });
});
