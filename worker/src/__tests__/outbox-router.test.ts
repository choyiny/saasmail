import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import {
  applyMigrations,
  cleanDb,
  createTestUser,
  authFetch,
  getDb,
} from "./helpers";
import { outboxEmails } from "../db/outbox-emails.schema";
import { sentEmails } from "../db/sent-emails.schema";
import { inboxPermissions } from "../db/inbox-permissions.schema";

async function seedRow(
  id: string,
  opts: {
    fromAddress?: string;
    status?: string;
    /** Offset in seconds from now (negative = older). */
    createdAtOffset?: number;
  } = {},
) {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  const createdAt = now + (opts.createdAtOffset ?? 0);
  await db.insert(sentEmails).values({
    id: `sent-${id}`,
    personId: null,
    fromAddress: opts.fromAddress ?? "me@saasmail.test",
    toAddress: "to@example.com",
    subject: "Hi",
    status: "retrying",
    sentAt: createdAt,
    createdAt,
  });
  await db.insert(outboxEmails).values({
    id,
    sentEmailId: `sent-${id}`,
    fromAddress: opts.fromAddress ?? "me@saasmail.test",
    toAddress: "to@example.com",
    subject: "Hi",
    bodyHtml: "<p>Hi</p>",
    transactional: 1,
    status: opts.status ?? "pending",
    attempts: 1,
    lastError: "quota exceeded",
    nextRetryAt: createdAt - 10,
    createdAt,
    updatedAt: createdAt,
  });
}

describe("outbox router", () => {
  let apiKey: string;

  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDb();
    ({ apiKey } = await createTestUser());
  });

  it("lists outbox rows newest first", async () => {
    // Use distinct createdAt values so ordering is deterministic.
    await seedRow("ob-1", { createdAtOffset: -10 }); // older
    await seedRow("ob-2", { status: "failed", createdAtOffset: 0 }); // newer
    const res = await authFetch("/api/outbox", { apiKey });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: Array<{ id: string; status: string; lastError: string | null }>;
      nextCursor: string | null;
    };
    expect(body.items).toHaveLength(2);
    // Newest first: ob-2 (offset 0) before ob-1 (offset -10).
    expect(body.items[0].id).toBe("ob-2");
    expect(body.items[1].id).toBe("ob-1");
    expect(body.items[0].lastError).toBe("quota exceeded");
  });

  it("scopes the list to allowed inboxes for members", async () => {
    await seedRow("ob-1", { fromAddress: "me@saasmail.test" });
    await seedRow("ob-2", { fromAddress: "other@saasmail.test" });
    const { apiKey: memberKey, userId } = await createTestUser({
      id: "member-1",
      role: "member",
      email: "member@example.com",
    });
    const db = getDb();
    await db.insert(inboxPermissions).values({
      userId,
      email: "me@saasmail.test",
      createdAt: Math.floor(Date.now() / 1000),
    });
    const res = await authFetch("/api/outbox", { apiKey: memberKey });
    const body = (await res.json()) as { items: Array<{ id: string }> };
    expect(body.items).toHaveLength(1);
    expect(body.items[0].id).toBe("ob-1");
  });

  it("counts pending rows", async () => {
    await seedRow("ob-1", { status: "pending" });
    await seedRow("ob-2", { status: "failed" });
    const res = await authFetch("/api/outbox/count", { apiKey });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ pending: 1 });
  });

  it("cancels a row: deletes it and fails the sent email", async () => {
    await seedRow("ob-1");
    const res = await authFetch("/api/outbox/ob-1", {
      apiKey,
      method: "DELETE",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: true });
    const db = getDb();
    expect(await db.select().from(outboxEmails)).toHaveLength(0);
    const sent = await db
      .select()
      .from(sentEmails)
      .where(eq(sentEmails.id, "sent-ob-1"));
    expect(sent[0].status).toBe("failed");
  });

  it("403s cancel/retry for rows outside a member's inboxes", async () => {
    await seedRow("ob-1", { fromAddress: "other@saasmail.test" });
    const { apiKey: memberKey } = await createTestUser({
      id: "member-2",
      role: "member",
      email: "member2@example.com",
    });
    const del = await authFetch("/api/outbox/ob-1", {
      apiKey: memberKey,
      method: "DELETE",
    });
    expect(del.status).toBe(403);
    const retry = await authFetch("/api/outbox/ob-1/retry", {
      apiKey: memberKey,
      method: "POST",
    });
    expect(retry.status).toBe(403);
  });

  it("refuses to retry a pending row that is mid-claim (next_retry_at in the future)", async () => {
    await seedRow("ob-1");
    const db = getDb();
    await db
      .update(outboxEmails)
      .set({ nextRetryAt: Math.floor(Date.now() / 1000) + 3600 })
      .where(eq(outboxEmails.id, "ob-1"));
    const res = await authFetch("/api/outbox/ob-1/retry", {
      apiKey,
      method: "POST",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ outcome: "pending" });
    const rows = await db.select().from(outboxEmails);
    expect(rows[0].attempts).toBe(1); // untouched — no new attempt was made
  });

  it("paginates tie-break rows (same createdAt) without duplicates or losses", async () => {
    // All three rows share the same createdAt second → tie-break on id.
    await seedRow("aa-1", { createdAtOffset: 0 });
    await seedRow("bb-2", { createdAtOffset: 0 });
    await seedRow("cc-3", { createdAtOffset: 0 });

    // Page 1: limit=2
    const res1 = await authFetch("/api/outbox?limit=2", { apiKey });
    expect(res1.status).toBe(200);
    const page1 = (await res1.json()) as {
      items: Array<{ id: string }>;
      nextCursor: string | null;
    };
    expect(page1.items).toHaveLength(2);
    expect(page1.nextCursor).not.toBeNull();

    // Page 2: follow the cursor
    const res2 = await authFetch(
      `/api/outbox?limit=2&cursor=${encodeURIComponent(page1.nextCursor!)}`,
      { apiKey },
    );
    expect(res2.status).toBe(200);
    const page2 = (await res2.json()) as {
      items: Array<{ id: string }>;
      nextCursor: string | null;
    };
    expect(page2.items).toHaveLength(1);
    expect(page2.nextCursor).toBeNull();

    // All 3 distinct ids, no duplicates.
    const allIds = [
      ...page1.items.map((i) => i.id),
      ...page2.items.map((i) => i.id),
    ];
    expect(new Set(allIds).size).toBe(3);
    expect(allIds.sort()).toEqual(["aa-1", "bb-2", "cc-3"]);
  });

  it("returns 404 for retry on a nonexistent id", async () => {
    const res = await authFetch("/api/outbox/does-not-exist/retry", {
      apiKey,
      method: "POST",
    });
    expect(res.status).toBe(404);
  });

  it("returns 404 for cancel on a nonexistent id", async () => {
    const res = await authFetch("/api/outbox/does-not-exist", {
      apiKey,
      method: "DELETE",
    });
    expect(res.status).toBe(404);
  });

  it("refuses to cancel a row that is mid-claim (next_retry_at in the future)", async () => {
    const db = getDb();
    const now = Math.floor(Date.now() / 1000);
    // Seed with nextRetryAt in the future (mid-claim)
    await db.insert(sentEmails).values({
      id: "sent-midclaim",
      personId: null,
      fromAddress: "me@saasmail.test",
      toAddress: "to@example.com",
      subject: "Hi",
      status: "retrying",
      sentAt: now,
      createdAt: now,
    });
    await db.insert(outboxEmails).values({
      id: "ob-midclaim",
      sentEmailId: "sent-midclaim",
      fromAddress: "me@saasmail.test",
      toAddress: "to@example.com",
      subject: "Hi",
      bodyHtml: "<p>Hi</p>",
      transactional: 1,
      status: "pending",
      attempts: 1,
      lastError: "quota exceeded",
      nextRetryAt: now + 3600,
      createdAt: now,
      updatedAt: now,
    });

    const res = await authFetch("/api/outbox/ob-midclaim", {
      apiKey,
      method: "DELETE",
    });
    expect(res.status).toBe(409);

    // Row still exists
    const rows = await db
      .select()
      .from(outboxEmails)
      .where(eq(outboxEmails.id, "ob-midclaim"));
    expect(rows).toHaveLength(1);

    // sentEmails status unchanged
    const sent = await db
      .select()
      .from(sentEmails)
      .where(eq(sentEmails.id, "sent-midclaim"));
    expect(sent[0].status).toBe("retrying");
  });

  it("manually retries a failed row with a fresh attempt budget", async () => {
    // No provider configured → NoopSender permanent error → outcome failed,
    // but the row must have been re-attempted (attempts reset to 0, then 1).
    const { env } = await import("cloudflare:workers");
    (env as any).DEMO_MODE = "0";
    const savedKey = (env as any).RESEND_API_KEY;
    const savedEmail = (env as any).EMAIL;
    (env as any).RESEND_API_KEY = undefined;
    (env as any).EMAIL = undefined;
    try {
      await seedRow("ob-1", { status: "failed" });
      const db = getDb();
      await db
        .update(outboxEmails)
        .set({ attempts: 24 })
        .where(eq(outboxEmails.id, "ob-1"));
      const res = await authFetch("/api/outbox/ob-1/retry", {
        apiKey,
        method: "POST",
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { outcome: string };
      expect(body.outcome).toBe("failed");
      const rows = await db.select().from(outboxEmails);
      expect(rows[0].attempts).toBe(1);
    } finally {
      (env as any).RESEND_API_KEY = savedKey;
      (env as any).EMAIL = savedEmail;
    }
  });
});
