import { afterEach, describe, it, expect, beforeAll, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import {
  applyMigrations,
  cleanDb,
  createTestSentEmail,
  getDb,
} from "./helpers";
import {
  captureQueue,
  configureWebhook,
  deliveryRows,
} from "./webhook-fixtures";
import { sweepWebhookDeliveries } from "../lib/webhook-delivery";
import { outboxEmails } from "../db/outbox-emails.schema";
import { env } from "cloudflare:workers";
import { attemptOutboxRow, sendViaOutbox } from "../lib/outbox";
import type {
  EmailSender,
  SendEmailParams,
  SendEmailResult,
} from "../lib/email-sender";
import { suppressions } from "../db/suppressions.schema";

describe("outbox_emails table", () => {
  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDb();
  });

  it("round-trips an outbox row", async () => {
    const db = getDb();
    const now = Math.floor(Date.now() / 1000);
    await db.insert(outboxEmails).values({
      id: "ob-1",
      sentEmailId: "se-1",
      fromAddress: "me@saasmail.test",
      toAddress: "to@example.com",
      subject: "Hi",
      bodyHtml: "<p>Hi</p>",
      transactional: 0,
      status: "pending",
      attempts: 1,
      lastError: "quota exceeded",
      nextRetryAt: now,
      createdAt: now,
      updatedAt: now,
    });
    const rows = await db
      .select()
      .from(outboxEmails)
      .where(eq(outboxEmails.id, "ob-1"));
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("pending");
    expect(rows[0].sequenceEmailId).toBeNull();
  });
});

/** Fake sender whose result is scripted per call. */
function fakeSender(results: SendEmailResult[]): EmailSender & {
  calls: SendEmailParams[];
} {
  const calls: SendEmailParams[] = [];
  return {
    provider: "none" as const,
    calls,
    async send(params: SendEmailParams) {
      calls.push(params);
      return results[Math.min(calls.length - 1, results.length - 1)];
    },
    maxAttachmentBytes: () => 25 * 1024 * 1024,
    maxMessageBytes: () => 25 * 1024 * 1024,
  };
}

const OK: SendEmailResult = { id: "prov-1", error: null };
const TRANSIENT: SendEmailResult = {
  id: null,
  error: { message: "quota exceeded", transient: true },
};
const PERMANENT: SendEmailResult = {
  id: null,
  error: { message: "invalid recipient", transient: false },
};

describe("sendViaOutbox", () => {
  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDb();
  });

  function baseParams(sender: EmailSender) {
    return {
      db: getDb(),
      env: env as unknown as CloudflareBindings,
      sender,
      sentEmailId: "se-1",
      fromAddress: "me@saasmail.test",
      from: "Me <me@saasmail.test>",
      to: "to@example.com",
      subject: "Hi",
      html: "<p>Hi</p>",
      headers: { "Message-ID": "<mid-1@saasmail.test>" },
      transactional: true,
    };
  }

  it("deletes the outbox row on success", async () => {
    const sender = fakeSender([OK]);
    const result = await sendViaOutbox(baseParams(sender));
    expect(result.outcome).toBe("sent");
    expect(result.send.result?.id).toBe("prov-1");
    const rows = await getDb().select().from(outboxEmails);
    expect(rows).toHaveLength(0);
  });

  it("keeps a pending row with attempts=1 on transient failure", async () => {
    const sender = fakeSender([TRANSIENT]);
    const result = await sendViaOutbox(baseParams(sender));
    expect(result.outcome).toBe("retrying");
    const rows = await getDb().select().from(outboxEmails);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("pending");
    expect(rows[0].attempts).toBe(1);
    expect(rows[0].lastError).toBe("quota exceeded");
    expect(rows[0].sentEmailId).toBe("se-1");
    expect(rows[0].nextRetryAt).toBeGreaterThan(Math.floor(Date.now() / 1000));
    expect(rows[0].nextRetryAt).toBeLessThanOrEqual(
      Math.floor(Date.now() / 1000) + 60,
    );
    expect(JSON.parse(rows[0].headers!)["Message-ID"]).toBe(
      "<mid-1@saasmail.test>",
    );
  });

  it("marks the row failed on permanent failure", async () => {
    const sender = fakeSender([PERMANENT]);
    const result = await sendViaOutbox(baseParams(sender));
    expect(result.outcome).toBe("failed");
    const rows = await getDb().select().from(outboxEmails);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("failed");
    expect(rows[0].attempts).toBe(1);
  });

  it("deletes the write-ahead row and rethrows when the send helper throws", async () => {
    const throwingSender: EmailSender = {
      provider: "none",
      async send() {
        throw new Error("unexpected transport crash");
      },
      maxAttachmentBytes: () => 25 * 1024 * 1024,
      maxMessageBytes: () => 25 * 1024 * 1024,
    };
    await expect(sendViaOutbox(baseParams(throwingSender))).rejects.toThrow(
      "unexpected transport crash",
    );
    const rows = await getDb().select().from(outboxEmails);
    expect(rows).toHaveLength(0);
  });

  it("keeps the write-ahead row unclaimable while the inline attempt is in flight", async () => {
    let observedNextRetryAt: number | null | undefined;
    const observingSender: EmailSender = {
      provider: "none",
      async send() {
        const rows = await getDb().select().from(outboxEmails);
        observedNextRetryAt = rows[0]?.nextRetryAt;
        return { id: "prov-1", error: null };
      },
      maxAttachmentBytes: () => 25 * 1024 * 1024,
      maxMessageBytes: () => 25 * 1024 * 1024,
    };
    await sendViaOutbox(baseParams(observingSender));
    expect(observedNextRetryAt).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  it("sends To with its display name but stores the bare address", async () => {
    const sender = fakeSender([TRANSIENT]);
    await sendViaOutbox({
      ...baseParams(sender),
      to: "john@example.com",
      toName: "Doe, John",
    });
    expect(sender.calls[0].to).toBe('"Doe, John" <john@example.com>');
    const [row] = await getDb().select().from(outboxEmails);
    expect(row.toAddress).toBe("john@example.com");
  });

  it("deletes the row when every recipient is suppressed", async () => {
    const db = getDb();
    const now = Math.floor(Date.now() / 1000);
    await db.insert(suppressions).values({
      id: "sup-1",
      email: "to@example.com",
      reason: "unsubscribed",
      createdAt: now,
    });
    const sender = fakeSender([OK]);
    const result = await sendViaOutbox({
      ...baseParams(sender),
      transactional: false, // suppression only applies to marketing sends
    });
    expect(result.outcome).toBe("suppressed");
    expect(sender.calls).toHaveLength(0);
    const rows = await db.select().from(outboxEmails);
    expect(rows).toHaveLength(0);
  });
});

// docs/webhooks.md: send events, recorded after the send's own bookkeeping.
describe("delivery webhooks from the outbox", () => {
  let queue: ReturnType<typeof captureQueue>;

  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDb();
    (env as any).DEMO_MODE = "0";
    queue = captureQueue();
  });

  afterEach(() => queue.restore());

  function params(sender: EmailSender) {
    return {
      db: getDb(),
      env: env as unknown as CloudflareBindings,
      sender,
      sentEmailId: "se-1",
      fromAddress: "me@saasmail.test",
      from: "Me <me@saasmail.test>",
      to: "to@example.com",
      additionalTo: [{ email: "to2@example.com" }],
      cc: [{ email: "cc@example.com" }],
      bcc: [{ email: "secret-bcc@example.com" }],
      subject: "Hi",
      html: "<p>Hi</p>",
      headers: { "Message-ID": "<mid-1@saasmail.test>" },
      transactional: true,
    };
  }

  const payloads = async () =>
    (await deliveryRows()).map((row) => ({
      row,
      payload: JSON.parse(row.payload!),
    }));

  it("records one message.sent with the sent id and no Bcc address, also for a JMAP submission", async () => {
    await configureWebhook(["message.sent"]);
    const result = await sendViaOutbox({
      ...params(fakeSender([OK])),
      bookkeepingOwner: "jmap",
    });
    expect(result.outcome).toBe("sent");
    const [{ row, payload }] = await payloads();
    expect(row).toMatchObject({
      sourceKey: "sent:se-1:message.sent",
      messageId: "se-1",
      status: "pending",
    });
    expect(payload.message).toMatchObject({
      id: "se-1",
      messageId: "<mid-1@saasmail.test>",
      from: "me@saasmail.test",
      recipients: ["to@example.com", "to2@example.com", "cc@example.com"],
    });
    expect(row.payload).not.toContain("secret-bcc");
    expect(queue.sent).toEqual([
      { type: "webhook_delivery", deliveryId: row.id },
    ]);
  });

  it("records nothing when the event is not wanted", async () => {
    await configureWebhook(["message.received"]);
    await sendViaOutbox(params(fakeSender([OK])));
    expect(await deliveryRows()).toEqual([]);
    expect(queue.sent).toEqual([]);
  });

  it("records message.failed for a permanent first-attempt failure", async () => {
    await configureWebhook(["message.failed"]);
    await sendViaOutbox(params(fakeSender([PERMANENT])));
    const [{ row, payload }] = await payloads();
    expect(row.event).toBe("message.failed");
    expect(payload.delivery).toMatchObject({
      status: "failed",
      reason: "invalid recipient",
      recipient: null,
    });
  });

  it("keeps the send's result and bookkeeping when queueing throws, and the sweep resends the pointer", async () => {
    queue.restore();
    queue = captureQueue({ fail: true });
    await configureWebhook(["message.sent"]);
    const result = await sendViaOutbox(params(fakeSender([OK])));
    expect(result.outcome).toBe("sent");
    expect(result.send.result?.id).toBe("prov-1");
    expect(await getDb().select().from(outboxEmails)).toHaveLength(0);
    const [row] = await deliveryRows();
    expect(row.status).toBe("pending");

    queue.restore();
    queue = captureQueue();
    await sweepWebhookDeliveries(
      env as unknown as CloudflareBindings,
      getDb(),
      Math.floor(Date.now() / 1000) + 2 * 3600,
    );
    expect(queue.sent).toEqual([
      { type: "webhook_delivery", deliveryId: row.id },
    ]);
  });

  async function pendingRetryRow() {
    const now = Math.floor(Date.now() / 1000);
    await createTestSentEmail({
      id: "se-1",
      fromAddress: "me@saasmail.test",
      toAddress: "to@example.com",
      status: "retrying",
    });
    await getDb()
      .insert(outboxEmails)
      .values({
        id: "ob-1",
        sentEmailId: "se-1",
        fromAddress: "me@saasmail.test",
        toAddress: "to@example.com",
        cc: JSON.stringify([{ email: "cc@example.com" }]),
        bcc: JSON.stringify([{ email: "secret-bcc@example.com" }]),
        subject: "Hi",
        bodyHtml: "<p>Hi</p>",
        headers: JSON.stringify({ "Message-ID": "<mid-1@saasmail.test>" }),
        transactional: 1,
        status: "pending",
        attempts: 1,
        nextRetryAt: now,
        createdAt: now,
        updatedAt: now,
      });
  }

  it("records message.sent after a successful retry, without the Bcc", async () => {
    await configureWebhook(["message.sent"]);
    await pendingRetryRow();
    const outcome = await attemptOutboxRow(
      getDb(),
      env as unknown as CloudflareBindings,
      fakeSender([OK]),
      "ob-1",
    );
    expect(outcome).toBe("sent");
    const [{ payload, row }] = await payloads();
    expect(payload.message.recipients).toEqual([
      "to@example.com",
      "cc@example.com",
    ]);
    expect(row.payload).not.toContain("secret-bcc");
  });

  it("records message.failed with reason suppressed when a retry is stopped by suppression", async () => {
    await configureWebhook(["message.failed"]);
    await pendingRetryRow();
    await getDb()
      .insert(suppressions)
      .values({
        id: "sup-1",
        email: "to@example.com",
        reason: "hard_bounce",
        createdAt: Math.floor(Date.now() / 1000),
      });
    const outcome = await attemptOutboxRow(
      getDb(),
      env as unknown as CloudflareBindings,
      fakeSender([OK]),
      "ob-1",
    );
    expect(outcome).toBe("suppressed");
    const [{ row, payload }] = await payloads();
    expect(row.sourceKey).toBe("sent:se-1:message.failed");
    expect(payload.delivery).toMatchObject({
      status: "failed",
      reason: "suppressed",
    });
  });
});
