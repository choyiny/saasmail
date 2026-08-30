import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import {
  applyMigrations,
  cleanDb,
  createTestUser,
  authFetch,
  getDb,
} from "./helpers";
import { drafts } from "../db/drafts.schema";
import { eq } from "drizzle-orm";

const q = (contextKey: string) =>
  `/api/drafts?contextKey=${encodeURIComponent(contextKey)}`;

function save(apiKey: string, body: Record<string, unknown>) {
  return authFetch("/api/drafts", {
    apiKey,
    method: "PUT",
    body: JSON.stringify(body),
  });
}

describe("drafts router", () => {
  let apiKey: string;
  let userId: string;

  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDb();
    ({ apiKey, userId } = await createTestUser());
  });

  describe("PUT /api/drafts", () => {
    it("creates a draft and returns it", async () => {
      const res = await save(apiKey, {
        contextKey: "compose",
        to: "alice@example.com",
        subject: "Hi there",
        bodyHtml: "<p>Half an email…</p>",
        bodyText: "Half an email…",
        cc: [{ email: "cc@example.com", name: "Cc Person" }],
        fromAddress: "support@givefeedback.dev",
      });
      expect(res.status).toBe(200);
      const { draft } = await res.json();
      expect(draft.contextKey).toBe("compose");
      expect(draft.toAddress).toBe("alice@example.com");
      expect(draft.subject).toBe("Hi there");
      expect(draft.bodyHtml).toBe("<p>Half an email…</p>");
      expect(draft.cc).toEqual([
        { email: "cc@example.com", name: "Cc Person" },
      ]);
      expect(draft.replyToEmailId).toBeNull();
    });

    it("upserts by (user, contextKey) — a second save updates, not duplicates", async () => {
      await save(apiKey, { contextKey: "compose", subject: "First" });
      await save(apiKey, { contextKey: "compose", subject: "Second" });

      const db = getDb();
      const rows = await db
        .select()
        .from(drafts)
        .where(eq(drafts.userId, userId));
      expect(rows).toHaveLength(1);
      expect(rows[0].subject).toBe("Second");
    });

    it("keeps compose and reply drafts as separate rows", async () => {
      await save(apiKey, { contextKey: "compose", subject: "New message" });
      await save(apiKey, {
        contextKey: "reply:email-1",
        replyToEmailId: "email-1",
        bodyHtml: "<p>My reply</p>",
      });

      const db = getDb();
      const rows = await db
        .select()
        .from(drafts)
        .where(eq(drafts.userId, userId));
      expect(rows).toHaveLength(2);
    });

    it("accepts a partial/incomplete To while typing (no email validation)", async () => {
      const res = await save(apiKey, { contextKey: "compose", to: "ali" });
      expect(res.status).toBe(200);
      const { draft } = await res.json();
      expect(draft.toAddress).toBe("ali");
    });
  });

  describe("GET /api/drafts", () => {
    it("returns the draft for a contextKey", async () => {
      await save(apiKey, { contextKey: "compose", subject: "Saved" });
      const res = await authFetch(q("compose"), { apiKey });
      expect(res.status).toBe(200);
      const { draft } = await res.json();
      expect(draft.subject).toBe("Saved");
    });

    it("returns null when no draft exists for that surface", async () => {
      const res = await authFetch(q("reply:missing"), { apiKey });
      expect(res.status).toBe(200);
      const { draft } = await res.json();
      expect(draft).toBeNull();
    });
  });

  describe("DELETE /api/drafts", () => {
    it("deletes the draft for a contextKey", async () => {
      await save(apiKey, { contextKey: "compose", subject: "To discard" });
      const del = await authFetch(q("compose"), { apiKey, method: "DELETE" });
      expect(del.status).toBe(200);
      expect((await del.json()).success).toBe(true);

      const res = await authFetch(q("compose"), { apiKey });
      expect((await res.json()).draft).toBeNull();
    });
  });

  describe("per-user isolation", () => {
    it("does not leak one user's draft to another", async () => {
      await save(apiKey, { contextKey: "compose", subject: "User A secret" });

      const { apiKey: apiKeyB } = await createTestUser({
        id: "user-b",
        email: "b@example.com",
      });

      // User B sees no draft on the same contextKey…
      const bGet = await authFetch(q("compose"), { apiKey: apiKeyB });
      expect((await bGet.json()).draft).toBeNull();

      // …and B's own save doesn't touch A's row.
      await save(apiKeyB, { contextKey: "compose", subject: "User B draft" });
      const aGet = await authFetch(q("compose"), { apiKey });
      expect((await aGet.json()).draft.subject).toBe("User A secret");
    });
  });

  describe("auth", () => {
    it("rejects unauthenticated requests", async () => {
      const res = await authFetch(q("compose"));
      expect(res.status).toBe(401);
    });
  });
});
