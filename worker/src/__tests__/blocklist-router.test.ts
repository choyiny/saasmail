import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import {
  authFetch,
  createTestUser,
  getDb,
  applyMigrations,
  cleanDb,
} from "./helpers";
import { blocklist } from "../db/blocklist.schema";
import { senderIdentities } from "../db/sender-identities.schema";

beforeAll(applyMigrations);
beforeEach(cleanDb);

describe("blocklist router", () => {
  it("POST creates an email rule (lowercased)", async () => {
    const { apiKey } = await createTestUser();
    const r = await authFetch("/api/blocklist", {
      apiKey,
      method: "POST",
      body: JSON.stringify({ type: "email", value: "SPAM@Evil.com" }),
    });
    expect(r.status).toBe(201);
    const body = (await r.json()) as {
      type: string;
      value: string;
      createdBy: string;
    };
    expect(body).toMatchObject({ type: "email", value: "spam@evil.com" });
    expect(body.createdBy).toBe("test@example.com");
  });

  it("POST is idempotent on (type, value)", async () => {
    const { apiKey } = await createTestUser();
    const payload = JSON.stringify({ type: "domain", value: "evil.com" });
    await authFetch("/api/blocklist", {
      apiKey,
      method: "POST",
      body: payload,
    });
    const r = await authFetch("/api/blocklist", {
      apiKey,
      method: "POST",
      body: payload,
    });
    expect([200, 201]).toContain(r.status);
    const rows = await getDb().query.blocklist.findMany();
    expect(rows.filter((x) => x.value === "evil.com")).toHaveLength(1);
  });

  it("POST rejects blocking our own sending domain (self-lockout guard)", async () => {
    const { apiKey } = await createTestUser();
    await getDb().insert(senderIdentities).values({
      email: "me@ourdomain.com",
      createdAt: 1,
      updatedAt: 1,
    });
    const r = await authFetch("/api/blocklist", {
      apiKey,
      method: "POST",
      body: JSON.stringify({ type: "domain", value: "ourdomain.com" }),
    });
    expect(r.status).toBe(400);
  });

  it("POST rejects blocking our own address", async () => {
    const { apiKey } = await createTestUser();
    await getDb().insert(senderIdentities).values({
      email: "me@ourdomain.com",
      createdAt: 1,
      updatedAt: 1,
    });
    const r = await authFetch("/api/blocklist", {
      apiKey,
      method: "POST",
      body: JSON.stringify({ type: "email", value: "me@ourdomain.com" }),
    });
    expect(r.status).toBe(400);
  });

  it("GET lists rules newest first; DELETE removes one", async () => {
    const { apiKey } = await createTestUser();
    await getDb().insert(blocklist).values({
      id: "blk-1",
      type: "email",
      value: "a@evil.com",
      createdAt: 100,
    });
    const list = await authFetch("/api/blocklist", { apiKey });
    const body = (await list.json()) as { items: Array<{ id: string }> };
    expect(body.items.map((i) => i.id)).toContain("blk-1");

    const del = await authFetch("/api/blocklist/blk-1", {
      apiKey,
      method: "DELETE",
    });
    expect(del.status).toBe(200);
    expect(await getDb().query.blocklist.findMany()).toHaveLength(0);
  });
});
