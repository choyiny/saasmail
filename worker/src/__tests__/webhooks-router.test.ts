import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyMigrations,
  authFetch,
  cleanDb,
  createTestUser,
  getDb,
} from "./helpers";
import { webhookDeliveries } from "../db/webhook-deliveries.schema";
import { sql } from "drizzle-orm";

beforeEach(async () => {
  await applyMigrations();
  await cleanDb();
});

describe("webhooks router", () => {
  it("GET returns empty config by default", async () => {
    const { apiKey } = await createTestUser({ role: "admin" });
    const res = await authFetch("/api/webhook", { apiKey });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ url: "", hasSecret: false });
  });

  it("PUT sets url+secret; GET reports hasSecret without echoing it", async () => {
    const { apiKey } = await createTestUser({ role: "admin" });
    const put = await authFetch("/api/webhook", {
      apiKey,
      method: "PUT",
      body: JSON.stringify({ url: "https://hook.d.com", secret: "shh" }),
    });
    expect(put.status).toBe(200);
    expect(await put.json()).toMatchObject({
      url: "https://hook.d.com",
      hasSecret: true,
    });

    const get = await authFetch("/api/webhook", { apiKey });
    const body = (await get.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ url: "https://hook.d.com", hasSecret: true });
    expect(JSON.stringify(body)).not.toContain("shh");
  });

  it("PUT with omitted secret preserves the existing secret", async () => {
    const { apiKey } = await createTestUser({ role: "admin" });
    await authFetch("/api/webhook", {
      apiKey,
      method: "PUT",
      body: JSON.stringify({ url: "https://hook.d.com", secret: "shh" }),
    });
    const put2 = await authFetch("/api/webhook", {
      apiKey,
      method: "PUT",
      body: JSON.stringify({ url: "https://hook2.d.com" }),
    });
    expect(await put2.json()).toMatchObject({
      url: "https://hook2.d.com",
      hasSecret: true,
    });
  });

  it("PUT with blank url disables the webhook", async () => {
    const { apiKey } = await createTestUser({ role: "admin" });
    await authFetch("/api/webhook", {
      apiKey,
      method: "PUT",
      body: JSON.stringify({ url: "https://hook.d.com", secret: "shh" }),
    });
    const clear = await authFetch("/api/webhook", {
      apiKey,
      method: "PUT",
      body: JSON.stringify({ url: "" }),
    });
    expect(await clear.json()).toMatchObject({ url: "", hasSecret: false });
  });

  it("allows http:// urls (no scheme restriction)", async () => {
    const { apiKey } = await createTestUser({ role: "admin" });
    const put = await authFetch("/api/webhook", {
      apiKey,
      method: "PUT",
      body: JSON.stringify({ url: "http://localhost:5678/webhook" }),
    });
    expect(put.status).toBe(200);
    expect(await put.json()).toMatchObject({
      url: "http://localhost:5678/webhook",
      hasSecret: false,
    });
  });

  it("POST /test returns 400 when unconfigured", async () => {
    const { apiKey } = await createTestUser({ role: "admin" });
    const res = await authFetch("/api/webhook/test", {
      apiKey,
      method: "POST",
    });
    expect(res.status).toBe(400);
  });

  it("POST /test attempts delivery to the configured URL and returns a result", async () => {
    const { apiKey } = await createTestUser({ role: "admin" });
    // miniflare blocks outbound fetch in tests, so delivery fails fast — we're
    // verifying the endpoint wires config → sendWebhook → returns a result
    // (the delivery mechanics themselves are unit-tested in webhook-delivery).
    await authFetch("/api/webhook", {
      apiKey,
      method: "PUT",
      body: JSON.stringify({ url: "http://127.0.0.1:1/webhook" }),
    });
    const res = await authFetch("/api/webhook/test", {
      apiKey,
      method: "POST",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(typeof body.ok).toBe("boolean");
    expect(body.ok).toBe(false);
  });

  it("returns 403 for a non-admin caller", async () => {
    const { apiKey } = await createTestUser({
      id: "u-mem",
      role: "member",
      email: "member@example.com",
    });
    const res = await authFetch("/api/webhook", { apiKey });
    expect(res.status).toBe(403);
  });

  it("PUT stores the event list, omitted keeps it, and unknown names are refused", async () => {
    const { apiKey } = await createTestUser({ role: "admin" });
    const put = await authFetch("/api/webhook", {
      apiKey,
      method: "PUT",
      body: JSON.stringify({
        url: "https://hook.d.com",
        events: ["message.sent", "message.bounced"],
      }),
    });
    expect(await put.json()).toMatchObject({
      events: ["message.sent", "message.bounced"],
      disabledAt: null,
      disabledReason: null,
    });
    const keep = await authFetch("/api/webhook", {
      apiKey,
      method: "PUT",
      body: JSON.stringify({ url: "https://hook2.d.com" }),
    });
    expect(await keep.json()).toMatchObject({
      events: ["message.sent", "message.bounced"],
    });
    const bad = await authFetch("/api/webhook", {
      apiKey,
      method: "PUT",
      body: JSON.stringify({ url: "https://hook.d.com", events: ["nope"] }),
    });
    expect(bad.status).toBe(400);
  });

  it("POST /enable clears a pause; GET /deliveries lists rows without addresses", async () => {
    const { apiKey } = await createTestUser({ role: "admin" });
    expect(
      (await authFetch("/api/webhook/enable", { apiKey, method: "POST" }))
        .status,
    ).toBe(400);
    await authFetch("/api/webhook", {
      apiKey,
      method: "PUT",
      body: JSON.stringify({
        url: "https://hook.d.com",
        events: ["message.sent"],
      }),
    });
    await getDb().run(
      sql`UPDATE app_settings SET value = json_set(value, '$.disabledAt', 1, '$.disabledReason', 'many failures') WHERE key = 'webhook'`,
    );
    const paused = await authFetch("/api/webhook", { apiKey });
    expect(await paused.json()).toMatchObject({
      disabledAt: 1,
      disabledReason: "many failures",
    });
    const enabled = await authFetch("/api/webhook/enable", {
      apiKey,
      method: "POST",
    });
    expect(enabled.status).toBe(200);
    expect(await enabled.json()).toMatchObject({
      disabledAt: null,
      disabledReason: null,
    });

    const now = Math.floor(Date.now() / 1000);
    await getDb()
      .insert(webhookDeliveries)
      .values({
        id: "wd_1",
        sourceKey: "sent:se-1:message.sent",
        event: "message.sent",
        messageId: "se-1",
        generation: 1,
        payload: JSON.stringify({
          message: { recipients: ["alice@example.com"] },
        }),
        status: "pending",
        nextAttemptAt: now,
        createdAt: now,
      });
    const list = await authFetch("/api/webhook/deliveries?limit=20", {
      apiKey,
    });
    expect(list.status).toBe(200);
    const text = await list.text();
    expect(JSON.parse(text)).toEqual({
      deliveries: [
        {
          id: "wd_1",
          event: "message.sent",
          messageId: "se-1",
          status: "pending",
          attempts: 0,
          lastStatus: null,
          lastError: null,
          createdAt: now,
          finishedAt: null,
        },
      ],
    });
    expect(text).not.toContain("alice@example.com");
  });

  it("POST /test sends a synthetic payload of the requested outbound event", async () => {
    const { apiKey } = await createTestUser({ role: "admin" });
    await authFetch("/api/webhook", {
      apiKey,
      method: "PUT",
      body: JSON.stringify({ url: "https://hook.example.com/events" }),
    });
    const hook = vi.fn<typeof fetch>(
      async () => new Response(null, { status: 204 }),
    );
    vi.stubGlobal("fetch", hook);
    try {
      const res = await authFetch("/api/webhook/test", {
        apiKey,
        method: "POST",
        body: JSON.stringify({ event: "message.bounced" }),
      });
      expect(res.status).toBe(200);
      expect(((await res.json()) as { ok: boolean }).ok).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
    expect(hook).toHaveBeenCalledOnce();
    const [url, init] = hook.mock.calls[0];
    expect(url).toBe("https://hook.example.com/events");
    expect(new Headers(init?.headers).get("X-SaaSMail-Event")).toBe(
      "message.bounced",
    );
    expect(JSON.parse(init?.body as string).event).toBe("message.bounced");
    expect(await getDb().select().from(webhookDeliveries)).toEqual([]);
  });
});
