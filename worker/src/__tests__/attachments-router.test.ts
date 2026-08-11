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

describe("attachments router", () => {
  let apiKey: string;

  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDb();
    ({ apiKey } = await createTestUser());
  });

  async function createTestAttachment(filename = "test.pdf") {
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
      filename,
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

    it("sanitizes filename in content-disposition header", async () => {
      await createTestAttachment('te"st\r\nx.pdf');

      const res = await authFetch("/api/attachments/att-1", { apiKey });
      expect(res.status).toBe(200);
      const contentDisposition = res.headers.get("Content-Disposition");
      expect(contentDisposition).toBeTruthy();
      expect(contentDisposition).toContain(`filename="te_stx.pdf"`);
      expect(contentDisposition).toContain("filename*=UTF-8''te_stx.pdf");
      expect(contentDisposition).not.toContain("\r");
      expect(contentDisposition).not.toContain("\n");
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
  });
});
