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
import { senderIdentities } from "../db/sender-identities.schema";

describe("stats router", () => {
  let apiKey: string;

  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDb();
    ({ apiKey } = await createTestUser());
  });

  describe("GET /api/stats", () => {
    it("returns zero counts when empty", async () => {
      const res = await authFetch("/api/stats", { apiKey });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.totalPeople).toBe(0);
      expect(data.totalEmails).toBe(0);
      expect(data.unreadCount).toBe(0);
      expect(data.recipients).toEqual([]);
    });

    it("returns correct counts", async () => {
      await createTestPerson({ id: "s1", email: "a@test.com" });
      await createTestPerson({ id: "s2", email: "b@test.com" });
      await createTestEmail({
        id: "e1",
        personId: "s1",
        isRead: 0,
        recipient: "inbox@saasmail.test",
      });
      await createTestEmail({
        id: "e2",
        personId: "s2",
        isRead: 1,
        messageId: "msg-2@test.com",
        recipient: "inbox@saasmail.test",
      });
      await createTestEmail({
        id: "e3",
        personId: "s1",
        isRead: 0,
        messageId: "msg-3@test.com",
        recipient: "other@saasmail.test",
      });
      const now = Math.floor(Date.now() / 1000);
      await getDb()
        .insert(senderIdentities)
        .values([
          {
            email: "inbox@saasmail.test",
            displayName: null,
            createdAt: now,
            updatedAt: now,
          },
          {
            email: "other@saasmail.test",
            displayName: null,
            createdAt: now,
            updatedAt: now,
          },
        ]);

      const res = await authFetch("/api/stats", { apiKey });
      const data = await res.json();
      expect(data.totalPeople).toBe(2);
      expect(data.totalEmails).toBe(3);
      // One unread row (s1), even with unread mail at two inboxes.
      expect(data.unreadCount).toBe(1);
      expect(data.inboxUnread).toEqual({
        "inbox@saasmail.test": 1,
        "other@saasmail.test": 1,
      });
      expect(data.recipients).toContain("inbox@saasmail.test");
      expect(data.recipients).toContain("other@saasmail.test");
    });

    it("recipients comes from sender_identities, not received emails", async () => {
      // Seed a received email for an inbox that is NOT in sender_identities.
      await createTestPerson({ id: "s1", email: "a@test.com" });
      await createTestEmail({
        id: "e1",
        personId: "s1",
        recipient: "received-only@saasmail.test",
      });
      // And a sender_identity that has no received mail yet — e.g. freshly
      // created via POST /api/admin/inboxes.
      const now = Math.floor(Date.now() / 1000);
      await getDb().insert(senderIdentities).values({
        email: "created-only@saasmail.test",
        displayName: "Fresh",
        createdAt: now,
        updatedAt: now,
      });

      const res = await authFetch("/api/stats", { apiKey });
      const data = await res.json();
      expect(data.recipients).toEqual(["created-only@saasmail.test"]);
      expect(data.recipients).not.toContain("received-only@saasmail.test");
    });

    it("filters by recipient", async () => {
      await createTestPerson({ id: "s1", email: "a@test.com" });
      await createTestEmail({
        id: "e1",
        personId: "s1",
        isRead: 0,
        recipient: "inbox@saasmail.test",
      });
      await createTestEmail({
        id: "e2",
        personId: "s1",
        isRead: 0,
        messageId: "msg-2@test.com",
        recipient: "other@saasmail.test",
      });

      const res = await authFetch(
        "/api/stats?recipient=inbox%40saasmail.test",
        {
          apiKey,
        },
      );
      const data = await res.json();
      expect(data.totalEmails).toBe(1);
      expect(data.unreadCount).toBe(1);
    });
  });

  describe("GET /api/stats — unread counts follow the Inbox folder", () => {
    beforeEach(async () => {
      // p-a: two unread messages (one row); p-b, p-c, p-d: one unread each;
      // p-read: read; conv1: a group thread with one unread message.
      for (const id of ["p-a", "p-b", "p-c", "p-d", "p-read"]) {
        await createTestPerson({ id, email: `${id}@test.com` });
      }
      await createTestEmail({ id: "a1", personId: "p-a", messageId: "a1@x" });
      await createTestEmail({ id: "a2", personId: "p-a", messageId: "a2@x" });
      await createTestEmail({ id: "b1", personId: "p-b", messageId: "b1@x" });
      await createTestEmail({ id: "c1", personId: "p-c", messageId: "c1@x" });
      await createTestEmail({ id: "d1", personId: "p-d", messageId: "d1@x" });
      await createTestEmail({
        id: "r1",
        personId: "p-read",
        messageId: "r1@x",
        isRead: 1,
      });
      await createTestEmail({
        id: "g1",
        personId: "p-read",
        messageId: "g1@x",
        conversationId: "conv1",
        recipient: "team@saasmail.test",
      });
    });

    async function stats() {
      const res = await authFetch("/api/stats", { apiKey });
      expect(res.status).toBe(200);
      return (await res.json()) as {
        unreadCount: number;
        inboxUnread: Record<string, number>;
      };
    }

    async function inboxUnreadIds() {
      const res = await authFetch("/api/people/grouped?folder=inbox&unread=1", {
        apiKey,
      });
      return ((await res.json()).data as Array<{ id: string }>).map(
        (r) => r.id,
      );
    }

    it("counts unread rows, not unread messages", async () => {
      const data = await stats();
      expect(data.unreadCount).toBe(5);
      expect(data.inboxUnread).toEqual({
        "inbox@saasmail.test": 4,
        "team@saasmail.test": 1,
      });
      expect(data.unreadCount).toBe((await inboxUnreadIds()).length);
    });

    it("narrows unreadCount to ?recipient=", async () => {
      const res = await authFetch("/api/stats?recipient=team%40saasmail.test", {
        apiKey,
      });
      expect((await res.json()).unreadCount).toBe(1);
    });
  });
});
