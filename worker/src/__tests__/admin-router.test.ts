import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import {
  applyMigrations,
  cleanDb,
  createTestUser,
  authFetch,
  getDb,
} from "./helpers";
import { users, passkeys } from "../db/auth.schema";
import { invitations } from "../db/invitations.schema";
import { eq } from "drizzle-orm";

describe("admin router", () => {
  let apiKey: string;
  let userId: string;

  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDb();
    ({ apiKey, userId } = await createTestUser({
      role: "admin",
    }));
  });

  describe("POST /api/admin/invites", () => {
    it("creates an invitation", async () => {
      const res = await authFetch("/api/admin/invites", {
        apiKey,
        method: "POST",
        body: JSON.stringify({ role: "member", expiresInDays: 7 }),
      });
      expect(res.status).toBe(201);
      const data = await res.json();
      expect(data.token).toBeDefined();
      expect(data.role).toBe("member");
    });

    it("creates invitation with email", async () => {
      const res = await authFetch("/api/admin/invites", {
        apiKey,
        method: "POST",
        body: JSON.stringify({
          role: "admin",
          email: "invited@example.com",
          expiresInDays: 3,
        }),
      });
      expect(res.status).toBe(201);
      const data = await res.json();
      expect(data.email).toBe("invited@example.com");
    });
  });

  describe("GET /api/admin/invites", () => {
    it("lists all invitations", async () => {
      // Create an invite first
      await authFetch("/api/admin/invites", {
        apiKey,
        method: "POST",
        body: JSON.stringify({ role: "member", expiresInDays: 7 }),
      });

      const res = await authFetch("/api/admin/invites", { apiKey });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("GET /api/admin/users", () => {
    it("lists users with passkey status", async () => {
      const res = await authFetch("/api/admin/users", { apiKey });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data).toHaveLength(1);
      expect(data[0].hasPasskey).toBe(false);
    });

    it("shows hasPasskey=true when passkey exists", async () => {
      const db = getDb();
      await db.insert(passkeys).values({
        id: "pk-1",
        publicKey: "test-key",
        userId,
        credentialID: "cred-1",
        counter: 0,
        deviceType: "singleDevice",
        backedUp: false,
      });

      const res = await authFetch("/api/admin/users", { apiKey });
      const data = await res.json();
      expect(data[0].hasPasskey).toBe(true);
    });
  });

  describe("PATCH /api/admin/users/:id/role", () => {
    it("updates user role", async () => {
      const db = getDb();
      const now = Date.now();
      await db.insert(users).values({
        id: "user-2",
        name: "Other User",
        email: "other@example.com",
        emailVerified: false,
        createdAt: new Date(now),
        updatedAt: new Date(now),
        role: "member",
      });

      const res = await authFetch("/api/admin/users/user-2/role", {
        apiKey,
        method: "PATCH",
        body: JSON.stringify({ role: "admin" }),
      });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.success).toBe(true);
    });

    it("cannot change own role", async () => {
      const res = await authFetch(`/api/admin/users/${userId}/role`, {
        apiKey,
        method: "PATCH",
        body: JSON.stringify({ role: "member" }),
      });
      expect(res.status).toBe(400);
    });

    it("returns 404 for nonexistent user", async () => {
      const res = await authFetch("/api/admin/users/nonexistent/role", {
        apiKey,
        method: "PATCH",
        body: JSON.stringify({ role: "admin" }),
      });
      expect(res.status).toBe(404);
    });
  });

  describe("DELETE /api/admin/users/:id", () => {
    it("deletes a user", async () => {
      const db = getDb();
      const now = Date.now();
      await db.insert(users).values({
        id: "user-2",
        name: "Other User",
        email: "other@example.com",
        emailVerified: false,
        createdAt: new Date(now),
        updatedAt: new Date(now),
        role: "member",
      });

      const res = await authFetch("/api/admin/users/user-2", {
        apiKey,
        method: "DELETE",
      });
      expect(res.status).toBe(200);
    });

    it("cannot delete self", async () => {
      const res = await authFetch(`/api/admin/users/${userId}`, {
        apiKey,
        method: "DELETE",
      });
      expect(res.status).toBe(400);
    });

    it("returns 404 for nonexistent user", async () => {
      const res = await authFetch("/api/admin/users/nonexistent", {
        apiKey,
        method: "DELETE",
      });
      expect(res.status).toBe(404);
    });
  });

  describe("DELETE /api/admin/invites/:id", () => {
    it("revokes a pending invite", async () => {
      const db = getDb();
      const now = new Date();
      await db.insert(invitations).values({
        id: "invite-1",
        token: crypto.randomUUID(),
        role: "member",
        email: null,
        expiresAt: new Date(now.getTime() + 86400000),
        usedBy: null,
        usedAt: null,
        createdBy: userId,
        createdAt: now,
      });

      const res = await authFetch("/api/admin/invites/invite-1", {
        apiKey,
        method: "DELETE",
      });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.success).toBe(true);

      const remaining = await db
        .select()
        .from(invitations)
        .where(eq(invitations.id, "invite-1"))
        .get();
      expect(remaining).toBeUndefined();
    });

    it("revokes a used invite", async () => {
      const db = getDb();
      const now = new Date();
      const now2 = Date.now();
      await db.insert(users).values({
        id: "user-2",
        name: "Accepted User",
        email: "accepted@example.com",
        emailVerified: false,
        createdAt: new Date(now2),
        updatedAt: new Date(now2),
        role: "member",
      });
      await db.insert(invitations).values({
        id: "invite-2",
        token: crypto.randomUUID(),
        role: "member",
        email: "accepted@example.com",
        expiresAt: new Date(now.getTime() + 86400000),
        usedBy: "user-2",
        usedAt: now,
        createdBy: userId,
        createdAt: now,
      });

      const res = await authFetch("/api/admin/invites/invite-2", {
        apiKey,
        method: "DELETE",
      });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.success).toBe(true);
    });

    it("returns 404 for nonexistent invite id", async () => {
      const res = await authFetch("/api/admin/invites/nonexistent", {
        apiKey,
        method: "DELETE",
      });
      expect(res.status).toBe(404);
    });

    it("rejects non-admin for revoke endpoint", async () => {
      await cleanDb();
      const { apiKey: memberApiKey } = await createTestUser({ role: "member" });

      const res = await authFetch("/api/admin/invites/any-id", {
        apiKey: memberApiKey,
        method: "DELETE",
      });
      expect(res.status).toBe(403);
    });
  });

  describe("admin guard", () => {
    it("rejects non-admin users", async () => {
      await cleanDb();
      const { apiKey: memberApiKey } = await createTestUser({
        role: "member",
      });

      const res = await authFetch("/api/admin/users", {
        apiKey: memberApiKey,
      });
      expect(res.status).toBe(403);
    });
  });
});
