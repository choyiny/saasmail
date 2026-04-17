import { beforeEach, describe, expect, it } from "vitest";
import {
  applyMigrations,
  authFetch,
  cleanDb,
  createTestEmail,
  createTestPerson,
  createTestUser,
  getDb,
} from "./helpers";
import { senderIdentities } from "../db/sender-identities.schema";
import { inboxPermissions } from "../db/inbox-permissions.schema";
import { eq } from "drizzle-orm";

beforeEach(async () => {
  await applyMigrations();
  await cleanDb();
});

describe("admin inboxes router", () => {
  it("lists inboxes from emails.recipient ∪ sender_identities", async () => {
    const { apiKey } = await createTestUser({ role: "admin" });
    await createTestPerson();
    await createTestEmail({ recipient: "a@x.com" });
    const now = Math.floor(Date.now() / 1000);
    await getDb().insert(senderIdentities).values({
      email: "b@x.com",
      displayName: "Bee",
      createdAt: now,
      updatedAt: now,
    });
    const res = await authFetch("/api/admin/inboxes", { apiKey });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{
      email: string;
      displayName: string | null;
      assignedUserIds: string[];
    }>;
    const emails = body.map((b) => b.email).sort();
    expect(emails).toEqual(["a@x.com", "b@x.com"]);
  });

  it("returns 403 for non-admin caller", async () => {
    const { apiKey } = await createTestUser({
      id: "u-mem",
      role: "member",
      email: "m@x.com",
    });
    const res = await authFetch("/api/admin/inboxes", { apiKey });
    expect(res.status).toBe(403);
  });

  it("PATCH upserts display name into sender_identities", async () => {
    const { apiKey } = await createTestUser({ role: "admin" });
    await createTestPerson();
    await createTestEmail({ recipient: "a@x.com" });
    const res = await authFetch(
      `/api/admin/inboxes/${encodeURIComponent("a@x.com")}`,
      {
        apiKey,
        method: "PATCH",
        body: JSON.stringify({ displayName: "Alpha" }),
      },
    );
    expect(res.status).toBe(200);
    const rows = await getDb()
      .select()
      .from(senderIdentities)
      .where(eq(senderIdentities.email, "a@x.com"));
    expect(rows[0].displayName).toBe("Alpha");
  });

  it("PATCH clears display name when null is provided", async () => {
    const { apiKey } = await createTestUser({ role: "admin" });
    const now = Math.floor(Date.now() / 1000);
    await getDb().insert(senderIdentities).values({
      email: "a@x.com",
      displayName: "Alpha",
      displayMode: "thread", // ← add this line
      createdAt: now,
      updatedAt: now,
    });
    const res = await authFetch(
      `/api/admin/inboxes/${encodeURIComponent("a@x.com")}`,
      {
        apiKey,
        method: "PATCH",
        body: JSON.stringify({ displayName: null }),
      },
    );
    expect(res.status).toBe(200);
    const rows = await getDb()
      .select()
      .from(senderIdentities)
      .where(eq(senderIdentities.email, "a@x.com"));
    expect(rows).toHaveLength(0);
  });

  it("GET returns displayMode (defaulting to 'thread' when no row)", async () => {
    const { apiKey } = await createTestUser({ role: "admin" });
    await createTestPerson();
    await createTestEmail({ recipient: "a@x.com" });
    const now = Math.floor(Date.now() / 1000);
    await getDb().insert(senderIdentities).values({
      email: "b@x.com",
      displayName: "Bee",
      displayMode: "chat",
      createdAt: now,
      updatedAt: now,
    });
    const res = await authFetch("/api/admin/inboxes", { apiKey });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{
      email: string;
      displayName: string | null;
      displayMode: "thread" | "chat";
    }>;
    const byEmail = Object.fromEntries(body.map((b) => [b.email, b]));
    expect(byEmail["a@x.com"].displayMode).toBe("thread");
    expect(byEmail["b@x.com"].displayMode).toBe("chat");
  });

  it("PATCH persists displayMode independently of displayName", async () => {
    const { apiKey } = await createTestUser({ role: "admin" });
    await createTestPerson();
    await createTestEmail({ recipient: "a@x.com" });
    const res = await authFetch(
      `/api/admin/inboxes/${encodeURIComponent("a@x.com")}`,
      {
        apiKey,
        method: "PATCH",
        body: JSON.stringify({ displayMode: "chat" }),
      },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      email: string;
      displayName: string | null;
      displayMode: "thread" | "chat";
    };
    expect(body.displayMode).toBe("chat");
    expect(body.displayName).toBeNull();
    const rows = await getDb()
      .select()
      .from(senderIdentities)
      .where(eq(senderIdentities.email, "a@x.com"));
    expect(rows[0]?.displayMode).toBe("chat");
    expect(rows[0]?.displayName).toBeNull();
  });

  it("PATCH keeps the row when displayName=null but displayMode=chat", async () => {
    const { apiKey } = await createTestUser({ role: "admin" });
    const now = Math.floor(Date.now() / 1000);
    await getDb().insert(senderIdentities).values({
      email: "a@x.com",
      displayName: "Alpha",
      displayMode: "chat",
      createdAt: now,
      updatedAt: now,
    });
    const res = await authFetch(
      `/api/admin/inboxes/${encodeURIComponent("a@x.com")}`,
      {
        apiKey,
        method: "PATCH",
        body: JSON.stringify({ displayName: null }),
      },
    );
    expect(res.status).toBe(200);
    const rows = await getDb()
      .select()
      .from(senderIdentities)
      .where(eq(senderIdentities.email, "a@x.com"));
    expect(rows).toHaveLength(1);
    expect(rows[0].displayName).toBeNull();
    expect(rows[0].displayMode).toBe("chat");
  });

  it("PATCH deletes the row when both fields are at defaults", async () => {
    const { apiKey } = await createTestUser({ role: "admin" });
    const now = Math.floor(Date.now() / 1000);
    await getDb().insert(senderIdentities).values({
      email: "a@x.com",
      displayName: "Alpha",
      displayMode: "chat",
      createdAt: now,
      updatedAt: now,
    });
    const res = await authFetch(
      `/api/admin/inboxes/${encodeURIComponent("a@x.com")}`,
      {
        apiKey,
        method: "PATCH",
        body: JSON.stringify({ displayName: null, displayMode: "thread" }),
      },
    );
    expect(res.status).toBe(200);
    const rows = await getDb()
      .select()
      .from(senderIdentities)
      .where(eq(senderIdentities.email, "a@x.com"));
    expect(rows).toHaveLength(0);
  });

  it("PATCH returns 400 when neither field is provided", async () => {
    const { apiKey } = await createTestUser({ role: "admin" });
    const res = await authFetch(
      `/api/admin/inboxes/${encodeURIComponent("a@x.com")}`,
      {
        apiKey,
        method: "PATCH",
        body: JSON.stringify({}),
      },
    );
    expect(res.status).toBe(400);
  });

  it("PUT assignments replaces the full member set", async () => {
    const { apiKey } = await createTestUser({
      id: "u-admin",
      role: "admin",
      email: "admin@x.com",
    });
    await createTestUser({ id: "u-m1", role: "member", email: "m1@x.com" });
    await createTestUser({ id: "u-m2", role: "member", email: "m2@x.com" });
    await createTestUser({ id: "u-m3", role: "member", email: "m3@x.com" });
    const now = Math.floor(Date.now() / 1000);
    await getDb().insert(inboxPermissions).values({
      userId: "u-m3",
      email: "a@x.com",
      createdAt: now,
      createdBy: "u-admin",
    });

    const res = await authFetch(
      `/api/admin/inboxes/${encodeURIComponent("a@x.com")}/assignments`,
      {
        apiKey,
        method: "PUT",
        body: JSON.stringify({ userIds: ["u-m1", "u-m2"] }),
      },
    );
    expect(res.status).toBe(200);

    const rows = await getDb()
      .select()
      .from(inboxPermissions)
      .where(eq(inboxPermissions.email, "a@x.com"));
    const userIds = rows.map((r) => r.userId).sort();
    expect(userIds).toEqual(["u-m1", "u-m2"]);
  });
});
