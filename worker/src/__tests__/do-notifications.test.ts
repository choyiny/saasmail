import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { env } from "cloudflare:workers";
import { applyMigrations, cleanDb, createTestUser } from "./helpers";
import { drizzle } from "drizzle-orm/d1";
import { schema } from "../db/schema";
import { pushSubscriptions } from "../db/push-subscriptions.schema";

const DELIVER_PAYLOAD = {
  inbox: "support@example.com",
  threadId: "thread-1",
  personId: "person-1",
  senderName: "Jane Doe",
  subject: "Hello",
  bodyPreview: "Preview of body",
};

describe("NotificationsHub /deliver", () => {
  beforeAll(async () => {
    await applyMigrations();
  });
  beforeEach(async () => {
    await cleanDb();
  });

  it("returns {via:'none'} when user has no WS and no push subs", async () => {
    const { userId } = await createTestUser({ role: "member" });
    const stub = env.NOTIFICATIONS_HUB.get(
      env.NOTIFICATIONS_HUB.idFromName(userId),
    );
    const res = await stub.fetch(
      new Request("http://do/deliver", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(DELIVER_PAYLOAD),
      }),
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { via: string };
    expect(json.via).toBe("none");
  });

  it("returns {via:'push', sent:N} and prunes 404s", async () => {
    const { userId } = await createTestUser({ role: "member" });
    const db = drizzle(env.DB, { schema });
    await db.insert(pushSubscriptions).values({
      id: crypto.randomUUID(),
      userId,
      endpoint: "http://127.0.0.1:1/not-a-real-push-endpoint",
      p256dh: "BPqc0jv9h6cJmQmC2WQqIn-example-public-key-32-bytes==",
      auth: "dGVzdC1hdXRoLXNlY3JldA",
      userAgent: null,
      createdAt: Math.floor(Date.now() / 1000),
      lastUsedAt: null,
    });

    const stub = env.NOTIFICATIONS_HUB.get(
      env.NOTIFICATIONS_HUB.idFromName(userId),
    );
    const res = await stub.fetch(
      new Request("http://do/deliver", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(DELIVER_PAYLOAD),
      }),
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      via: string;
      sent: number;
      pruned: number;
    };
    expect(json.via).toBe("push");
    expect(typeof json.sent).toBe("number");
    expect(typeof json.pruned).toBe("number");
  });
});
