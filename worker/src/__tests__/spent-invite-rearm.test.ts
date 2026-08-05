import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import {
  applyMigrations,
  authFetch,
  cleanDb,
  createTestUser,
  getDb,
} from "./helpers";
import { users } from "../db/auth.schema";
import { invitations } from "../db/invitations.schema";

/**
 * Deleting a user must not resurrect the invitation they signed up with.
 *
 * `invitations.used_by` is `ON DELETE SET NULL` (migration 0004), and both
 * redeem paths treat a null `usedBy` as "never used". So a bare
 * `DELETE FROM users` silently returns a spent invite to circulation — while
 * the token is still sitting in whoever's inbox it was mailed to, while
 * `POST /api/invites/accept` is public, and carrying whatever role it was
 * minted with.
 */
describe("deleting a user does not re-arm their invitation", () => {
  let adminKey: string;
  let adminId: string;

  beforeAll(applyMigrations);

  beforeEach(async () => {
    await cleanDb();
    ({ apiKey: adminKey, userId: adminId } = await createTestUser({
      id: "admin-1",
      role: "admin",
      email: "admin@x.com",
    }));
  });

  /** An invite that has already been redeemed by `usedBy`. */
  async function seedSpentInvite(opts: {
    token: string;
    role: "admin" | "member";
    usedBy: string | null;
    email?: string | null;
    expiresInDays?: number;
  }) {
    const now = Date.now();
    await getDb()
      .insert(invitations)
      .values({
        id: `inv-${opts.token}`,
        token: opts.token,
        role: opts.role,
        email: opts.email ?? null,
        expiresAt: new Date(now + (opts.expiresInDays ?? 7) * 86400_000),
        usedBy: opts.usedBy,
        usedAt: opts.usedBy ? new Date(now) : null,
        createdBy: adminId,
        createdAt: new Date(now),
      });
  }

  it("removes the invitation the deleted user redeemed", async () => {
    const { userId: victimId } = await createTestUser({
      id: "u-victim",
      role: "admin",
      email: "victim@x.com",
    });
    await seedSpentInvite({
      token: "tok-spent",
      role: "admin",
      usedBy: victimId,
    });

    const res = await authFetch(`/api/admin/users/${victimId}`, {
      apiKey: adminKey,
      method: "DELETE",
    });
    expect(res.status).toBe(200);

    const rows = await getDb()
      .select()
      .from(invitations)
      .where(eq(invitations.token, "tok-spent"));
    expect(rows).toHaveLength(0);
  });

  /**
   * The one that matters: the public accept endpoint, exercised end to end.
   * Without the fix this returns 200 and mints a fresh admin account.
   */
  it("does not let the spent token create a new admin account afterwards", async () => {
    const { userId: victimId } = await createTestUser({
      id: "u-victim",
      role: "admin",
      email: "victim@x.com",
    });
    await seedSpentInvite({
      token: "tok-admin",
      role: "admin",
      usedBy: victimId,
    });

    await authFetch(`/api/admin/users/${victimId}`, {
      apiKey: adminKey,
      method: "DELETE",
    });

    const accept = await authFetch("/api/invites/accept", {
      method: "POST",
      body: JSON.stringify({
        token: "tok-admin",
        email: "attacker@x.com",
        password: "correct-horse-battery-staple",
        name: "Attacker",
      }),
    });

    expect(accept.status).not.toBe(200);

    const created = await getDb()
      .select()
      .from(users)
      .where(eq(users.email, "attacker@x.com"));
    expect(created).toHaveLength(0);
  });

  it("reports the token as invalid rather than valid", async () => {
    const { userId: victimId } = await createTestUser({
      id: "u-victim",
      role: "member",
      email: "victim@x.com",
    });
    await seedSpentInvite({
      token: "tok-check",
      role: "member",
      usedBy: victimId,
    });

    await authFetch(`/api/admin/users/${victimId}`, {
      apiKey: adminKey,
      method: "DELETE",
    });

    const res = await authFetch("/api/invites/tok-check");
    const body = (await res.json()) as { valid: boolean };
    expect(body.valid).toBe(false);
  });

  it("leaves an unredeemed invitation alone", async () => {
    const { userId: victimId } = await createTestUser({
      id: "u-victim",
      role: "member",
      email: "victim@x.com",
    });
    // Nobody has used this one; deleting an unrelated user must not touch it.
    await seedSpentInvite({ token: "tok-open", role: "member", usedBy: null });

    await authFetch(`/api/admin/users/${victimId}`, {
      apiKey: adminKey,
      method: "DELETE",
    });

    const res = await authFetch("/api/invites/tok-open");
    const body = (await res.json()) as { valid: boolean };
    expect(body.valid).toBe(true);
  });

  it("does not touch invitations redeemed by other users", async () => {
    const { userId: victimId } = await createTestUser({
      id: "u-victim",
      role: "member",
      email: "victim@x.com",
    });
    const { userId: keeperId } = await createTestUser({
      id: "u-keeper",
      role: "member",
      email: "keeper@x.com",
    });
    await seedSpentInvite({
      token: "tok-victim",
      role: "member",
      usedBy: victimId,
    });
    await seedSpentInvite({
      token: "tok-keeper",
      role: "member",
      usedBy: keeperId,
    });

    await authFetch(`/api/admin/users/${victimId}`, {
      apiKey: adminKey,
      method: "DELETE",
    });

    const remaining = await getDb().select().from(invitations);
    expect(remaining.map((r) => r.token)).toEqual(["tok-keeper"]);
  });
});
