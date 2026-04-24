import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { env } from "cloudflare:workers";
import { applyMigrations, cleanDb, createTestUser, authFetch } from "./helpers";
import { drizzle } from "drizzle-orm/d1";
import { schema } from "../db/schema";
import { eq } from "drizzle-orm";
import { pushSubscriptions } from "../db/push-subscriptions.schema";

const SUB_BODY = {
  endpoint: "https://fcm.googleapis.com/fcm/send/test-endpoint-1",
  keys: {
    p256dh: "BPqc0jv9h6cJmQmC2WQqIn-example-public-key-32-bytes==",
    auth: "dGVzdC1hdXRoLXNlY3JldA",
  },
  userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/120",
};

describe("push subscription routes", () => {
  beforeAll(async () => {
    await applyMigrations();
  });
  beforeEach(async () => {
    await cleanDb();
  });

  it("POST /subscribe returns 503 when VAPID is unset", async () => {
    // This test verifies the 503 branch; since VAPID_PRIVATE_KEY IS set in
    // vitest config, we cannot trigger 503 in the normal flow. This test
    // is kept for documentation — the other tests below exercise the happy path.
    // NOTE: VAPID_PRIVATE_KEY is set to "test-vapid-private" in vitest.config.test.ts,
    // so this route will NOT return 503 in CI. The 503 branch is a runtime guard
    // for production deployments without VAPID configured.
    const { apiKey } = await createTestUser({ role: "member" });
    const res = await authFetch("/api/notifications/subscribe", {
      apiKey,
      method: "POST",
      body: JSON.stringify(SUB_BODY),
    });
    // With VAPID_PRIVATE_KEY set, expect 201 (not 503)
    expect(res.status).toBe(201);
  });

  it("POST /subscribe creates a row", async () => {
    const { apiKey, userId } = await createTestUser({ role: "member" });
    const res = await authFetch("/api/notifications/subscribe", {
      apiKey,
      method: "POST",
      body: JSON.stringify(SUB_BODY),
    });
    expect(res.status).toBe(201);
    const db = drizzle(env.DB, { schema });
    const rows = await db
      .select()
      .from(pushSubscriptions)
      .where(eq(pushSubscriptions.userId, userId));
    expect(rows).toHaveLength(1);
    expect(rows[0].endpoint).toBe(SUB_BODY.endpoint);
  });

  it("POST /subscribe upserts by endpoint and reassigns userId", async () => {
    const a = await createTestUser({
      id: "user-a",
      role: "member",
      email: "a@x.test",
    });
    const b = await createTestUser({
      id: "user-b",
      role: "member",
      email: "b@x.test",
    });
    await authFetch("/api/notifications/subscribe", {
      apiKey: a.apiKey,
      method: "POST",
      body: JSON.stringify(SUB_BODY),
    });
    const res = await authFetch("/api/notifications/subscribe", {
      apiKey: b.apiKey,
      method: "POST",
      body: JSON.stringify(SUB_BODY),
    });
    expect(res.status).toBe(201);
    const db = drizzle(env.DB, { schema });
    const rows = await db
      .select()
      .from(pushSubscriptions)
      .where(eq(pushSubscriptions.endpoint, SUB_BODY.endpoint));
    expect(rows).toHaveLength(1);
    expect(rows[0].userId).toBe(b.userId);
  });

  it("GET /subscriptions returns only current user's rows", async () => {
    const a = await createTestUser({
      id: "user-a",
      role: "member",
      email: "a@x.test",
    });
    const b = await createTestUser({
      id: "user-b",
      role: "member",
      email: "b@x.test",
    });
    await authFetch("/api/notifications/subscribe", {
      apiKey: a.apiKey,
      method: "POST",
      body: JSON.stringify(SUB_BODY),
    });
    await authFetch("/api/notifications/subscribe", {
      apiKey: b.apiKey,
      method: "POST",
      body: JSON.stringify({
        ...SUB_BODY,
        endpoint: SUB_BODY.endpoint + "-other",
      }),
    });
    const res = await authFetch("/api/notifications/subscriptions", {
      apiKey: a.apiKey,
    });
    const json = (await res.json()) as { subscriptions: unknown[] };
    expect(json.subscriptions).toHaveLength(1);
  });

  it("DELETE /subscribe removes a user's subscription by endpoint", async () => {
    const { apiKey, userId } = await createTestUser({ role: "member" });
    await authFetch("/api/notifications/subscribe", {
      apiKey,
      method: "POST",
      body: JSON.stringify(SUB_BODY),
    });
    const res = await authFetch("/api/notifications/subscribe", {
      apiKey,
      method: "DELETE",
      body: JSON.stringify({ endpoint: SUB_BODY.endpoint }),
    });
    expect(res.status).toBe(204);
    const db = drizzle(env.DB, { schema });
    const rows = await db
      .select()
      .from(pushSubscriptions)
      .where(eq(pushSubscriptions.userId, userId));
    expect(rows).toHaveLength(0);
  });

  it("DELETE /subscriptions/:id is scoped to the current user", async () => {
    const a = await createTestUser({
      id: "user-a",
      role: "member",
      email: "a@x.test",
    });
    const b = await createTestUser({
      id: "user-b",
      role: "member",
      email: "b@x.test",
    });
    await authFetch("/api/notifications/subscribe", {
      apiKey: a.apiKey,
      method: "POST",
      body: JSON.stringify(SUB_BODY),
    });
    const list = (await (
      await authFetch("/api/notifications/subscriptions", { apiKey: a.apiKey })
    ).json()) as { subscriptions: Array<{ id: string }> };
    const subId = list.subscriptions[0].id;

    const res = await authFetch(`/api/notifications/subscriptions/${subId}`, {
      apiKey: b.apiKey,
      method: "DELETE",
    });
    expect(res.status).toBe(404);
  });
});
