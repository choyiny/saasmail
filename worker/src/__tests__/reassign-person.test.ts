import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import {
  applyMigrations,
  cleanDb,
  createTestUser,
  createTestPerson,
  createTestEmail,
  authFetch,
  getDb,
} from "./helpers";
import { people } from "../db/people.schema";
import { emails } from "../db/emails.schema";
import { inboxPermissions } from "../db/inbox-permissions.schema";
import { eq } from "drizzle-orm";

async function grantInbox(userId: string, email: string) {
  await getDb()
    .insert(inboxPermissions)
    .values({
      userId,
      email,
      createdAt: Math.floor(Date.now() / 1000),
      createdBy: null,
    });
}

function reassign(emailId: string, apiKey: string, body: unknown) {
  return authFetch(`/api/emails/${emailId}/person`, {
    apiKey,
    method: "PATCH",
    body: JSON.stringify(body),
  });
}

describe("reassign email to person", () => {
  let apiKey: string;

  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDb();
    ({ apiKey } = await createTestUser());
  });

  it("creates a new person and moves the email to them", async () => {
    await createTestPerson({ id: "p-old", email: "forms@site.test" });
    await createTestEmail({ id: "e1", personId: "p-old", isRead: 0 });

    const res = await reassign("e1", apiKey, {
      email: "Jane@Example.com",
      name: "Jane Doe",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      person: {
        id: string;
        email: string;
        name: string | null;
        created: boolean;
      };
      email: { personId: string };
    };
    expect(body.person.created).toBe(true);
    expect(body.person.email).toBe("jane@example.com"); // lower-cased
    expect(body.person.name).toBe("Jane Doe");

    const db = getDb();
    const email = await db
      .select()
      .from(emails)
      .where(eq(emails.id, "e1"))
      .get();
    expect(email?.personId).toBe(body.person.id);
    expect(body.email.personId).toBe(body.person.id);

    // New person exists with the canonical email.
    const newPerson = await db
      .select()
      .from(people)
      .where(eq(people.email, "jane@example.com"))
      .get();
    expect(newPerson?.id).toBe(body.person.id);
  });

  it("attaches to an existing person matched by email", async () => {
    await createTestPerson({ id: "p-old", email: "forms@site.test" });
    await createTestPerson({
      id: "p-existing",
      email: "real@example.com",
      name: "Real Person",
    });
    await createTestEmail({ id: "e1", personId: "p-old" });

    const res = await reassign("e1", apiKey, { email: "real@example.com" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      person: { id: string; created: boolean };
    };
    expect(body.person.created).toBe(false);
    expect(body.person.id).toBe("p-existing");

    const db = getDb();
    const email = await db
      .select()
      .from(emails)
      .where(eq(emails.id, "e1"))
      .get();
    expect(email?.personId).toBe("p-existing");
  });

  it("recomputes unread/total counts on both old and new person", async () => {
    // Old person owns two unread emails; we move one of them away.
    await createTestPerson({
      id: "p-old",
      email: "forms@site.test",
      unreadCount: 2,
      totalCount: 2,
    });
    await createTestEmail({ id: "e1", personId: "p-old", isRead: 0 });
    await createTestEmail({
      id: "e2",
      personId: "p-old",
      isRead: 0,
      messageId: "msg-2@example.com",
    });
    await createTestPerson({
      id: "p-new",
      email: "real@example.com",
      unreadCount: 0,
      totalCount: 0,
    });

    const res = await reassign("e1", apiKey, { email: "real@example.com" });
    expect(res.status).toBe(200);

    const db = getDb();
    const oldP = await db
      .select()
      .from(people)
      .where(eq(people.id, "p-old"))
      .get();
    const newP = await db
      .select()
      .from(people)
      .where(eq(people.id, "p-new"))
      .get();

    expect(oldP?.totalCount).toBe(1); // e2 remains
    expect(oldP?.unreadCount).toBe(1);
    expect(newP?.totalCount).toBe(1); // e1 moved in
    expect(newP?.unreadCount).toBe(1);
  });

  it("counts a read email as total but not unread on the new person", async () => {
    await createTestPerson({ id: "p-old", email: "forms@site.test" });
    await createTestEmail({ id: "e1", personId: "p-old", isRead: 1 });
    await createTestPerson({
      id: "p-new",
      email: "real@example.com",
      unreadCount: 0,
      totalCount: 0,
    });

    await reassign("e1", apiKey, { email: "real@example.com" });

    const db = getDb();
    const newP = await db
      .select()
      .from(people)
      .where(eq(people.id, "p-new"))
      .get();
    expect(newP?.totalCount).toBe(1);
    expect(newP?.unreadCount).toBe(0);
  });

  it("leaves conversation_id unchanged", async () => {
    await createTestPerson({ id: "p-old", email: "forms@site.test" });
    await createTestEmail({ id: "e1", personId: "p-old" });
    const db = getDb();
    await db
      .update(emails)
      .set({ conversationId: "c_keepme" })
      .where(eq(emails.id, "e1"));

    await reassign("e1", apiKey, { email: "real@example.com" });

    const email = await db
      .select()
      .from(emails)
      .where(eq(emails.id, "e1"))
      .get();
    expect(email?.conversationId).toBe("c_keepme");
  });

  it("is a no-op when the email already belongs to that person", async () => {
    await createTestPerson({
      id: "p-old",
      email: "alice@example.com",
      unreadCount: 1,
      totalCount: 1,
    });
    await createTestEmail({ id: "e1", personId: "p-old", isRead: 0 });

    const res = await reassign("e1", apiKey, { email: "alice@example.com" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { person: { id: string } };
    expect(body.person.id).toBe("p-old");

    const db = getDb();
    const email = await db
      .select()
      .from(emails)
      .where(eq(emails.id, "e1"))
      .get();
    expect(email?.personId).toBe("p-old");
  });

  it("does not clobber an existing person's name", async () => {
    await createTestPerson({ id: "p-old", email: "forms@site.test" });
    await createTestPerson({
      id: "p-existing",
      email: "real@example.com",
      name: "Original Name",
    });
    await createTestEmail({ id: "e1", personId: "p-old" });

    await reassign("e1", apiKey, {
      email: "real@example.com",
      name: "Should Be Ignored",
    });

    const db = getDb();
    const person = await db
      .select()
      .from(people)
      .where(eq(people.id, "p-existing"))
      .get();
    expect(person?.name).toBe("Original Name");
  });

  it("fills in a blank name on an existing person", async () => {
    await createTestPerson({ id: "p-old", email: "forms@site.test" });
    await getDb()
      .insert(people)
      .values({
        id: "p-noname",
        email: "real@example.com",
        name: null,
        lastEmailAt: Math.floor(Date.now() / 1000),
        unreadCount: 0,
        totalCount: 0,
        createdAt: Math.floor(Date.now() / 1000),
        updatedAt: Math.floor(Date.now() / 1000),
      });
    await createTestEmail({ id: "e1", personId: "p-old" });

    await reassign("e1", apiKey, {
      email: "real@example.com",
      name: "Now Named",
    });

    const db = getDb();
    const person = await db
      .select()
      .from(people)
      .where(eq(people.id, "p-noname"))
      .get();
    expect(person?.name).toBe("Now Named");
  });

  it("404s for a caller without permission on the inbox", async () => {
    await createTestPerson({ id: "p-old", email: "forms@site.test" });
    await createTestEmail({
      id: "e1",
      personId: "p-old",
      recipient: "support@saasmail.test",
    });
    const { apiKey: memberKey } = await createTestUser({
      id: "member-1",
      role: "member",
      email: "member@example.com",
    });
    // member has no grant for support@saasmail.test
    const res = await reassign("e1", memberKey, { email: "real@example.com" });
    expect(res.status).toBe(404);
  });

  it("allows a member who owns the inbox", async () => {
    await createTestPerson({ id: "p-old", email: "forms@site.test" });
    await createTestEmail({
      id: "e1",
      personId: "p-old",
      recipient: "support@saasmail.test",
    });
    const { userId, apiKey: memberKey } = await createTestUser({
      id: "member-2",
      role: "member",
      email: "member2@example.com",
    });
    await grantInbox(userId, "support@saasmail.test");

    const res = await reassign("e1", memberKey, { email: "real@example.com" });
    expect(res.status).toBe(200);
  });

  it("404s for an unknown email id", async () => {
    const res = await reassign("nope", apiKey, { email: "real@example.com" });
    expect(res.status).toBe(404);
  });
});
