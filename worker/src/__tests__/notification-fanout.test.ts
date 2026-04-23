/**
 * Unit tests for the notification fanout target computation. The DO fetch
 * itself is exercised indirectly via the router tests — this file covers the
 * pure logic (union, dedupe, admin cap) that decides *who* gets notified.
 */
import { describe, it, expect } from "vitest";
import {
  MAX_ADMIN_FANOUT,
  computeFanoutTargets,
} from "../lib/notification-fanout";

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
