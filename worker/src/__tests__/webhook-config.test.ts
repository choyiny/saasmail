import { beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import {
  applyMigrations,
  cleanDb,
  createTestSentEmail,
  getDb,
} from "./helpers";
import {
  captureQueue,
  deliveryRows,
  queueMessage,
  scriptedFetch,
} from "./webhook-fixtures";
import {
  enableWebhook,
  getWebhookConfig,
  recordFailure,
  recordSuccess,
  setWebhookConfig,
  webhookWants,
} from "../lib/webhook-config";
import { recordSendWebhook, runWebhookDelivery } from "../lib/webhook-delivery";
import { appSettings } from "../db/app-settings.schema";
import { auditEvents } from "../db/audit-events.schema";

beforeEach(async () => {
  await applyMigrations();
  await cleanDb();
});

describe("webhook-config", () => {
  it("returns null when unconfigured", async () => {
    expect(await getWebhookConfig(getDb())).toBeNull();
  });

  it("round-trips url + secret", async () => {
    await setWebhookConfig(
      getDb(),
      { url: "https://hook.example.com", secret: "whsec_abc" },
      "user-1",
    );
    expect(await getWebhookConfig(getDb())).toMatchObject({
      url: "https://hook.example.com",
      secret: "whsec_abc",
    });
  });

  it("treats empty/whitespace url as disabled (null)", async () => {
    await setWebhookConfig(getDb(), { url: "   ", secret: "x" }, "user-1");
    expect(await getWebhookConfig(getDb())).toBeNull();
  });

  it("stores a null secret when none provided", async () => {
    await setWebhookConfig(
      getDb(),
      { url: "https://hook.example.com", secret: null },
      "user-1",
    );
    expect(await getWebhookConfig(getDb())).toMatchObject({
      url: "https://hook.example.com",
      secret: null,
    });
  });

  it("returns null on malformed stored JSON (no throw)", async () => {
    const now = Math.floor(Date.now() / 1000);
    await getDb()
      .insert(appSettings)
      .values({
        key: "webhook",
        value: "{not json",
        updatedAt: now,
        updatedBy: null,
      })
      .onConflictDoUpdate({
        target: appSettings.key,
        set: { value: "{not json", updatedAt: now, updatedBy: null },
      });
    expect(await getWebhookConfig(getDb())).toBeNull();
  });
});

// docs/webhooks.md: the event list and the pause after 20 failures in a row.
describe("webhook events and auto-disable", () => {
  const now = Math.floor(Date.now() / 1000);

  async function storeRaw(value: string) {
    await getDb()
      .insert(appSettings)
      .values({ key: "webhook", value, updatedAt: now, updatedBy: null })
      .onConflictDoUpdate({
        target: appSettings.key,
        set: { value, updatedAt: now },
      });
  }

  async function current() {
    const cfg = await getWebhookConfig(getDb());
    if (!cfg) throw new Error("no config");
    return cfg;
  }

  const fail = (generation: number, status = 500) =>
    recordFailure(getDb(), generation, { status, error: null });

  async function failTimes(generation: number, count: number) {
    for (let i = 0; i < count; i += 1) {
      expect(await fail(generation)).toBe(false);
    }
  }

  const pauses = async () =>
    (await getDb().select().from(auditEvents)).filter(
      (e) => e.action === "webhook.auto_disabled",
    );

  it("reads a config stored without events as message.received only", async () => {
    await storeRaw(
      JSON.stringify({ url: "https://hook.example.com", secret: null }),
    );
    expect(await current()).toMatchObject({
      events: ["message.received"],
      generation: 0,
      disabledAt: null,
    });
  });

  it("drops unknown event names and keeps an empty list", async () => {
    await storeRaw(
      JSON.stringify({
        url: "https://hook.example.com",
        events: ["message.sent", "message.opened"],
      }),
    );
    expect((await current()).events).toEqual(["message.sent"]);
    await setWebhookConfig(
      getDb(),
      { url: "https://hook.example.com", secret: null, events: [] },
      null,
    );
    const cfg = await current();
    expect(cfg.events).toEqual([]);
    expect(webhookWants(cfg, "message.received")).toBe(false);
  });

  it("cancels a delivery recorded before the config was cleared and saved again, without sending it to the new URL", async () => {
    const bindings = env as unknown as CloudflareBindings;
    const queue = captureQueue();
    try {
      await setWebhookConfig(
        getDb(),
        {
          url: "https://a.example.com",
          secret: null,
          events: ["message.sent"],
        },
        null,
      );
      await createTestSentEmail({ id: "se-1" });
      await recordSendWebhook(bindings, getDb(), {
        event: "message.sent",
        sentEmailId: "se-1",
        from: "support@saasmail.test",
        to: "customer@example.com",
        subject: "Your invoice",
      });
      expect(queue.sent).toHaveLength(1);

      await setWebhookConfig(getDb(), null, null);
      await setWebhookConfig(
        getDb(),
        {
          url: "https://b.example.com",
          secret: null,
          events: ["message.sent"],
        },
        null,
      );
      const fetchImpl = scriptedFetch([200]);
      const msg = queueMessage(queue.sent[0]);
      await runWebhookDelivery(getDb(), bindings, msg, { fetchImpl });
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(msg.ack).toHaveBeenCalledOnce();
      const [row] = await deliveryRows();
      expect(row.status).toBe("cancelled");
    } finally {
      queue.restore();
    }
  });

  it("pauses once after 20 failures in a row, even when two consumers finish the 20th together", async () => {
    await setWebhookConfig(
      getDb(),
      {
        url: "https://hook.example.com",
        secret: null,
        events: ["message.sent"],
      },
      null,
    );
    const { generation } = await current();
    await failTimes(generation, 19);
    const results = await Promise.all([
      fail(generation, 503),
      fail(generation, 503),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    const cfg = await current();
    expect(cfg.disabledAt).not.toBeNull();
    expect(cfg.disabledReason).toContain("HTTP 503");
    expect(webhookWants(cfg, "message.sent")).toBe(false);
    expect(await pauses()).toHaveLength(1);

    // Re-enable lifts it, in a new generation that counts from 0, and is audited.
    expect(await enableWebhook(getDb(), null)).toBe(true);
    const enabled = await current();
    expect(enabled).toMatchObject({ disabledAt: null, disabledReason: null });
    expect(enabled.generation).not.toBe(generation);
    expect(webhookWants(enabled, "message.sent")).toBe(true);
    const audit = await getDb().select().from(auditEvents);
    expect(audit.some((e) => e.action === "webhook.enabled")).toBe(true);
    await failTimes(enabled.generation, 19);
    expect(await fail(enabled.generation)).toBe(true);
  });

  it("does not let a stale generation pause a newer save, and the save counts from 0", async () => {
    await setWebhookConfig(
      getDb(),
      { url: "https://hook.example.com", secret: null },
      null,
    );
    const { generation } = await current();
    await failTimes(generation, 19);
    await setWebhookConfig(
      getDb(),
      { url: "https://hook.example.com", secret: null },
      null,
    );
    const saved = await current();
    expect(await fail(generation)).toBe(false);
    await failTimes(saved.generation, 19);
    expect((await current()).disabledAt).toBeNull();
    expect(await pauses()).toEqual([]);
  });

  it("starts the run again after a success", async () => {
    await setWebhookConfig(
      getDb(),
      { url: "https://hook.example.com", secret: null },
      null,
    );
    const { generation } = await current();
    await failTimes(generation, 15);
    await recordSuccess(getDb(), generation);
    await failTimes(generation, 19);
    expect(await fail(generation)).toBe(true);
  });
});
