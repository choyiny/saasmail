import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { env } from "cloudflare:workers";
import {
  applyMigrations,
  cleanDb,
  createTestUser,
  createTestPerson,
  createTestEmail,
  authFetch,
  getDb,
} from "./helpers";
import { attachments } from "../db/attachments.schema";
import { inboxPermissions } from "../db/inbox-permissions.schema";
import { sentEmails } from "../db/sent-emails.schema";

describe("attachments router", () => {
  let apiKey: string;

  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDb();
    ({ apiKey } = await createTestUser());
  });

  async function createTestAttachment() {
    const db = getDb();
    await createTestPerson({ id: "s1", email: "a@test.com" });
    await createTestEmail({ id: "e1", personId: "s1" });

    const content = new TextEncoder().encode("Hello PDF");
    const r2Key = "attachments/e1/test.pdf";
    await env.R2.put(r2Key, content, {
      httpMetadata: { contentType: "application/pdf" },
    });

    await db.insert(attachments).values({
      id: "att-1",
      emailId: "e1",
      filename: "test.pdf",
      contentType: "application/pdf",
      size: content.byteLength,
      r2Key,
      contentId: null,
      createdAt: Math.floor(Date.now() / 1000),
    });
  }

  describe("GET /api/attachments/:id", () => {
    it("downloads attachment with correct headers", async () => {
      await createTestAttachment();

      const res = await authFetch("/api/attachments/att-1", { apiKey });
      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toBe("application/pdf");
      expect(res.headers.get("Content-Disposition")).toContain("test.pdf");
    });

    it("returns 404 for missing attachment", async () => {
      const res = await authFetch("/api/attachments/nonexistent", {
        apiKey,
      });
      expect(res.status).toBe(404);
    });

    it("returns 404 when R2 object missing", async () => {
      const db = getDb();
      await createTestPerson({ id: "s1", email: "a@test.com" });
      await createTestEmail({ id: "e1", personId: "s1" });

      await db.insert(attachments).values({
        id: "att-orphan",
        emailId: "e1",
        filename: "gone.pdf",
        contentType: "application/pdf",
        size: 100,
        r2Key: "nonexistent/gone.pdf",
        contentId: null,
        createdAt: Math.floor(Date.now() / 1000),
      });

      const res = await authFetch("/api/attachments/att-orphan", {
        apiKey,
      });
      expect(res.status).toBe(404);
    });
  });

  describe("GET /api/attachments/:id/inline", () => {
    it("serves attachment inline with cache headers", async () => {
      await createTestAttachment();

      const res = await authFetch("/api/attachments/att-1/inline", {
        apiKey,
      });
      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Disposition")).toBe("inline");
      expect(res.headers.get("Cache-Control")).toContain("immutable");
    });

    it("returns 404 for missing attachment", async () => {
      const res = await authFetch("/api/attachments/nonexistent/inline", {
        apiKey,
      });
      expect(res.status).toBe(404);
    });

    it("does not license shared caches to store mailbox content", async () => {
      await createTestAttachment();

      const res = await authFetch("/api/attachments/att-1/inline", { apiKey });
      const cacheControl = res.headers.get("Cache-Control") ?? "";
      expect(cacheControl).toContain("private");
      expect(cacheControl).not.toContain("public");
    });
  });

  // Every test above authenticates as an admin, for whom scoping
  // short-circuits. These need a member.
  describe("inbox scoping", () => {
    const MINE = "mine@saasmail.test";
    const THEIRS = "theirs@saasmail.test";

    async function createMember() {
      const { userId, apiKey: memberKey } = await createTestUser({
        id: "member1",
        role: "member",
        email: "member@test.com",
      });
      await getDb()
        .insert(inboxPermissions)
        .values({
          userId,
          email: MINE,
          createdAt: Math.floor(Date.now() / 1000),
          createdBy: null,
        });
      return memberKey;
    }

    async function putAttachment(opts: {
      id: string;
      emailId: string;
      kind: "inbound" | "sent";
    }) {
      const r2Key = `attachments/${opts.emailId}/f.pdf`;
      await env.R2.put(r2Key, new TextEncoder().encode("x"), {
        httpMetadata: { contentType: "application/pdf" },
      });
      await getDb()
        .insert(attachments)
        .values({
          id: opts.id,
          emailId: opts.emailId,
          kind: opts.kind,
          filename: "f.pdf",
          contentType: "application/pdf",
          size: 1,
          r2Key,
          contentId: null,
          createdAt: Math.floor(Date.now() / 1000),
        });
    }

    async function seedInbound() {
      await createTestPerson({ id: "s1", email: "ext@test.com" });
      await createTestEmail({ id: "mine-1", personId: "s1", recipient: MINE });
      await createTestEmail({
        id: "theirs-1",
        personId: "s1",
        recipient: THEIRS,
        messageId: "msg-2@example.com",
      });
      await putAttachment({
        id: "att-mine",
        emailId: "mine-1",
        kind: "inbound",
      });
      await putAttachment({
        id: "att-theirs",
        emailId: "theirs-1",
        kind: "inbound",
      });
    }

    // A sent attachment belongs to the inbox it was sent FROM.
    async function seedSent() {
      const now = Math.floor(Date.now() / 1000);
      await getDb()
        .insert(sentEmails)
        .values([
          {
            id: "sent-mine",
            personId: null,
            fromAddress: MINE,
            toAddress: "ext@test.com",
            subject: "s",
            sentAt: now,
            createdAt: now,
          },
          {
            id: "sent-theirs",
            personId: null,
            fromAddress: THEIRS,
            toAddress: "ext@test.com",
            subject: "s",
            sentAt: now,
            createdAt: now,
          },
        ]);
      await putAttachment({
        id: "att-sent-mine",
        emailId: "sent-mine",
        kind: "sent",
      });
      await putAttachment({
        id: "att-sent-theirs",
        emailId: "sent-theirs",
        kind: "sent",
      });
    }

    it("serves an inbound attachment from an inbox the member holds", async () => {
      await seedInbound();
      const memberKey = await createMember();

      const res = await authFetch("/api/attachments/att-mine", {
        apiKey: memberKey,
      });
      expect(res.status).toBe(200);
    });

    it("hides an inbound attachment from an inbox the member does not hold", async () => {
      await seedInbound();
      const memberKey = await createMember();

      const res = await authFetch("/api/attachments/att-theirs", {
        apiKey: memberKey,
      });
      expect(res.status).toBe(404);
      // 404, not 403 — a 403 would confirm the id exists.
      expect(await res.json()).toEqual({ error: "Attachment not found" });
    });

    it("hides an unauthorized attachment on the inline route too", async () => {
      await seedInbound();
      const memberKey = await createMember();

      const res = await authFetch("/api/attachments/att-theirs/inline", {
        apiKey: memberKey,
      });
      expect(res.status).toBe(404);
    });

    it("scopes a sent attachment by the inbox it was sent from", async () => {
      await seedSent();
      const memberKey = await createMember();

      const mine = await authFetch("/api/attachments/att-sent-mine", {
        apiKey: memberKey,
      });
      expect(mine.status).toBe(200);

      const theirs = await authFetch("/api/attachments/att-sent-theirs", {
        apiKey: memberKey,
      });
      expect(theirs.status).toBe(404);
    });

    it("still serves everything to an admin", async () => {
      await seedInbound();

      const res = await authFetch("/api/attachments/att-theirs", { apiKey });
      expect(res.status).toBe(200);
    });
  });
});
