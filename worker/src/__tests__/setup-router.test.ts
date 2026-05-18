import { env } from "cloudflare:workers";
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { applyMigrations, cleanDb, createTestUser, authFetch } from "./helpers";

describe("setup router", () => {
  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDb();
  });

  describe("GET /api/setup/status", () => {
    it("returns setupRequired=true when no users", async () => {
      const res = await authFetch("/api/setup/status");
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.setupRequired).toBe(true);
    });

    it("returns setupRequired=false when users exist", async () => {
      await createTestUser();

      const res = await authFetch("/api/setup/status");
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.setupRequired).toBe(false);
    });

    it("tells operators to run production migrations when users table is missing", async () => {
      await env.DB.exec("DROP TABLE users");

      try {
        const res = await authFetch("/api/setup/status");
        expect(res.status).toBe(503);
        const data = (await res.json()) as {
          error?: string;
          code?: string;
          command?: string;
        };
        expect(data.code).toBe("DATABASE_MIGRATION_REQUIRED");
        expect(data.command).toBe("yarn db:migrate:prod");
        expect(data.error).toContain("yarn db:migrate:prod");
        expect(data.error).toContain("/saasmail-onboarding");
      } finally {
        await applyMigrations();
      }
    });
  });

  describe("POST /api/setup", () => {
    it("creates first admin user when no users exist", async () => {
      const res = await authFetch("/api/setup", {
        method: "POST",
        body: JSON.stringify({
          name: "Admin User",
          email: "admin@example.com",
          password: "securepassword123",
        }),
      });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.success).toBe(true);
    });

    it("rejects setup when users already exist", async () => {
      await createTestUser();

      const res = await authFetch("/api/setup", {
        method: "POST",
        body: JSON.stringify({
          name: "Another Admin",
          email: "admin2@example.com",
          password: "securepassword123",
        }),
      });
      expect(res.status).toBe(403);
    });

    it("rejects invalid email format", async () => {
      const res = await authFetch("/api/setup", {
        method: "POST",
        body: JSON.stringify({
          name: "Admin",
          email: "not-an-email",
          password: "securepassword123",
        }),
      });
      expect(res.status).toBe(400);
    });

    it("rejects short password", async () => {
      const res = await authFetch("/api/setup", {
        method: "POST",
        body: JSON.stringify({
          name: "Admin",
          email: "admin@example.com",
          password: "short",
        }),
      });
      expect(res.status).toBe(400);
    });
  });
});
