import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { customerPeople, customers } from "../db/customers.schema";
import { inboxPermissions } from "../db/inbox-permissions.schema";
import {
  getCustomerByPerson,
  linkPeople,
  resolveCustomerScope,
  unlinkPerson,
} from "../lib/customers";
import { queryMessages } from "../lib/messages/query";
import {
  applyMigrations,
  authFetch,
  cleanDb,
  createTestEmail,
  createTestPerson,
  createTestUser,
  getDb,
} from "./helpers";

describe("identity graph", () => {
  beforeAll(applyMigrations);
  beforeEach(cleanDb);

  it("links, grows, merges smaller into larger, unlinks, and is idempotent", async () => {
    const db = getDb();
    const allowed = { isAdmin: true as const };
    for (const id of ["a", "b", "c", "d", "e", "f", "g"]) {
      await createTestPerson({ id, email: `${id}@example.com` });
    }

    const first = await linkPeople(db, allowed, null, "a", "b");
    expect(first.personIds.sort()).toEqual(["a", "b"]);

    const repeated = await linkPeople(db, allowed, null, "a", "b");
    expect(repeated.customerId).toBe(first.customerId);
    expect(await db.select().from(customers)).toHaveLength(1);

    const second = await linkPeople(db, allowed, null, "c", "d");
    await linkPeople(db, allowed, null, "c", "e");
    expect((await resolveCustomerScope(db, "c")).personIds).toHaveLength(3);

    const merged = await linkPeople(db, allowed, null, "a", "c");
    expect(merged.customerId).toBe(second.customerId);
    expect(new Set(merged.personIds)).toEqual(
      new Set(["a", "b", "c", "d", "e"]),
    );
    expect(await db.select().from(customers)).toHaveLength(1);

    await unlinkPerson(db, allowed, null, "a");
    expect((await resolveCustomerScope(db, "b")).personIds).toHaveLength(4);
    expect((await resolveCustomerScope(db, "a")).customerId).toBeNull();

    const pair = await linkPeople(db, allowed, null, "f", "g");
    expect(pair.customerId).not.toBeNull();
    await unlinkPerson(db, allowed, null, "f");
    expect((await resolveCustomerScope(db, "g")).customerId).toBeNull();
    expect(
      await db
        .select()
        .from(customerPeople)
        .where(eq(customerPeople.personId, "g")),
    ).toHaveLength(0);
  });

  it("converges concurrent links through the same person into one customer", async () => {
    const { apiKey } = await createTestUser({
      id: "identity-race-admin",
      role: "admin",
      email: "identity-race-admin@example.com",
    });
    const db = getDb();
    for (const id of ["race-a", "race-b", "race-c"]) {
      await createTestPerson({ id, email: `${id}@example.com` });
    }

    const [ab, ac] = await Promise.all([
      authFetch("/api/customers/link", {
        apiKey,
        method: "POST",
        body: JSON.stringify({
          personId: "race-a",
          otherPersonId: "race-b",
        }),
      }),
      authFetch("/api/customers/link", {
        apiKey,
        method: "POST",
        body: JSON.stringify({
          personId: "race-a",
          otherPersonId: "race-c",
        }),
      }),
    ]);

    expect(ab.status).toBe(200);
    expect(ac.status).toBe(200);

    const customerRows = await db.select().from(customers);
    expect(customerRows).toHaveLength(1);
    const scope = await resolveCustomerScope(db, "race-a");
    expect(new Set(scope.personIds)).toEqual(
      new Set(["race-a", "race-b", "race-c"]),
    );
    const memberships = await db.select().from(customerPeople);
    expect(memberships).toHaveLength(3);
    expect(new Set(memberships.map((row) => row.customerId))).toEqual(
      new Set([customerRows[0].id]),
    );
  });

  it("returns 404 when either person is outside the caller's existing visibility", async () => {
    const { userId, apiKey } = await createTestUser({
      id: "identity-member",
      role: "member",
      email: "identity-member@example.com",
    });
    const db = getDb();
    const now = Math.floor(Date.now() / 1000);
    await db.insert(inboxPermissions).values({
      userId,
      email: "allowed@example.com",
      createdAt: now,
      createdBy: null,
    });
    await createTestPerson({ id: "visible", email: "visible@example.com" });
    await createTestPerson({ id: "hidden", email: "hidden@example.com" });
    await createTestEmail({
      id: "visible-mail",
      personId: "visible",
      recipient: "allowed@example.com",
      messageId: "visible@example.test",
    });
    await createTestEmail({
      id: "hidden-mail",
      personId: "hidden",
      recipient: "denied@example.com",
      messageId: "hidden@example.test",
    });

    const res = await authFetch("/api/customers/link", {
      apiKey,
      method: "POST",
      body: JSON.stringify({
        personId: "visible",
        otherPersonId: "hidden",
      }),
    });
    expect(res.status).toBe(404);
    expect(await db.select().from(customers)).toHaveLength(0);
  });

  it("widens a customer timeline without widening inbox permission scope", async () => {
    const db = getDb();
    const allowed = { isAdmin: true as const };
    await createTestPerson({ id: "scope-a", email: "a@example.com" });
    await createTestPerson({ id: "scope-b", email: "b@example.com" });
    const linked = await linkPeople(db, allowed, null, "scope-a", "scope-b");
    await createTestEmail({
      id: "scope-a-mail",
      personId: "scope-a",
      recipient: "allowed@example.com",
      messageId: "scope-a@example.test",
    });
    await createTestEmail({
      id: "scope-b-mail",
      personId: "scope-b",
      recipient: "allowed@example.com",
      messageId: "scope-b@example.test",
    });
    await createTestEmail({
      id: "scope-b-denied",
      personId: "scope-b",
      recipient: "denied@example.com",
      messageId: "scope-b-denied@example.test",
    });

    const page = await queryMessages(
      db,
      { isAdmin: false, inboxes: ["allowed@example.com"] },
      { customerId: linked.customerId!, limit: 10 },
    );
    expect(page.messages.map((message) => message.ref.id).sort()).toEqual([
      "scope-a-mail",
      "scope-b-mail",
    ]);
  });

  it("returns only visible people from the customer read model", async () => {
    const db = getDb();
    await createTestPerson({ id: "view-a", email: "a@example.com" });
    await createTestPerson({ id: "view-b", email: "b@example.com" });
    await linkPeople(db, { isAdmin: true }, null, "view-a", "view-b");
    await createTestEmail({
      id: "view-a-mail",
      personId: "view-a",
      recipient: "allowed@example.com",
      messageId: "view-a@example.test",
    });
    await createTestEmail({
      id: "view-b-mail",
      personId: "view-b",
      recipient: "denied@example.com",
      messageId: "view-b@example.test",
    });

    const customer = await getCustomerByPerson(
      db,
      { isAdmin: false, inboxes: ["allowed@example.com"] },
      "view-a",
    );
    expect(customer?.people.map((person) => person.id)).toEqual(["view-a"]);
  });
});
