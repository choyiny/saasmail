// docs/webhooks.md (Delivery events): the consumer, the sweep and demo mode
// together, through the real entry points rather than seeded rows.
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
  cleanDb,
  createTestSentEmail,
  getDb,
} from "./helpers";
import {
  captureQueue,
  configureWebhook,
  deliveryRows,
  queueMessage,
  scriptedFetch,
} from "./webhook-fixtures";
import { auditEvents } from "../db/audit-events.schema";
import { webhookDeliveries } from "../db/webhook-deliveries.schema";
import { sql } from "drizzle-orm";
import { getWebhookConfig, recordFailure } from "../lib/webhook-config";
import {
  buildWebhookPayload,
  deliverWebhook,
  recordSendWebhook,
  runWebhookDelivery,
  sweepWebhookDeliveries,
} from "../lib/webhook-delivery";

const bindings = env as unknown as CloudflareBindings;

/** A send's event, after its sent row is written (as the senders do). */
async function recordSent(
  id: string,
  event: "message.sent" | "message.failed" = "message.sent",
) {
  await createTestSentEmail({
    id,
    fromAddress: "support@saasmail.test",
    toAddress: "customer@example.com",
    subject: "Your invoice",
  });
  return recordSendWebhook(bindings, getDb(), {
    event,
    sentEmailId: id,
    from: "support@saasmail.test",
    to: "customer@example.com",
    subject: "Your invoice",
    ...(event === "message.failed" ? { reason: "rejected" } : {}),
  });
}

function pointerOf(body: unknown) {
  return body as { type: "webhook_delivery"; deliveryId: string };
}

describe("outbound delivery edges", () => {
  let queue: ReturnType<typeof captureQueue>;

  beforeAll(applyMigrations);
  beforeEach(async () => {
    await cleanDb();
    (env as any).DEMO_MODE = "0";
    queue = captureQueue();
  });
  afterEach(() => {
    (env as any).DEMO_MODE = "0";
    queue.restore();
    vi.unstubAllGlobals();
  });

  it("pauses after 20 deliveries the consumer failed, once, cancels the next pending one, records no more, and still sends message.received", async () => {
    await configureWebhook(["message.received", "message.sent"]);
    for (let i = 1; i <= 21; i += 1) await recordSent(`se-${i}`);
    expect(queue.sent).toHaveLength(21);
    const pointers = queue.sent.map(pointerOf);
    const fetchImpl = scriptedFetch([404]);

    for (let i = 0; i < 20; i += 1) {
      const msg = queueMessage(pointers[i]);
      await runWebhookDelivery(getDb(), bindings, msg, { fetchImpl });
      expect(msg.ack).toHaveBeenCalledOnce();
      const cfg = await getWebhookConfig(getDb());
      // Paused by the 20th final failure, not before.
      expect(cfg?.disabledAt === null).toBe(i < 19);
    }
    expect(fetchImpl).toHaveBeenCalledTimes(20);
    const cfg = await getWebhookConfig(getDb());
    expect(cfg?.disabledReason).toContain("HTTP 404");
    const pauses = (await getDb().select().from(auditEvents)).filter(
      (e) => e.action === "webhook.auto_disabled",
    );
    expect(pauses).toHaveLength(1);

    // The 21st, recorded before the pause, is cancelled without a POST.
    const last = queueMessage(pointers[20]);
    await runWebhookDelivery(getDb(), bindings, last, { fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(20);
    expect(last.ack).toHaveBeenCalledOnce();
    const rows = await deliveryRows();
    expect(rows.find((r) => r.id === pointers[20].deliveryId)?.status).toBe(
      "cancelled",
    );
    expect(rows.filter((r) => r.status === "failed")).toHaveLength(20);

    // While paused, a send records nothing and queues nothing...
    queue.sent.length = 0;
    await recordSent("se-22");
    expect(queue.sent).toEqual([]);
    expect(await deliveryRows()).toHaveLength(21);

    // ...and message.received keeps its single inline attempt.
    const inbound = scriptedFetch([200]);
    vi.stubGlobal("fetch", inbound);
    const waits: Promise<unknown>[] = [];
    deliverWebhook(
      getDb(),
      {
        waitUntil: (p: Promise<unknown>) => waits.push(p),
      } as unknown as ExecutionContext,
      buildWebhookPayload({
        emailId: "e-1",
        receivedAt: 1717459200,
        inbox: "support@saasmail.test",
        fromAddress: "jane@example.com",
        fromName: null,
        subject: "Hi",
        bodyText: "hello",
        conversationId: "conv1",
        attachments: [],
        auth: { spf: null, dkim: null, dmarc: null },
        baseUrl: "https://mail.d.com",
      }),
    );
    await Promise.all(waits);
    expect(inbound).toHaveBeenCalledOnce();
  });

  it("pauses after 20 failures in a row even when the earlier ones were pruned from the log", async () => {
    await configureWebhook(["message.sent"]);
    for (let i = 1; i <= 20; i += 1) await recordSent(`se-${i}`);
    const pointers = queue.sent.map(pointerOf);
    const fetchImpl = scriptedFetch([404]);
    for (let i = 0; i < 19; i += 1) {
      await runWebhookDelivery(getDb(), bindings, queueMessage(pointers[i]), {
        fetchImpl,
      });
    }
    expect((await getWebhookConfig(getDb()))?.disabledAt).toBeNull();

    // Eight days on, the sweep prunes the 19 finished rows...
    const later = Math.floor(Date.now() / 1000) + 8 * 24 * 3600;
    expect(
      (await sweepWebhookDeliveries(bindings, getDb(), later)).pruned,
    ).toBe(19);

    // ...and the 20th failure in a row still pauses.
    await runWebhookDelivery(getDb(), bindings, queueMessage(pointers[19]), {
      fetchImpl,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(20);
    expect((await getWebhookConfig(getDb()))?.disabledAt).not.toBeNull();
  });

  async function failStreak(): Promise<number> {
    const [row] = await getDb().all<{ streak: number }>(
      sql`SELECT json_extract(value, '$.failStreak') AS streak FROM app_settings WHERE key = 'webhook'`,
    );
    return row.streak;
  }

  it("never leaves a final failure uncounted when the streak update fails", async () => {
    await configureWebhook(["message.sent"]);
    await recordSent("se-1");
    const pointer = pointerOf(queue.sent[0]);
    const fetchImpl = scriptedFetch([404]);
    // Every write to the config fails, as a D1 error after the row update would.
    await getDb().run(
      sql`CREATE TRIGGER fail_webhook_setting BEFORE UPDATE ON app_settings WHEN NEW.key = 'webhook' BEGIN SELECT RAISE(ABORT, 'boom'); END`,
    );
    try {
      await runWebhookDelivery(getDb(), bindings, queueMessage(pointer, 1), {
        fetchImpl,
      });
    } finally {
      await getDb().run(sql`DROP TRIGGER IF EXISTS fail_webhook_setting`);
    }
    // The failure and its count commit together or not at all.
    let [row] = await deliveryRows();
    expect(row.status).toBe("pending");
    expect(await failStreak()).toBe(0);

    await runWebhookDelivery(getDb(), bindings, queueMessage(pointer, 2), {
      fetchImpl,
    });
    [row] = await deliveryRows();
    expect(row.status).toBe("failed");
    expect(await failStreak()).toBe(1);
  });

  it("keeps the run of failures when a success finishes after a racing failure paused", async () => {
    await configureWebhook(["message.sent"]);
    const { generation } = (await getWebhookConfig(getDb()))!;
    for (let i = 0; i < 19; i += 1) {
      await recordFailure(getDb(), generation, { status: 500, error: null });
    }
    await recordSent("se-1");
    // While this POST is in flight, another delivery's 20th failure pauses.
    const fetchImpl = vi.fn(async () => {
      await recordFailure(getDb(), generation, { status: 500, error: null });
      return new Response(null, { status: 200 });
    }) as unknown as typeof fetch;
    await runWebhookDelivery(
      getDb(),
      bindings,
      queueMessage(pointerOf(queue.sent[0])),
      { fetchImpl },
    );
    const [row] = await deliveryRows();
    expect(row.status).toBe("delivered");
    const cfg = await getWebhookConfig(getDb());
    expect(cfg?.disabledAt).not.toBeNull();
    expect(await failStreak()).toBe(20);
  });

  it("keeps the 4-attempt cap when the sweep resends a pointer lost after two retried attempts (408, 429)", async () => {
    await configureWebhook(["message.sent"]);
    await recordSent("se-1");
    const { deliveryId } = pointerOf(queue.sent[0]);
    const fetchImpl = scriptedFetch([408, 429, 503]);

    const first = queueMessage({ type: "webhook_delivery", deliveryId }, 1);
    await runWebhookDelivery(getDb(), bindings, first, { fetchImpl });
    expect(first.retry).toHaveBeenCalledWith({ delaySeconds: 60 });
    const second = queueMessage({ type: "webhook_delivery", deliveryId }, 2);
    await runWebhookDelivery(getDb(), bindings, second, { fetchImpl });
    expect(second.retry).toHaveBeenCalledWith({ delaySeconds: 300 });
    let [row] = await deliveryRows();
    expect(row).toMatchObject({
      status: "pending",
      attempts: 2,
      lastStatus: 429,
    });

    // The queue loses the third message; the sweep finds the row overdue.
    queue.sent.length = 0;
    const later = row.nextAttemptAt + 3600 + 1;
    expect(
      await sweepWebhookDeliveries(bindings, getDb(), later),
    ).toMatchObject({ resent: 1, failed: 0 });
    expect(queue.sent).toEqual([{ type: "webhook_delivery", deliveryId }]);

    // The resent message starts at msg.attempts = 1, but it is the 3rd attempt.
    const resent = queueMessage({ type: "webhook_delivery", deliveryId }, 1);
    await runWebhookDelivery(getDb(), bindings, resent, { fetchImpl });
    expect(resent.retry).toHaveBeenCalledWith({ delaySeconds: 1800 });
    // Its redelivery is the 4th and last: failed and acked, never retried.
    const fourth = queueMessage({ type: "webhook_delivery", deliveryId }, 2);
    await runWebhookDelivery(getDb(), bindings, fourth, { fetchImpl });
    expect(fourth.retry).not.toHaveBeenCalled();
    expect(fourth.ack).toHaveBeenCalledOnce();

    expect(fetchImpl).toHaveBeenCalledTimes(4);
    [row] = await deliveryRows();
    expect(row).toMatchObject({
      status: "failed",
      attempts: 4,
      lastStatus: 503,
      payload: null,
    });
  });

  it("in demo mode records and queues nothing, and the sweep resends nothing", async () => {
    await configureWebhook([
      "message.received",
      "message.sent",
      "message.failed",
    ]);
    // A pending row left from before demo mode was turned on, long overdue.
    await recordSent("se-old");
    expect(await deliveryRows()).toHaveLength(1);
    queue.sent.length = 0;

    (env as any).DEMO_MODE = "1";
    await recordSent("se-1");
    await recordSent("se-2", "message.failed");
    expect(queue.sent).toEqual([]);
    const rows = await deliveryRows();
    expect(rows.map((r) => r.messageId)).toEqual(["se-old"]);

    const later = rows[0].nextAttemptAt + 2 * 3600;
    await sweepWebhookDeliveries(bindings, getDb(), later);
    expect(queue.sent).toEqual([]);
    const [row] = await getDb().select().from(webhookDeliveries);
    expect(row).toMatchObject({ status: "pending", attempts: 0 });
  });
});
