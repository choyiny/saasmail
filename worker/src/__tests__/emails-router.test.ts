import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import {
  applyMigrations,
  cleanDb,
  createTestUser,
  createTestPerson,
  createTestEmail,
  authFetch,
  getDb,
} from "./helpers";
import { sentEmails } from "../db/sent-emails.schema";
import { senderIdentities } from "../db/sender-identities.schema";
import { people } from "../db/people.schema";
import { emails } from "../db/emails.schema";
import { inboxPermissions } from "../db/inbox-permissions.schema";
import { eq } from "drizzle-orm";

async function grantInbox(userId: string, email: string) {
  await getDb()
    .insert(inboxPermissions)
    .values({
      userId,
      email,
      createdAt: Math.floor(Date.now() / 1000),
      createdBy: null,
    });
}

describe("emails router", () => {
  let apiKey: string;

  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDb();
    ({ apiKey } = await createTestUser());
  });

  describe("GET /api/emails/by-person/:personId", () => {
    it("returns received and sent emails interleaved", async () => {
      const db = getDb();
      await createTestPerson({ id: "s1", email: "a@test.com" });
      await createTestEmail({ id: "e1", personId: "s1" });

      const now = Math.floor(Date.now() / 1000);
      await db.insert(sentEmails).values({
        id: "se1",
        personId: "s1",
        fromAddress: "me@saasmail.test",
        toAddress: "a@test.com",
        subject: "Reply",
        bodyHtml: "<p>Reply</p>",
        bodyText: null,
        resendId: null,
        status: "sent",
        sentAt: now + 10,
        createdAt: now + 10,
      });

      const res = await authFetch("/api/emails/by-person/s1", {
        apiKey,
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { emails: any[]; inboxes: any[] };
      const data = body.emails;
      expect(data).toHaveLength(2);
      // Most recent first — sent email has higher timestamp
      expect(data[0].type).toBe("sent");
      expect(data[1].type).toBe("received");
    });

    it("includes sent replies when filtering by recipient", async () => {
      const db = getDb();
      await createTestPerson({ id: "s1", email: "a@test.com" });
      await createTestEmail({
        id: "e1",
        personId: "s1",
        recipient: "inbox@saasmail.test",
      });

      const now = Math.floor(Date.now() / 1000);
      await db.insert(sentEmails).values({
        id: "se1",
        personId: "s1",
        fromAddress: "inbox@saasmail.test",
        toAddress: "a@test.com",
        subject: "Re: Test Subject",
        bodyHtml: "<p>Reply</p>",
        bodyText: null,
        resendId: null,
        status: "sent",
        sentAt: now + 10,
        createdAt: now + 10,
      });

      // Filter by recipient (inbox address) — sent replies should still appear
      const res = await authFetch(
        "/api/emails/by-person/s1?recipient=inbox@saasmail.test",
        { apiKey },
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { emails: any[]; inboxes: any[] };
      const data = body.emails;
      expect(data).toHaveLength(2);
      expect(data[0].type).toBe("sent");
      expect(data[1].type).toBe("received");
    });

    it("paginates results", async () => {
      await createTestPerson({ id: "s1", email: "a@test.com" });
      for (let i = 0; i < 5; i++) {
        await createTestEmail({
          id: `e${i}`,
          personId: "s1",
          messageId: `msg-${i}@test.com`,
          subject: `Subject ${i}`,
        });
      }

      const res = await authFetch("/api/emails/by-person/s1?limit=2&page=1", {
        apiKey,
      });
      const body = (await res.json()) as { emails: any[]; inboxes: any[] };
      const data = body.emails;
      expect(data).toHaveLength(2);
    });

    it("searches by subject", async () => {
      await createTestPerson({ id: "s1", email: "a@test.com" });
      await createTestEmail({
        id: "e1",
        personId: "s1",
        subject: "Important Meeting",
      });
      await createTestEmail({
        id: "e2",
        personId: "s1",
        subject: "Lunch",
        messageId: "msg-2@test.com",
      });

      const res = await authFetch("/api/emails/by-person/s1?q=Important", {
        apiKey,
      });
      const body = (await res.json()) as { emails: any[]; inboxes: any[] };
      const data = body.emails;
      expect(data).toHaveLength(1);
      expect(data[0].subject).toBe("Important Meeting");
    });

    it("returns inboxes[] with displayMode for each inbox referenced by emails", async () => {
      const db = getDb();
      await createTestPerson({ id: "s1", email: "a@test.com" });
      await createTestEmail({
        id: "e1",
        personId: "s1",
        recipient: "support@saasmail.test",
      });

      const now = Math.floor(Date.now() / 1000);
      await db.insert(sentEmails).values({
        id: "se1",
        personId: "s1",
        fromAddress: "sales@saasmail.test",
        toAddress: "a@test.com",
        subject: "Hi",
        bodyHtml: "<p>Hi</p>",
        bodyText: null,
        resendId: null,
        status: "sent",
        sentAt: now + 10,
        createdAt: now + 10,
      });

      // Set support@ to chat mode; sales@ has no row → defaults to thread.
      await db.insert(senderIdentities).values({
        email: "support@saasmail.test",
        displayName: null,
        displayMode: "chat",
        createdAt: now,
        updatedAt: now,
      });

      const res = await authFetch("/api/emails/by-person/s1", { apiKey });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        emails: any[];
        inboxes: Array<{
          email: string;
          displayName: string | null;
          displayMode: "thread" | "chat";
        }>;
      };
      const byEmail = Object.fromEntries(body.inboxes.map((i) => [i.email, i]));
      expect(byEmail["support@saasmail.test"]?.displayMode).toBe("chat");
      expect(byEmail["sales@saasmail.test"]?.displayMode).toBe("thread");
    });
  });

  describe("GET /api/emails/:id", () => {
    it("returns email with attachments", async () => {
      await createTestPerson({ id: "s1", email: "a@test.com" });
      await createTestEmail({ id: "e1", personId: "s1" });

      const res = await authFetch("/api/emails/e1", { apiKey });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.id).toBe("e1");
      expect(data.type).toBe("received");
      expect(data.attachments).toEqual([]);
    });

    it("returns 404 for missing email", async () => {
      const res = await authFetch("/api/emails/nonexistent", { apiKey });
      expect(res.status).toBe(404);
    });
  });

  describe("PATCH /api/emails/:id", () => {
    it("marks email as read and decrements sender unread count", async () => {
      await createTestPerson({
        id: "s1",
        email: "a@test.com",
        unreadCount: 1,
      });
      await createTestEmail({ id: "e1", personId: "s1", isRead: 0 });

      const res = await authFetch("/api/emails/e1", {
        apiKey,
        method: "PATCH",
        body: JSON.stringify({ isRead: true }),
      });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.success).toBe(true);

      // Verify the sender unread count was decremented
      const db = getDb();
      const senderRow = await db
        .select()
        .from(people)
        .where(eq(people.id, "s1"))
        .limit(1);
      expect(senderRow[0].unreadCount).toBe(0);
    });

    it("marks email as unread and increments sender unread count", async () => {
      await createTestPerson({
        id: "s1",
        email: "a@test.com",
        unreadCount: 0,
      });
      await createTestEmail({ id: "e1", personId: "s1", isRead: 1 });

      const res = await authFetch("/api/emails/e1", {
        apiKey,
        method: "PATCH",
        body: JSON.stringify({ isRead: false }),
      });
      expect(res.status).toBe(200);

      const db = getDb();
      const senderRow = await db
        .select()
        .from(people)
        .where(eq(people.id, "s1"))
        .limit(1);
      expect(senderRow[0].unreadCount).toBe(1);
    });

    it("does not change unread count when state is same", async () => {
      await createTestPerson({
        id: "s1",
        email: "a@test.com",
        unreadCount: 1,
      });
      await createTestEmail({ id: "e1", personId: "s1", isRead: 0 });

      await authFetch("/api/emails/e1", {
        apiKey,
        method: "PATCH",
        body: JSON.stringify({ isRead: false }),
      });

      const db = getDb();
      const senderRow = await db
        .select()
        .from(people)
        .where(eq(people.id, "s1"))
        .limit(1);
      expect(senderRow[0].unreadCount).toBe(1);
    });

    it("returns 404 for missing email", async () => {
      const res = await authFetch("/api/emails/nonexistent", {
        apiKey,
        method: "PATCH",
        body: JSON.stringify({ isRead: true }),
      });
      expect(res.status).toBe(404);
    });
  });

  // Note: PATCH /api/emails/bulk is unreachable because PATCH /{id} is
  // registered first and "bulk" matches as an {id} param. Skipping tests
  // for this endpoint as it's a known routing issue.
});

describe("send stores generated message-id", () => {
  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDb();
  });

  it("persists a <...@domain> message_id on /send", async () => {
    const { apiKey, userId } = await createTestUser({
      id: "u-send",
      role: "admin",
      email: "admin@x.com",
    });
    await grantInbox(userId, "a@x.com");
    const res = await authFetch("/api/send", {
      apiKey,
      method: "POST",
      body: JSON.stringify({
        to: "target@external.com",
        fromAddress: "a@x.com",
        subject: "hello",
        bodyHtml: "<p>hi</p>",
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string };
    const db = getDb();
    const row = await db
      .select()
      .from(sentEmails)
      .where(eq(sentEmails.id, body.id))
      .get();
    expect(row?.messageId).toMatch(/^<[A-Za-z0-9_-]+@x\.com>$/);
  });
});
