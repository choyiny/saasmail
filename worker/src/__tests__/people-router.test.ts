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
import { blocklist } from "../db/blocklist.schema";

describe("people router", () => {
  let apiKey: string;

  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDb();
    ({ apiKey } = await createTestUser());
  });

  describe("GET /api/people", () => {
    it("returns empty list when no people", async () => {
      const res = await authFetch("/api/people", { apiKey });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data).toEqual([]);
    });

    it("returns people sorted by lastEmailAt desc", async () => {
      await createTestPerson({ id: "s1", email: "a@test.com", name: "A" });
      await createTestPerson({ id: "s2", email: "b@test.com", name: "B" });
      await createTestEmail({ id: "e1", personId: "s1" });
      await createTestEmail({
        id: "e2",
        personId: "s2",
        messageId: "msg-2@example.com",
      });

      const res = await authFetch("/api/people", { apiKey });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data).toHaveLength(2);
    });

    it("searches by name", async () => {
      await createTestPerson({ id: "s1", email: "a@test.com", name: "Alice" });
      await createTestPerson({ id: "s2", email: "b@test.com", name: "Bob" });
      await createTestEmail({ id: "e1", personId: "s1" });
      await createTestEmail({
        id: "e2",
        personId: "s2",
        messageId: "msg-2@example.com",
      });

      const res = await authFetch("/api/people?q=alice", { apiKey });
      const body = await res.json();
      expect(body.data).toHaveLength(1);
      expect(body.data[0].name).toBe("Alice");
    });

    it("searches by email", async () => {
      await createTestPerson({
        id: "s1",
        email: "alice@test.com",
        name: "Alice",
      });
      await createTestPerson({ id: "s2", email: "bob@test.com", name: "Bob" });
      await createTestEmail({ id: "e1", personId: "s1" });
      await createTestEmail({
        id: "e2",
        personId: "s2",
        messageId: "msg-2@example.com",
      });

      const res = await authFetch("/api/people?q=bob%40test", { apiKey });
      const body = await res.json();
      expect(body.data).toHaveLength(1);
      expect(body.data[0].email).toBe("bob@test.com");
    });

    it("paginates results", async () => {
      await createTestPerson({ id: "s1", email: "a@test.com" });
      await createTestPerson({ id: "s2", email: "b@test.com" });
      await createTestPerson({ id: "s3", email: "c@test.com" });
      await createTestEmail({ id: "e1", personId: "s1" });
      await createTestEmail({
        id: "e2",
        personId: "s2",
        messageId: "msg-2@example.com",
      });
      await createTestEmail({
        id: "e3",
        personId: "s3",
        messageId: "msg-3@example.com",
      });

      const res = await authFetch("/api/people?page=1&limit=2", {
        apiKey,
      });
      const body = await res.json();
      expect(body.data).toHaveLength(2);
    });

    it("includes latestSubject from most recent email", async () => {
      await createTestPerson({ id: "s1", email: "a@test.com" });
      await createTestEmail({
        id: "e1",
        personId: "s1",
        subject: "Latest Subject",
      });

      const res = await authFetch("/api/people", { apiKey });
      const body = await res.json();
      expect(body.data[0].latestSubject).toBe("Latest Subject");
    });

    it("filters by recipient", async () => {
      await createTestPerson({ id: "s1", email: "a@test.com" });
      await createTestPerson({ id: "s2", email: "b@test.com" });
      await createTestEmail({
        id: "e1",
        personId: "s1",
        recipient: "inbox@saasmail.test",
      });
      await createTestEmail({
        id: "e2",
        personId: "s2",
        recipient: "other@saasmail.test",
        messageId: "msg-2@example.com",
      });

      const res = await authFetch(
        "/api/people?recipient=inbox%40saasmail.test",
        {
          apiKey,
        },
      );
      const body = await res.json();
      expect(body.data).toHaveLength(1);
      expect(body.data[0].id).toBe("s1");
    });
  });

  describe("GET /api/people/:id", () => {
    it("returns person by id", async () => {
      await createTestPerson({ id: "s1", email: "a@test.com", name: "Alice" });

      const res = await authFetch("/api/people/s1", { apiKey });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.email).toBe("a@test.com");
      expect(data.name).toBe("Alice");
    });

    it("returns 404 for unknown person", async () => {
      const res = await authFetch("/api/people/unknown", { apiKey });
      expect(res.status).toBe(404);
    });
  });

  describe("GET /api/people/grouped — sort direction + aggregates", () => {
    it("returns aggregates over the filtered set, not just the page", async () => {
      // Three people: two unread, one with attachments. Aggregates
      // should reflect the whole set even when limit=1.
      await createTestPerson({
        id: "s1",
        email: "alice@test.com",
        name: "Alice",
      });
      await createTestPerson({ id: "s2", email: "bob@test.com", name: "Bob" });
      await createTestPerson({
        id: "s3",
        email: "carol@test.com",
        name: "Carol",
      });
      await createTestEmail({ id: "e1", personId: "s1", isRead: 0 });
      await createTestEmail({
        id: "e2",
        personId: "s2",
        isRead: 0,
        messageId: "msg-2@example.com",
      });
      await createTestEmail({
        id: "e3",
        personId: "s3",
        isRead: 1,
        messageId: "msg-3@example.com",
      });

      const res = await authFetch("/api/people/grouped?limit=1", { apiKey });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data).toHaveLength(1);
      expect(body.total).toBe(3);
      expect(body.aggregates.unreadRowCount).toBe(2); // s1 + s2
      expect(body.aggregates.totalUnreadEmails).toBe(2); // one each
      expect(body.aggregates.attachmentRowCount).toBe(0);
      expect(body.aggregates.multiInboxRowCount).toBe(0);
    });

    it("sorts inbox ascending by default (the natural direction)", async () => {
      await createTestPerson({ id: "s1", email: "a@test.com" });
      await createTestPerson({ id: "s2", email: "b@test.com" });
      await createTestEmail({
        id: "e1",
        personId: "s1",
        recipient: "support@saasmail.test",
      });
      await createTestEmail({
        id: "e2",
        personId: "s2",
        recipient: "alpha@saasmail.test",
        messageId: "msg-2@example.com",
      });

      const res = await authFetch("/api/people/grouped?sort=inbox", {
        apiKey,
      });
      const body = await res.json();
      expect(body.data[0].recipients?.[0]).toBe("alpha@saasmail.test");
      expect(body.data[1].recipients?.[0]).toBe("support@saasmail.test");
    });

    it("flips the sort order when direction=desc on inbox sort", async () => {
      await createTestPerson({ id: "s1", email: "a@test.com" });
      await createTestPerson({ id: "s2", email: "b@test.com" });
      await createTestEmail({
        id: "e1",
        personId: "s1",
        recipient: "support@saasmail.test",
      });
      await createTestEmail({
        id: "e2",
        personId: "s2",
        recipient: "alpha@saasmail.test",
        messageId: "msg-2@example.com",
      });

      const res = await authFetch(
        "/api/people/grouped?sort=inbox&direction=desc",
        { apiKey },
      );
      const body = await res.json();
      expect(body.data[0].recipients?.[0]).toBe("support@saasmail.test");
      expect(body.data[1].recipients?.[0]).toBe("alpha@saasmail.test");
    });

    it("excludes blocked senders (email + domain) from grouped results and aggregates", async () => {
      await createTestPerson({
        id: "p-block-email",
        email: "spam@evil.com",
        unreadCount: 1,
      });
      await createTestEmail({
        id: "e-be",
        personId: "p-block-email",
        messageId: "m-be@evil.com",
      });

      await createTestPerson({
        id: "p-block-domain",
        email: "x@bad.com",
        unreadCount: 1,
      });
      await createTestEmail({
        id: "e-bd",
        personId: "p-block-domain",
        messageId: "m-bd@bad.com",
      });

      await createTestPerson({
        id: "p-keep",
        email: "ok@nice.com",
        unreadCount: 1,
      });
      await createTestEmail({
        id: "e-keep",
        personId: "p-keep",
        messageId: "m-keep@nice.com",
      });

      await getDb()
        .insert(blocklist)
        .values([
          { id: "b1", type: "email", value: "spam@evil.com", createdAt: 1 },
          { id: "b2", type: "domain", value: "bad.com", createdAt: 2 },
        ]);

      const r = await authFetch("/api/people/grouped", { apiKey });
      const body = (await r.json()) as {
        data: Array<{ id: string; email: string }>;
        aggregates: { unreadRowCount: number };
      };
      const ids = body.data.map((d) => d.id);
      expect(ids).toContain("p-keep");
      expect(ids).not.toContain("p-block-email");
      expect(ids).not.toContain("p-block-domain");
      expect(body.aggregates.unreadRowCount).toBe(1); // only p-keep counts
    });

    it("flips recency to ascending (oldest first) when direction=asc", async () => {
      // Two persons, second one has the more recent email by default
      // (timestamps assigned at insert time).
      await createTestPerson({ id: "s1", email: "a@test.com" });
      await createTestPerson({ id: "s2", email: "b@test.com" });
      await createTestEmail({ id: "e1", personId: "s1" });
      // Force e2 to be "newer" by waiting a tick — createTestEmail uses
      // floor(Date.now()/1000) so close-together calls can collide.
      await new Promise((r) => setTimeout(r, 1100));
      await createTestEmail({
        id: "e2",
        personId: "s2",
        messageId: "msg-2@example.com",
      });

      const desc = await authFetch("/api/people/grouped", { apiKey }).then(
        (r) => r.json(),
      );
      expect(desc.data[0].id).toBe("s2");

      const asc = await authFetch("/api/people/grouped?direction=asc", {
        apiKey,
      }).then((r) => r.json());
      expect(asc.data[0].id).toBe("s1");
    });
  });
});
