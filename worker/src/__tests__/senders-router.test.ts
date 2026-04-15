import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import {
  applyMigrations,
  cleanDb,
  createTestUser,
  createTestSender,
  createTestEmail,
  authFetch,
} from "./helpers";

describe("senders router", () => {
  let apiKey: string;

  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDb();
    ({ apiKey } = await createTestUser());
  });

  describe("GET /api/senders", () => {
    it("returns empty list when no senders", async () => {
      const res = await authFetch("/api/senders", { apiKey });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data).toEqual([]);
    });

    it("returns senders sorted by lastEmailAt desc", async () => {
      const now = Math.floor(Date.now() / 1000);
      await createTestSender({ id: "s1", email: "a@test.com", name: "A" });
      await createTestSender({ id: "s2", email: "b@test.com", name: "B" });

      const res = await authFetch("/api/senders", { apiKey });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data).toHaveLength(2);
    });

    it("searches by name", async () => {
      await createTestSender({ id: "s1", email: "a@test.com", name: "Alice" });
      await createTestSender({ id: "s2", email: "b@test.com", name: "Bob" });

      const res = await authFetch("/api/senders?q=alice", { apiKey });
      const data = await res.json();
      expect(data).toHaveLength(1);
      expect(data[0].name).toBe("Alice");
    });

    it("searches by email", async () => {
      await createTestSender({
        id: "s1",
        email: "alice@test.com",
        name: "Alice",
      });
      await createTestSender({ id: "s2", email: "bob@test.com", name: "Bob" });

      const res = await authFetch("/api/senders?q=bob%40test", { apiKey });
      const data = await res.json();
      expect(data).toHaveLength(1);
      expect(data[0].email).toBe("bob@test.com");
    });

    it("paginates results", async () => {
      await createTestSender({ id: "s1", email: "a@test.com" });
      await createTestSender({ id: "s2", email: "b@test.com" });
      await createTestSender({ id: "s3", email: "c@test.com" });

      const res = await authFetch("/api/senders?page=1&limit=2", {
        apiKey,
      });
      const data = await res.json();
      expect(data).toHaveLength(2);
    });

    it("includes latestSubject from most recent email", async () => {
      await createTestSender({ id: "s1", email: "a@test.com" });
      await createTestEmail({
        id: "e1",
        senderId: "s1",
        subject: "Latest Subject",
      });

      const res = await authFetch("/api/senders", { apiKey });
      const data = await res.json();
      expect(data[0].latestSubject).toBe("Latest Subject");
    });

    it("filters by recipient", async () => {
      await createTestSender({ id: "s1", email: "a@test.com" });
      await createTestSender({ id: "s2", email: "b@test.com" });
      await createTestEmail({
        id: "e1",
        senderId: "s1",
        recipient: "inbox@cmail.test",
      });
      await createTestEmail({
        id: "e2",
        senderId: "s2",
        recipient: "other@cmail.test",
        messageId: "msg-2@example.com",
      });

      const res = await authFetch("/api/senders?recipient=inbox%40cmail.test", {
        apiKey,
      });
      const data = await res.json();
      expect(data).toHaveLength(1);
      expect(data[0].id).toBe("s1");
    });
  });

  describe("GET /api/senders/:id", () => {
    it("returns sender by id", async () => {
      await createTestSender({ id: "s1", email: "a@test.com", name: "Alice" });

      const res = await authFetch("/api/senders/s1", { apiKey });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.email).toBe("a@test.com");
      expect(data.name).toBe("Alice");
    });

    it("returns 404 for unknown sender", async () => {
      const res = await authFetch("/api/senders/unknown", { apiKey });
      expect(res.status).toBe(404);
    });
  });
});
