import { beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { applyMigrations, cleanDb, getDb } from "./helpers";
import { inboxPermissions } from "../db/inbox-permissions.schema";
import { users } from "../db/auth.schema";
import { emails } from "../db/emails.schema";
import {
  resolveAllowedInboxes,
  inboxFilter,
  assertInboxAllowed,
} from "../lib/inbox-permissions";

async function insertUser(id: string, role: string) {
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
      role,
    });
}

async function insertPermission(userId: string, email: string) {
  await getDb()
    .insert(inboxPermissions)
    .values({
      userId,
      email,
      createdAt: Math.floor(Date.now() / 1000),
      createdBy: null,
    });
}

beforeEach(async () => {
  await applyMigrations();
  await cleanDb();
});

describe("resolveAllowedInboxes", () => {
  it("returns isAdmin: true for admin users", async () => {
    await insertUser("u-admin", "admin");
    const db = getDb();
    const adminUser = (
      await db.select().from(users).where(eq(users.id, "u-admin")).limit(1)
    )[0];
    const result = await resolveAllowedInboxes(db, adminUser);
    expect(result).toEqual({ isAdmin: true });
  });

  it("returns member inboxes when assigned", async () => {
    await insertUser("u-mem", "member");
    await insertPermission("u-mem", "a@x.com");
    await insertPermission("u-mem", "b@x.com");
    const db = getDb();
    const memberUser = (
      await db.select().from(users).where(eq(users.id, "u-mem")).limit(1)
    )[0];
    const result = await resolveAllowedInboxes(db, memberUser);
    expect(result.isAdmin).toBe(false);
    if (!result.isAdmin) {
      expect(result.inboxes.sort()).toEqual(["a@x.com", "b@x.com"]);
    }
  });

  it("returns empty inbox list for member with no assignments", async () => {
    await insertUser("u-empty", "member");
    const db = getDb();
    const u = (
      await db.select().from(users).where(eq(users.id, "u-empty")).limit(1)
    )[0];
    const result = await resolveAllowedInboxes(db, u);
    expect(result).toEqual({ isAdmin: false, inboxes: [] });
  });
});

describe("inboxFilter", () => {
  it("returns undefined for admin", () => {
    expect(inboxFilter({ isAdmin: true }, emails.recipient)).toBeUndefined();
  });

  it("returns an inArray condition for member with inboxes", () => {
    const cond = inboxFilter(
      { isAdmin: false, inboxes: ["a@x.com"] },
      emails.recipient,
    );
    expect(cond).toBeDefined();
  });

  it("matches-nothing condition for member with no inboxes", async () => {
    // End-to-end check: when used in a WHERE, no rows should be returned.
    await insertUser("u-none", "member");
    const db = getDb();
    // Insert a row in emails so there is something to filter.
    const now = Math.floor(Date.now() / 1000);
    await db.run(sql`
      INSERT INTO emails (id, person_id, recipient, received_at, created_at, is_read)
      VALUES ('e1', 'p1', 'a@x.com', ${now}, ${now}, 0)
    `);
    const cond = inboxFilter({ isAdmin: false, inboxes: [] }, emails.recipient);
    const rows = await db.select().from(emails).where(cond!);
    expect(rows).toHaveLength(0);
  });
});

describe("assertInboxAllowed", () => {
  it("does not throw for admin regardless of address", () => {
    expect(() =>
      assertInboxAllowed({ isAdmin: true }, "anything@x.com"),
    ).not.toThrow();
  });

  it("does not throw when member has the inbox", () => {
    expect(() =>
      assertInboxAllowed({ isAdmin: false, inboxes: ["a@x.com"] }, "a@x.com"),
    ).not.toThrow();
  });

  it("throws 403 when member lacks the inbox", () => {
    expect(() =>
      assertInboxAllowed({ isAdmin: false, inboxes: ["a@x.com"] }, "b@x.com"),
    ).toThrowError(/Inbox not allowed/);
  });
});
