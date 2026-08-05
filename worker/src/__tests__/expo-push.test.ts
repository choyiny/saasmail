/**
 * The Expo transport and its registration routes.
 *
 * The delivery function is tested against a stubbed `fetch` rather than the
 * real push service: what matters is how the response is *interpreted*, and
 * Expo reports per-message failure inside an HTTP 200, so trusting the status
 * code is exactly the mistake to guard against.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import {
  applyMigrations,
  cleanDb,
  createTestUser,
  authFetch,
  getDb,
} from "./helpers";
import { expoPushSubscriptions } from "../db/expo-push-subscriptions.schema";
import { buildMessage, sendExpoPush } from "../lib/expo-push";

const realFetch = globalThis.fetch;

/** Stub `fetch` with a canned Expo response and capture what was sent. */
function stubExpo(
  responder: (batch: any[]) => { status?: number; body?: unknown },
) {
  const calls: any[][] = [];
  globalThis.fetch = (async (_url: any, init: any) => {
    const batch = JSON.parse(init.body);
    calls.push(batch);
    const {
      status = 200,
      body = { data: batch.map(() => ({ status: "ok" })) },
    } = responder(batch);
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
  return calls;
}

function msg(token: string) {
  return buildMessage({
    token,
    senderName: "Alice",
    subject: "Invoice #12",
    data: { threadId: "t1" },
    withPreview: false,
  });
}

describe("buildMessage", () => {
  it("omits sender and subject by default", () => {
    const m = msg("ExponentPushToken[a]");
    expect(m.title).toBe("New email");
    expect(m.body).toBe("");
    // Routing still works — the client fetches the real content itself.
    expect(m.data).toEqual({ threadId: "t1" });
  });

  it("includes them only when previews are opted into", () => {
    const m = buildMessage({
      token: "ExponentPushToken[a]",
      senderName: "Alice",
      subject: "Invoice #12",
      data: {},
      withPreview: true,
    });
    expect(m.title).toBe("Alice");
    expect(m.body).toBe("Invoice #12");
  });

  it("uses a TTL suited to a phone rather than the web-push 60 seconds", () => {
    // A handset asleep or out of signal for a few minutes must still get it.
    expect(msg("ExponentPushToken[a]").ttl).toBeGreaterThanOrEqual(3600);
  });

  it("leaves badge numeric or absent, never an icon path", () => {
    const m = msg("ExponentPushToken[a]");
    expect(["number", "undefined"]).toContain(typeof m.badge);
  });
});

describe("sendExpoPush", () => {
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("does nothing and calls nothing for an empty list", async () => {
    const calls = stubExpo(() => ({}));
    const res = await sendExpoPush([]);
    expect(calls).toHaveLength(0);
    expect(res.sent).toBe(0);
  });

  it("chunks to Expo's 100-message limit", async () => {
    const calls = stubExpo(() => ({}));
    const messages = Array.from({ length: 250 }, (_, i) =>
      msg(`ExponentPushToken[${i}]`),
    );

    const res = await sendExpoPush(messages);

    expect(calls.map((c) => c.length)).toEqual([100, 100, 50]);
    expect(res.sent).toBe(250);
  });

  it("reports failures reported inside a 200 response", async () => {
    stubExpo((batch) => ({
      status: 200,
      body: {
        data: batch.map(() => ({
          status: "error",
          message: "boom",
          details: { error: "MessageTooBig" },
        })),
      },
    }));

    const res = await sendExpoPush([msg("ExponentPushToken[a]")]);
    expect(res.sent).toBe(0);
    expect(res.failed).toBe(1);
    // Not a dead device — the row must survive.
    expect(res.invalidTokens).toEqual([]);
  });

  it("surfaces DeviceNotRegistered tokens for pruning", async () => {
    stubExpo((batch) => ({
      status: 200,
      body: {
        data: batch.map((m: any) =>
          m.to === "ExponentPushToken[dead]"
            ? {
                status: "error",
                message: "gone",
                details: { error: "DeviceNotRegistered" },
              }
            : { status: "ok" },
        ),
      },
    }));

    const res = await sendExpoPush([
      msg("ExponentPushToken[alive]"),
      msg("ExponentPushToken[dead]"),
    ]);

    expect(res.invalidTokens).toEqual(["ExponentPushToken[dead]"]);
    expect(res.sent).toBe(1);
  });

  it("stops and flags throttling on a 429 rather than hammering", async () => {
    const calls = stubExpo(() => ({ status: 429, body: {} }));
    const messages = Array.from({ length: 250 }, (_, i) =>
      msg(`ExponentPushToken[${i}]`),
    );

    const res = await sendExpoPush(messages);

    expect(res.throttled).toBe(true);
    // Gave up after the first rejected batch instead of sending all three.
    expect(calls).toHaveLength(1);
    expect(res.sent).toBe(0);
  });

  it("survives a transport error without throwing", async () => {
    globalThis.fetch = (async () => {
      throw new Error("network down");
    }) as typeof fetch;

    const res = await sendExpoPush([msg("ExponentPushToken[a]")]);
    expect(res.failed).toBe(1);
    expect(res.sent).toBe(0);
  });
});

describe("expo registration routes", () => {
  let apiKey: string;

  beforeAll(applyMigrations);
  beforeEach(async () => {
    await cleanDb();
    ({ apiKey } = await createTestUser());
  });

  const body = {
    token: "ExponentPushToken[abc]",
    installationId: "install-1",
    platform: "ios" as const,
  };

  function subscribe(payload: Record<string, unknown>) {
    return authFetch("/api/notifications/expo/subscribe", {
      apiKey,
      method: "POST",
      body: JSON.stringify(payload),
    });
  }

  it("registers a device", async () => {
    expect((await subscribe(body)).status).toBe(200);
    const rows = await getDb().select().from(expoPushSubscriptions);
    expect(rows).toHaveLength(1);
    expect(rows[0].token).toBe(body.token);
    expect(rows[0].tokenVersion).toBe(1);
  });

  it("updates in place when the same installation re-registers", async () => {
    await subscribe(body);
    await subscribe({ ...body, token: "ExponentPushToken[rotated]" });

    const rows = await getDb().select().from(expoPushSubscriptions);
    // One row, not two — otherwise every rotation leaves a dead token behind
    // that still looks live until something tries to send to it.
    expect(rows).toHaveLength(1);
    expect(rows[0].token).toBe("ExponentPushToken[rotated]");
    expect(rows[0].tokenVersion).toBe(2);
  });

  it("does not bump the version when the token is unchanged", async () => {
    await subscribe(body);
    await subscribe(body);

    const rows = await getDb().select().from(expoPushSubscriptions);
    expect(rows[0].tokenVersion).toBe(1);
  });

  it("keeps separate installations apart", async () => {
    await subscribe(body);
    await subscribe({ ...body, installationId: "install-2" });

    expect(await getDb().select().from(expoPushSubscriptions)).toHaveLength(2);
  });

  it("unregisters, and is idempotent", async () => {
    await subscribe(body);

    for (const _ of [1, 2]) {
      const res = await authFetch("/api/notifications/expo/subscribe", {
        apiKey,
        method: "DELETE",
        body: JSON.stringify({ installationId: body.installationId }),
      });
      expect(res.status).toBe(200);
    }

    expect(await getDb().select().from(expoPushSubscriptions)).toHaveLength(0);
  });

  it("rejects a registration with no token", async () => {
    const res = await subscribe({ installationId: "x" });
    expect(res.status).toBe(400);
  });

  it("never returns a stored token", async () => {
    await subscribe(body);
    const res = await authFetch("/api/notifications/expo/subscribe", {
      apiKey,
      method: "POST",
      body: JSON.stringify(body),
    });
    expect(JSON.stringify(await res.json())).not.toContain(body.token);
  });

  it("scopes rows to their owner", async () => {
    await subscribe(body);
    const { apiKey: other } = await createTestUser({
      id: "other",
      email: "other@test.local",
    });
    await authFetch("/api/notifications/expo/subscribe", {
      apiKey: other,
      method: "POST",
      body: JSON.stringify({ ...body, token: "ExponentPushToken[other]" }),
    });

    const mine = await getDb()
      .select()
      .from(expoPushSubscriptions)
      .where(eq(expoPushSubscriptions.userId, "test-user-1"));
    expect(mine).toHaveLength(1);
    expect(mine[0].token).toBe(body.token);
  });
});
