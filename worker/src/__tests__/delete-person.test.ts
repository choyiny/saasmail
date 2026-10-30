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
import { attachments } from "../db/attachments.schema";
import { emails } from "../db/emails.schema";
import { sentEmails } from "../db/sent-emails.schema";
import { people } from "../db/people.schema";
import { customerPeople, customers } from "../db/customers.schema";
import { eq } from "drizzle-orm";

describe("DELETE /api/people/:id", () => {
  let adminKey: string;
  let memberKey: string;

  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDb();
    ({ apiKey: adminKey } = await createTestUser({
      id: "admin-1",
      role: "admin",
    }));
    ({ apiKey: memberKey } = await createTestUser({
      id: "member-1",
      role: "member",
      email: "member@example.com",
    }));
  });

  it("deletes a person and all their emails", async () => {
    await createTestPerson({ id: "p1", email: "alice@test.com" });
    await createTestEmail({ id: "e1", personId: "p1" });
    await createTestEmail({
      id: "e2",
      personId: "p1",
      messageId: "msg-2@test.com",
    });

    const res = await authFetch("/api/people/p1", {
      apiKey: adminKey,
      method: "DELETE",
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);

    const db = getDb();
    const personRows = await db
      .select()
      .from(people)
      .where(eq(people.id, "p1"));
    expect(personRows).toHaveLength(0);

    const emailRows = await db
      .select()
      .from(emails)
      .where(eq(emails.personId, "p1"));
    expect(emailRows).toHaveLength(0);
  });

  it("cascades to attachment DB records", async () => {
    await createTestPerson({ id: "p1", email: "alice@test.com" });
    await createTestEmail({ id: "e1", personId: "p1", isRead: 1 });

    const db = getDb();
    const now = Math.floor(Date.now() / 1000);
    await db.insert(attachments).values({
      id: "att-1",
      emailId: "e1",
      filename: "file.pdf",
      contentType: "application/pdf",
      size: 512,
      r2Key: "attachments/e1/file.pdf",
      contentId: null,
      createdAt: now,
    });

    const res = await authFetch("/api/people/p1", {
      apiKey: adminKey,
      method: "DELETE",
    });
    expect(res.status).toBe(200);

    const attRows = await db
      .select()
      .from(attachments)
      .where(eq(attachments.emailId, "e1"));
    expect(attRows).toHaveLength(0);
  });

  it("cascades to sent emails", async () => {
    await createTestPerson({ id: "p1", email: "alice@test.com" });

    const db = getDb();
    const now = Math.floor(Date.now() / 1000);
    await db.insert(sentEmails).values({
      id: "se1",
      personId: "p1",
      fromAddress: "us@saasmail.test",
      toAddress: "alice@test.com",
      subject: "Hello",
      bodyHtml: "<p>Hi</p>",
      bodyText: "Hi",
      status: "sent",
      sentAt: now,
      createdAt: now,
    });

    await authFetch("/api/people/p1", { apiKey: adminKey, method: "DELETE" });

    const seRows = await db
      .select()
      .from(sentEmails)
      .where(eq(sentEmails.personId, "p1"));
    expect(seRows).toHaveLength(0);
  });

  it("dissolves a two-person customer when one person is deleted", async () => {
    await createTestPerson({ id: "linked-1", email: "linked-1@test.com" });
    await createTestPerson({ id: "linked-2", email: "linked-2@test.com" });
    await createTestEmail({
      id: "linked-email-1",
      personId: "linked-1",
      messageId: "linked-1@test.com",
    });
    const db = getDb();
    const now = Math.floor(Date.now() / 1000);
    await db.insert(customers).values({
      id: "delete-customer",
      displayName: null,
      createdBy: null,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(customerPeople).values([
      {
        customerId: "delete-customer",
        personId: "linked-1",
        linkedBy: null,
        linkedAt: now,
      },
      {
        customerId: "delete-customer",
        personId: "linked-2",
        linkedBy: null,
        linkedAt: now,
      },
    ]);

    const res = await authFetch("/api/people/linked-1", {
      apiKey: adminKey,
      method: "DELETE",
    });
    expect(res.status).toBe(200);
    expect(
      await db
        .select()
        .from(customers)
        .where(eq(customers.id, "delete-customer")),
    ).toHaveLength(0);
    expect(
      await db
        .select()
        .from(customerPeople)
        .where(eq(customerPeople.personId, "linked-2")),
    ).toHaveLength(0);
  });

  it("returns 403 for non-admin users", async () => {
    await createTestPerson({ id: "p1", email: "alice@test.com" });
    await createTestEmail({ id: "e1", personId: "p1" });

    const res = await authFetch("/api/people/p1", {
      apiKey: memberKey,
      method: "DELETE",
    });
    expect(res.status).toBe(403);

    // Person should still exist
    const db = getDb();
    const rows = await db.select().from(people).where(eq(people.id, "p1"));
    expect(rows).toHaveLength(1);
  });

  it("returns 404 for unknown person", async () => {
    const res = await authFetch("/api/people/nonexistent", {
      apiKey: adminKey,
      method: "DELETE",
    });
    expect(res.status).toBe(404);
  });

  it("does not affect other people's emails", async () => {
    await createTestPerson({ id: "p1", email: "alice@test.com" });
    await createTestPerson({ id: "p2", email: "bob@test.com" });
    await createTestEmail({ id: "e1", personId: "p1" });
    await createTestEmail({
      id: "e2",
      personId: "p2",
      messageId: "msg-2@test.com",
    });

    await authFetch("/api/people/p1", { apiKey: adminKey, method: "DELETE" });

    const db = getDb();
    const bobEmails = await db
      .select()
      .from(emails)
      .where(eq(emails.personId, "p2"));
    expect(bobEmails).toHaveLength(1);

    const bobPerson = await db.select().from(people).where(eq(people.id, "p2"));
    expect(bobPerson).toHaveLength(1);
  });
});
