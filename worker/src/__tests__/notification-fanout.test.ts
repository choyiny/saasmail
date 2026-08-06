/**
 * Unit tests for the notification fanout target computation. The DO fetch
 * itself is exercised indirectly via the router tests — this file covers the
 * pure logic (union, dedupe, admin cap) that decides *who* gets notified.
 */
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import {
  MAX_ADMIN_FANOUT,
  computeFanoutTargets,
  filterNotifiableUsers,
} from "../lib/notification-fanout";
import { applyMigrations, cleanDb, getDb } from "./helpers";
import { users, passkeys } from "../db/auth.schema";

describe("computeFanoutTargets", () => {
  it("unions permission users and admins", () => {
    const { userIds, adminTruncated } = computeFanoutTargets({
      permissionUserIds: ["u-perm-1", "u-perm-2"],
      adminUserIds: ["u-admin-1"],
    });
    expect(new Set(userIds)).toEqual(
      new Set(["u-perm-1", "u-perm-2", "u-admin-1"]),
    );
    expect(adminTruncated).toBe(false);
  });

  it("deduplicates users who are both admin and have inbox permission", () => {
    const { userIds } = computeFanoutTargets({
      permissionUserIds: ["u-1", "u-2"],
      adminUserIds: ["u-1", "u-3"],
    });
    expect(userIds).toHaveLength(3);
    expect(new Set(userIds)).toEqual(new Set(["u-1", "u-2", "u-3"]));
  });

  it("returns an empty list when there are no recipients", () => {
    const { userIds, adminTruncated } = computeFanoutTargets({
      permissionUserIds: [],
      adminUserIds: [],
    });
    expect(userIds).toEqual([]);
    expect(adminTruncated).toBe(false);
  });

  it("truncates admins to MAX_ADMIN_FANOUT and signals truncation", () => {
    const admins = Array.from(
      { length: MAX_ADMIN_FANOUT + 5 },
      (_, i) => `admin-${i}`,
    );
    const { userIds, adminTruncated } = computeFanoutTargets({
      permissionUserIds: [],
      adminUserIds: admins,
    });
    expect(userIds).toHaveLength(MAX_ADMIN_FANOUT);
    expect(userIds).toEqual(admins.slice(0, MAX_ADMIN_FANOUT));
    expect(adminTruncated).toBe(true);
  });

  it("still includes all permission users even when admins are truncated", () => {
    const admins = Array.from(
      { length: MAX_ADMIN_FANOUT + 1 },
      (_, i) => `admin-${i}`,
    );
    const { userIds } = computeFanoutTargets({
      permissionUserIds: ["u-perm"],
      adminUserIds: admins,
    });
    expect(userIds).toContain("u-perm");
    expect(userIds).toHaveLength(MAX_ADMIN_FANOUT + 1); // perm + cap admins
  });

  it("honors an explicit maxAdminFanout override", () => {
    const { userIds, adminTruncated } = computeFanoutTargets({
      permissionUserIds: [],
      adminUserIds: ["a", "b", "c", "d"],
      maxAdminFanout: 2,
    });
    expect(userIds).toEqual(["a", "b"]);
    expect(adminTruncated).toBe(true);
  });

  it("does not flag truncation when the admin count equals the cap", () => {
    const admins = Array.from(
      { length: MAX_ADMIN_FANOUT },
      (_, i) => `admin-${i}`,
    );
    const { userIds, adminTruncated } = computeFanoutTargets({
      permissionUserIds: [],
      adminUserIds: admins,
    });
    expect(userIds).toHaveLength(MAX_ADMIN_FANOUT);
    expect(adminTruncated).toBe(false);
  });
});

// Env is passed explicitly: the ambient test bindings set
// DISABLE_PASSKEY_GATE="true", under which the passkey branch never runs.
describe("filterNotifiableUsers", () => {
  const GATE_ON = { DISABLE_PASSKEY_GATE: "false" } as any;
  const GATE_OFF = { DISABLE_PASSKEY_GATE: "true" } as any;

  beforeAll(applyMigrations);
  beforeEach(cleanDb);

  async function insertUser(
    id: string,
    opts: { banned?: boolean; banExpires?: Date | null } = {},
  ) {
    const now = Date.now();
    await getDb()
      .insert(users)
      .values({
        id,
        name: id,
        email: `${id}@test.local`,
        emailVerified: false,
        createdAt: new Date(now),
        updatedAt: new Date(now),
        role: "member",
        banned: opts.banned ?? false,
        banExpires: opts.banExpires ?? null,
      });
  }

  async function givePasskey(userId: string) {
    await getDb()
      .insert(passkeys)
      .values({
        id: `pk-${userId}`,
        userId,
        publicKey: "x",
        credentialID: `cred-${userId}`,
        counter: 0,
        deviceType: "singleDevice",
        backedUp: false,
        transports: null,
        createdAt: new Date(),
      });
  }

  it("drops a banned user even in dev", async () => {
    await insertUser("ok");
    await insertUser("banned", { banned: true });

    const result = await filterNotifiableUsers(getDb(), GATE_OFF, [
      "ok",
      "banned",
    ]);
    expect(result).toEqual(["ok"]);
  });

  it("keeps a user whose ban has expired", async () => {
    await insertUser("expired", {
      banned: true,
      banExpires: new Date(Date.now() - 60_000),
    });

    const result = await filterNotifiableUsers(getDb(), GATE_OFF, ["expired"]);
    expect(result).toEqual(["expired"]);
  });

  it("drops a user with no passkey when the gate is enforced", async () => {
    await insertUser("enrolled");
    await givePasskey("enrolled");
    await insertUser("no-passkey");

    const result = await filterNotifiableUsers(getDb(), GATE_ON, [
      "enrolled",
      "no-passkey",
    ]);
    expect(result).toEqual(["enrolled"]);
  });

  it("keeps a passkey-less user in dev, matching requirePasskey", async () => {
    await insertUser("no-passkey");

    const result = await filterNotifiableUsers(getDb(), GATE_OFF, [
      "no-passkey",
    ]);
    expect(result).toEqual(["no-passkey"]);
  });

  it("drops a banned user who does have a passkey", async () => {
    await insertUser("banned", { banned: true });
    await givePasskey("banned");

    const result = await filterNotifiableUsers(getDb(), GATE_ON, ["banned"]);
    expect(result).toEqual([]);
  });

  it("returns an empty list for no candidates without querying", async () => {
    expect(await filterNotifiableUsers(getDb(), GATE_ON, [])).toEqual([]);
  });
});
