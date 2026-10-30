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
import {
  applyMigrations,
  authFetch,
  buildSendForm,
  cleanDb,
  createTestSentEmail,
  createTestUser,
  getDb,
} from "./helpers";
import {
  HOOK_SECRET,
  HOOK_URL,
  captureQueue,
  configureWebhook,
  deliveryRows,
  queueMessage,
  scriptedFetch,
} from "./webhook-fixtures";
import { webhookDeliveries } from "../db/webhook-deliveries.schema";
import {
  buildWebhookPayload,
  deliverWebhook,
  recordSendWebhook,
  runWebhookDelivery,
  sendWebhook,
  sweepWebhookDeliveries,
} from "../lib/webhook-delivery";
import { getWebhookConfig, recordFailure } from "../lib/webhook-config";
import { handleQueueBatch } from "../lib/queue-router";
import { signWebhookBody } from "../lib/webhook-signature";

describe("buildWebhookPayload", () => {
  it("builds the documented shape, slices preview, defaults subject", () => {
    const p = buildWebhookPayload({
      emailId: "abc123",
      receivedAt: 1717459200,
      inbox: "support@d.com",
      fromAddress: "jane@example.com",
      fromName: "Jane",
      subject: null,
      bodyText: "x".repeat(500),
      conversationId: "conv1",
      attachments: [{ filename: "a.png", contentType: "image/png", size: 10 }],
      auth: { spf: "pass", dkim: "pass", dmarc: "pass" },
      baseUrl: "https://mail.d.com/",
    });
    expect(p.event).toBe("message.received");
    expect(p.id).toBe("abc123");
    expect(p.subject).toBe("");
    expect(p.from).toEqual({ address: "jane@example.com", name: "Jane" });
    expect(p.textPreview.length).toBe(280);
    expect(p.url).toBe("https://mail.d.com/m/abc123");
    expect(p.attachments).toEqual([
      { filename: "a.png", contentType: "image/png", size: 10 },
    ]);
  });
});

describe("sendWebhook", () => {
  const payload = buildWebhookPayload({
    emailId: "abc123",
    receivedAt: 1717459200,
    inbox: "support@d.com",
    fromAddress: "jane@example.com",
    fromName: null,
    subject: "Hi",
    bodyText: "hello",
    conversationId: "conv1",
    attachments: [],
    auth: { spf: null, dkim: null, dmarc: null },
    baseUrl: "https://mail.d.com",
  });

  it("POSTs JSON and signs the body when a secret is set", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(null, { status: 200 }));
    const result = await sendWebhook(
      { url: "https://hook.d.com", secret: "shh" },
      payload,
      fetchImpl,
    );
    expect(result).toEqual({ ok: true, status: 200 });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://hook.d.com");
    expect(init?.method).toBe("POST");
    const headers = new Headers(init?.headers);
    expect(headers.get("Content-Type")).toBe("application/json");
    expect(headers.get("X-SaaSMail-Event")).toBe("message.received");
    const expectedSig = await signWebhookBody(init?.body as string, "shh");
    expect(headers.get("X-SaaSMail-Signature")).toBe(expectedSig);
  });

  it("omits the signature header when no secret", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(null, { status: 204 }));
    const result = await sendWebhook(
      { url: "https://hook.d.com", secret: null },
      payload,
      fetchImpl,
    );
    expect(result).toEqual({ ok: true, status: 204 });
    const headers = new Headers(fetchImpl.mock.calls[0][1]?.headers);
    expect(headers.has("X-SaaSMail-Signature")).toBe(false);
  });

  it("returns ok:false with the error message when fetch throws", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new Error("boom"));
    const result = await sendWebhook(
      { url: "https://hook.d.com", secret: null },
      payload,
      fetchImpl,
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain("boom");
  });

  it("reports ok:false for non-2xx without throwing", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("nope", { status: 500 }));
    const result = await sendWebhook(
      { url: "https://hook.d.com", secret: null },
      payload,
      fetchImpl,
    );
    expect(result).toEqual({ ok: false, status: 500 });
  });
});

// --- docs/webhooks.md: outbound delivery events, retried from EMAIL_QUEUE.

const bindings = env as unknown as CloudflareBindings;

describe("outbound delivery job", () => {
  let queue: ReturnType<typeof captureQueue>;

  beforeAll(applyMigrations);
  beforeEach(async () => {
    await cleanDb();
    (env as any).DEMO_MODE = "0";
    queue = captureQueue();
    await configureWebhook(["message.sent"]);
    await createTestSentEmail({
      id: "se-1",
      fromAddress: "support@saasmail.test",
      toAddress: "customer@example.com",
      subject: "Your invoice",
      messageId: "<delivered-1@saasmail.test>",
      campaignId: "camp-1",
      conversationId: "conv-1",
    });
    await recordSendWebhook(bindings, getDb(), {
      event: "message.sent",
      sentEmailId: "se-1",
      messageId: "<submitted-1@saasmail.test>",
      from: "support@saasmail.test",
      to: "customer@example.com",
      subject: "Your invoice",
    });
  });
  afterEach(() => queue.restore());

  function pointer() {
    expect(queue.sent).toHaveLength(1);
    return queue.sent[0] as { type: string; deliveryId: string };
  }

  it("retries a 5xx after 60, 300 and 1800 s, sends the same bytes each time, and fails the 4th attempt with an ack", async () => {
    const fetchImpl = scriptedFetch([503]);
    const { deliveryId } = pointer();
    const delays: unknown[] = [];
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      const msg = queueMessage(
        { type: "webhook_delivery", deliveryId },
        attempt,
      );
      await runWebhookDelivery(getDb(), bindings, msg, { fetchImpl });
      if (attempt < 4) {
        expect(msg.ack).not.toHaveBeenCalled();
        delays.push(msg.retry.mock.calls[0][0]);
      } else {
        expect(msg.retry).not.toHaveBeenCalled();
        expect(msg.ack).toHaveBeenCalledOnce();
      }
    }
    expect(delays).toEqual([
      { delaySeconds: 60 },
      { delaySeconds: 300 },
      { delaySeconds: 1800 },
    ]);
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    const bodies = fetchImpl.mock.calls.map(([, init]) => init?.body);
    expect(new Set(bodies).size).toBe(1);
    const headers = fetchImpl.mock.calls.map(
      ([, init]) => new Headers(init?.headers),
    );
    expect(new Set(headers.map((h) => h.get("X-SaaSMail-Delivery")))).toEqual(
      new Set([deliveryId]),
    );
    expect(headers[0].get("X-SaaSMail-Event")).toBe("message.sent");
    expect(headers[0].get("X-SaaSMail-Signature")).toBe(
      await signWebhookBody(bodies[0] as string, HOOK_SECRET),
    );

    const [row] = await deliveryRows();
    expect(row).toMatchObject({
      status: "failed",
      attempts: 4,
      lastStatus: 503,
      payload: null,
    });
    expect(row.finishedAt).not.toBeNull();
  });

  it("posts once when two consumers run the same delivery at the same time", async () => {
    // The first POST is slow: a second consumer starts while it is in flight.
    let calls = 0;
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      calls += 1;
      if (calls > 1) return new Response(null, { status: 200 });
      await new Promise((resolve) => setTimeout(resolve, 100));
      return new Response(null, { status: 404 });
    });
    const { deliveryId } = pointer();
    const a = queueMessage({ type: "webhook_delivery", deliveryId });
    const b = queueMessage({ type: "webhook_delivery", deliveryId });
    const first = runWebhookDelivery(getDb(), bindings, a, { fetchImpl });
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalled());
    await runWebhookDelivery(getDb(), bindings, b, { fetchImpl });
    await first;
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(a.ack).toHaveBeenCalledOnce();
    expect(b.ack).toHaveBeenCalledOnce();
    const [row] = await deliveryRows();
    // The row records the one POST that was made.
    expect(row).toMatchObject({
      status: "failed",
      attempts: 1,
      lastStatus: 404,
    });
  });

  it("waits for a send's sent row before freezing its ids, and freezes with nulls after 5 minutes", async () => {
    queue.sent.length = 0;
    queue.options.length = 0;
    const send = (sentEmailId: string) =>
      recordSendWebhook(bindings, getDb(), {
        event: "message.sent",
        sentEmailId,
        from: "support@saasmail.test",
        to: "customer@example.com",
        subject: "Your invoice",
      });
    await send("se-2");
    const [early] = queue.sent;
    const fetchImpl = scriptedFetch([200]);

    // The caller has not written the sent row yet: no POST, no attempt used.
    const first = queueMessage(early);
    await runWebhookDelivery(getDb(), bindings, first, { fetchImpl });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(first.ack).toHaveBeenCalledOnce();
    expect(first.retry).not.toHaveBeenCalled();
    expect(queue.sent).toEqual([early, early]);
    expect(queue.options[1]).toEqual({ delaySeconds: 30 });
    let rows = await deliveryRows();
    expect(rows.find((r) => r.messageId === "se-2")).toMatchObject({
      status: "pending",
      attempts: 0,
      frozen: 0,
    });

    // Once it exists, the delivery carries its ids.
    await createTestSentEmail({
      id: "se-2",
      fromAddress: "support@saasmail.test",
      toAddress: "customer@example.com",
      campaignId: "camp-2",
      conversationId: "conv-2",
    });
    await runWebhookDelivery(getDb(), bindings, queueMessage(early), {
      fetchImpl,
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
    const body = JSON.parse(fetchImpl.mock.calls[0][1]?.body as string);
    expect(body.message).toMatchObject({
      id: "se-2",
      campaignId: "camp-2",
      conversationId: "conv-2",
    });

    // A sent row still missing after 5 minutes: sent with null ids.
    await send("se-3");
    const late = queue.sent.at(-1) as { deliveryId: string };
    await getDb()
      .update(webhookDeliveries)
      .set({ createdAt: Math.floor(Date.now() / 1000) - 301 })
      .where(eq(webhookDeliveries.id, late.deliveryId));
    await runWebhookDelivery(getDb(), bindings, queueMessage(late), {
      fetchImpl,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const lateBody = JSON.parse(fetchImpl.mock.calls[1][1]?.body as string);
    expect(lateBody.message).toMatchObject({
      id: "se-3",
      campaignId: null,
      conversationId: null,
    });
    rows = await deliveryRows();
    expect(rows.find((r) => r.messageId === "se-3")?.status).toBe("delivered");
  });

  it("fails a 404 at once", async () => {
    const fetchImpl = scriptedFetch([404]);
    const msg = queueMessage({
      type: "webhook_delivery",
      deliveryId: pointer().deliveryId,
    });
    await runWebhookDelivery(getDb(), bindings, msg, { fetchImpl });
    expect(msg.ack).toHaveBeenCalledOnce();
    expect(msg.retry).not.toHaveBeenCalled();
    const [row] = await deliveryRows();
    expect(row).toMatchObject({
      status: "failed",
      attempts: 1,
      lastStatus: 404,
    });
  });

  it("retries a network error", async () => {
    const fetchImpl = scriptedFetch([new Error("connection refused")]);
    const msg = queueMessage({
      type: "webhook_delivery",
      deliveryId: pointer().deliveryId,
    });
    await runWebhookDelivery(getDb(), bindings, msg, { fetchImpl });
    expect(msg.retry).toHaveBeenCalledWith({ delaySeconds: 60 });
    const [row] = await deliveryRows();
    expect(row).toMatchObject({
      status: "pending",
      lastStatus: null,
      lastError: "connection refused",
    });
  });

  it("freezes message.sent with the sent row's ids and no body text", async () => {
    const fetchImpl = scriptedFetch([200]);
    const { deliveryId } = pointer();
    await runWebhookDelivery(
      getDb(),
      bindings,
      queueMessage({ type: "webhook_delivery", deliveryId }),
      { fetchImpl },
    );
    const body = JSON.parse(fetchImpl.mock.calls[0][1]?.body as string);
    expect(body).toEqual({
      event: "message.sent",
      deliveryId,
      occurredAt: expect.any(Number),
      message: {
        id: "se-1",
        messageId: "<delivered-1@saasmail.test>",
        from: "support@saasmail.test",
        recipients: ["customer@example.com"],
        subject: "Your invoice",
        campaignId: "camp-1",
        sequenceId: null,
        sequenceEnrollmentId: null,
        conversationId: "conv-1",
        url: "http://localhost:8080/m/se-1",
      },
    });
    const [row] = await deliveryRows();
    expect(row).toMatchObject({
      status: "delivered",
      payload: null,
      attempts: 1,
    });
  });

  it("sends nothing for a message redelivered after the row was delivered", async () => {
    const fetchImpl = scriptedFetch([200]);
    const { deliveryId } = pointer();
    await runWebhookDelivery(
      getDb(),
      bindings,
      queueMessage({ type: "webhook_delivery", deliveryId }),
      { fetchImpl },
    );
    const again = queueMessage({ type: "webhook_delivery", deliveryId }, 2);
    await runWebhookDelivery(getDb(), bindings, again, { fetchImpl });
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(again.ack).toHaveBeenCalledOnce();
  });

  it("cancels a row whose config was saved since, and does not count it", async () => {
    const fetchImpl = scriptedFetch([200]);
    const { deliveryId } = pointer();
    await configureWebhook(["message.sent"]);
    const msg = queueMessage({ type: "webhook_delivery", deliveryId });
    await runWebhookDelivery(getDb(), bindings, msg, { fetchImpl });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(msg.ack).toHaveBeenCalledOnce();
    const [row] = await deliveryRows();
    expect(row).toMatchObject({ status: "cancelled", payload: null });
    const [cfg] = await getDb()
      .select()
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.status, "failed"));
    expect(cfg).toBeUndefined();
  });

  it("is routed by the queue consumer and never runs a suggested reply", async () => {
    const fetchMock = scriptedFetch([200]);
    vi.stubGlobal("fetch", fetchMock);
    try {
      const msg = queueMessage(pointer());
      const suggest = vi.fn();
      await handleQueueBatch(
        {
          queue: "test",
          messages: [msg],
          ackAll: vi.fn(),
          retryAll: vi.fn(),
        } as unknown as MessageBatch<unknown>,
        bindings,
        { runSuggestedReply: suggest },
      );
      expect(suggest).not.toHaveBeenCalled();
      expect(msg.ack).toHaveBeenCalledOnce();
      expect(fetchMock.mock.calls[0][0]).toBe(HOOK_URL);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("the sweep resends a lost pointer, finishes a row whose 4th attempt died, leaves one in flight, and prunes old rows", async () => {
    const now = Math.floor(Date.now() / 1000);
    const { deliveryId } = pointer();
    // A second send whose 4th attempt never finishes (the isolate died in
    // its POST): the row stays pending with the attempt claimed.
    await createTestSentEmail({ id: "se-2" });
    await recordSendWebhook(bindings, getDb(), {
      event: "message.sent",
      sentEmailId: "se-2",
      from: "support@saasmail.test",
      to: "customer@example.com",
      subject: "Your invoice",
    });
    const stuck = queue.sent[1] as { deliveryId: string };
    const fetch503 = scriptedFetch([503]);
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await runWebhookDelivery(
        getDb(),
        bindings,
        queueMessage(stuck, attempt),
        { fetchImpl: fetch503 },
      );
    }
    let release!: () => void;
    const hung = vi.fn<typeof fetch>(
      () =>
        new Promise<Response>((_, reject) => {
          release = () => reject(new Error("isolate gone"));
        }),
    );
    const fourth = runWebhookDelivery(
      getDb(),
      bindings,
      queueMessage(stuck, 4),
      { fetchImpl: hung },
    );
    await vi.waitFor(() => expect(hung).toHaveBeenCalled());
    queue.sent.length = 0;

    const [row] = await deliveryRows();
    const later = now + 2 * 3600;
    await getDb()
      .insert(webhookDeliveries)
      .values([
        // Overdue, attempts spent, but an attempt is still in flight.
        {
          ...row,
          id: "wd_inflight",
          sourceKey: "sent:se-4:message.sent",
          attempts: 4,
          nextAttemptAt: now - 2 * 3600,
          claimedUntil: later + 60,
        },
        {
          ...row,
          id: "wd_old",
          sourceKey: "sent:se-3:message.sent",
          status: "delivered",
          payload: null,
          createdAt: now - 8 * 24 * 3600,
          finishedAt: now - 8 * 24 * 3600,
        },
      ]);

    // Not overdue yet: only the old finished row goes.
    expect(await sweepWebhookDeliveries(bindings, getDb(), now)).toEqual({
      resent: 0,
      failed: 0,
      pruned: 1,
    });
    expect(queue.sent).toEqual([]);
    expect(await sweepWebhookDeliveries(bindings, getDb(), later)).toEqual({
      resent: 1,
      failed: 1,
      pruned: 0,
    });
    expect(queue.sent).toEqual([{ type: "webhook_delivery", deliveryId }]);

    // The dead attempt's late outcome changes nothing.
    release();
    await fourth;
    const rows = await deliveryRows();
    expect(rows.map((r) => [r.id, r.status]).sort()).toEqual(
      [
        [deliveryId, "pending"],
        [stuck.deliveryId, "failed"],
        ["wd_inflight", "pending"],
      ].sort(),
    );
    expect(rows.find((r) => r.id === stuck.deliveryId)).toMatchObject({
      attempts: 4,
      lastStatus: 503,
      payload: null,
    });
  });
});

describe("message.received keeps its single inline attempt", () => {
  beforeAll(applyMigrations);
  beforeEach(async () => {
    await cleanDb();
  });
  afterEach(() => vi.unstubAllGlobals());

  const payload = buildWebhookPayload({
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
  });

  async function deliverOnce() {
    const fetchMock = scriptedFetch([500]);
    vi.stubGlobal("fetch", fetchMock);
    const calls: Promise<unknown>[] = [];
    deliverWebhook(
      getDb(),
      {
        waitUntil: (p: Promise<unknown>) => calls.push(p),
      } as unknown as ExecutionContext,
      payload,
    );
    await Promise.all(calls);
    return fetchMock;
  }

  it("sends nothing when the event is unticked", async () => {
    await configureWebhook(["message.sent"]);
    expect(await deliverOnce()).not.toHaveBeenCalled();
  });

  it("makes one attempt and writes no row when ticked, even while paused", async () => {
    await configureWebhook(["message.received", "message.sent"]);
    const db = getDb();
    const [{ generation }] = await db.all<{ generation: number }>(
      sql`SELECT json_extract(value, '$.generation') AS generation FROM app_settings WHERE key = 'webhook'`,
    );
    for (let i = 0; i < 20; i += 1) {
      await recordFailure(db, generation, { status: 500, error: null });
    }
    expect((await getWebhookConfig(db))?.disabledAt).not.toBeNull();

    const fetchMock = await deliverOnce();
    expect(fetchMock).toHaveBeenCalledOnce();
    const headers = new Headers(fetchMock.mock.calls[0][1]?.headers);
    expect(headers.get("X-SaaSMail-Event")).toBe("message.received");
    expect(headers.has("X-SaaSMail-Delivery")).toBe(false);
    expect(await deliveryRows()).toEqual([]);
  });
});

describe("POST /api/send with message.sent ticked", () => {
  let queue: ReturnType<typeof captureQueue>;

  beforeAll(applyMigrations);
  beforeEach(async () => {
    await cleanDb();
    (env as any).DEMO_MODE = "0";
    queue = captureQueue();
  });
  afterEach(() => {
    queue.restore();
    vi.unstubAllGlobals();
  });

  it("produces one signed delivery carrying the send's id, To and Cc only, retried after a 503", async () => {
    const { apiKey } = await createTestUser();
    await configureWebhook(["message.received", "message.sent"]);
    // The provider (Resend in tests) accepts the message.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ id: "re_accepted" })),
    );
    const res = await authFetch("/api/send", {
      apiKey,
      method: "POST",
      body: buildSendForm({
        to: "customer@example.com",
        cc: [{ email: "cc@example.com" }],
        fromAddress: "support@saasmail.test",
        subject: "Your invoice",
        bodyHtml: "<p>Private body</p>",
        transactional: true,
      }),
    });
    expect(res.status).toBe(201);
    const { id } = (await res.json()) as { id: string };

    expect(queue.sent).toHaveLength(1);
    const { deliveryId } = queue.sent[0] as { deliveryId: string };
    const fetchImpl = scriptedFetch([503, 200]);
    const first = queueMessage({ type: "webhook_delivery", deliveryId }, 1);
    await runWebhookDelivery(getDb(), bindings, first, { fetchImpl });
    expect(first.retry).toHaveBeenCalledWith({ delaySeconds: 60 });
    const second = queueMessage({ type: "webhook_delivery", deliveryId }, 2);
    await runWebhookDelivery(getDb(), bindings, second, { fetchImpl });
    expect(second.ack).toHaveBeenCalledOnce();

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const [url, init] = fetchImpl.mock.calls[1];
    expect(url).toBe(HOOK_URL);
    const body = init?.body as string;
    expect(new Headers(init?.headers).get("X-SaaSMail-Signature")).toBe(
      await signWebhookBody(body, HOOK_SECRET),
    );
    const parsed = JSON.parse(body);
    expect(parsed.message.id).toBe(id);
    expect(parsed.message.recipients).toEqual([
      "customer@example.com",
      "cc@example.com",
    ]);
    expect(body).not.toContain("Private body");
    const rows = await deliveryRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "delivered", attempts: 2 });
  });
});
