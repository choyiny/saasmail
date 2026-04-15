import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import {
  applyMigrations,
  cleanDb,
  createTestUser,
  authFetch,
  getDb,
} from "./helpers";
import { invitations } from "../db/invitations.schema";

describe("invites router", () => {
  let apiKey: string;
  let userId: string;

  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDb();
    ({ apiKey, userId } = await createTestUser({ role: "admin" }));
  });

  async function createInvite(
    opts: { email?: string; expired?: boolean } = {},
  ) {
    const db = getDb();
    const now = new Date();
    const expiresAt = opts.expired
      ? new Date(now.getTime() - 86400000) // expired
      : new Date(now.getTime() + 86400000 * 7); // 7 days

    const invite = {
      id: crypto.randomUUID(),
      token: crypto.randomUUID(),
      role: "member",
      email: opts.email ?? null,
      expiresAt,
      usedBy: null,
      usedAt: null,
      createdBy: userId,
      createdAt: now,
    };
    await db.insert(invitations).values(invite);
    return invite;
  }

  describe("GET /api/invites/:token", () => {
    it("returns valid=true for valid invitation", async () => {
      const invite = await createInvite();
      const res = await authFetch(`/api/invites/${invite.token}`);
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.valid).toBe(true);
      expect(data.role).toBe("member");
    });

    it("returns valid=false for nonexistent token", async () => {
      const res = await authFetch("/api/invites/nonexistent");
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.valid).toBe(false);
    });

    it("returns valid=false for expired token", async () => {
      const invite = await createInvite({ expired: true });
      const res = await authFetch(`/api/invites/${invite.token}`);
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.valid).toBe(false);
    });

    it("returns valid=false for used token", async () => {
      const db = getDb();
      const invite = await createInvite();
      // Mark as used
      await db
        .update(invitations)
        .set({
          usedBy: userId,
          usedAt: new Date(),
        })
        .where(
          (await import("drizzle-orm")).eq(invitations.token, invite.token),
        );

      const res = await authFetch(`/api/invites/${invite.token}`);
      const data = await res.json();
      expect(data.valid).toBe(false);
    });
  });

  describe("POST /api/invites/accept", () => {
    it("creates a user from valid invitation", async () => {
      const invite = await createInvite();
      const res = await authFetch("/api/invites/accept", {
        method: "POST",
        body: JSON.stringify({
          token: invite.token,
          name: "New User",
          email: "newuser@example.com",
          password: "securepassword123",
        }),
      });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.success).toBe(true);
      expect(data.userId).toBeDefined();
    });

    it("rejects invalid token", async () => {
      const res = await authFetch("/api/invites/accept", {
        method: "POST",
        body: JSON.stringify({
          token: "invalid-token",
          name: "User",
          email: "user@example.com",
          password: "securepassword123",
        }),
      });
      expect(res.status).toBe(400);
    });

    it("rejects expired invitation", async () => {
      const invite = await createInvite({ expired: true });
      const res = await authFetch("/api/invites/accept", {
        method: "POST",
        body: JSON.stringify({
          token: invite.token,
          name: "User",
          email: "user@example.com",
          password: "securepassword123",
        }),
      });
      expect(res.status).toBe(400);
    });

    it("rejects email mismatch when invite has email", async () => {
      const invite = await createInvite({ email: "specific@example.com" });
      const res = await authFetch("/api/invites/accept", {
        method: "POST",
        body: JSON.stringify({
          token: invite.token,
          name: "User",
          email: "different@example.com",
          password: "securepassword123",
        }),
      });
      expect(res.status).toBe(400);
    });

    it("accepts when email matches invite email", async () => {
      const invite = await createInvite({ email: "specific@example.com" });
      const res = await authFetch("/api/invites/accept", {
        method: "POST",
        body: JSON.stringify({
          token: invite.token,
          name: "User",
          email: "specific@example.com",
          password: "securepassword123",
        }),
      });
      expect(res.status).toBe(200);
    });
  });
});
