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
import { inboxPermissions } from "../db/inbox-permissions.schema";

describe("GET /api/people/grouped — FTS search", () => {
  let apiKey: string;

  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDb();
    ({ apiKey } = await createTestUser());
  });

  it("returns people matched by email subject via FTS", async () => {
    await createTestPerson({
      id: "p1",
      email: "alice@test.com",
      name: "Alice",
    });
    await createTestPerson({ id: "p2", email: "bob@test.com", name: "Bob" });
    await createTestEmail({
      id: "e1",
      personId: "p1",
      subject: "Invoice for March",
    });
    await createTestEmail({
      id: "e2",
      personId: "p2",
      subject: "Hello there",
      messageId: "msg-2@test.com",
    });

    const res = await authFetch("/api/people/grouped?q=invoice", { apiKey });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toHaveLength(1);
    expect(body.data[0].id).toBe("p1");
  });

  it("returns people matched by email body text via FTS", async () => {
    await createTestPerson({
      id: "p1",
      email: "alice@test.com",
      name: "Alice",
    });
    await createTestPerson({ id: "p2", email: "bob@test.com", name: "Bob" });
    await createTestEmail({
      id: "e1",
      personId: "p1",
      subject: "Support request",
      bodyText: "My account password is not working",
    });
    await createTestEmail({
      id: "e2",
      personId: "p2",
      subject: "General inquiry",
      bodyText: "Just saying hello",
      messageId: "msg-2@test.com",
    });

    const res = await authFetch("/api/people/grouped?q=password", { apiKey });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toHaveLength(1);
    expect(body.data[0].id).toBe("p1");
  });

  it("still matches by person name via LIKE", async () => {
    await createTestPerson({
      id: "p1",
      email: "alice@test.com",
      name: "Alice",
    });
    await createTestEmail({ id: "e1", personId: "p1" });

    const res = await authFetch("/api/people/grouped?q=alice", { apiKey });
    const body = await res.json();
    expect(body.data).toHaveLength(1);
    expect(body.data[0].id).toBe("p1");
  });

  it("still matches by person email via LIKE", async () => {
    await createTestPerson({
      id: "p1",
      email: "alice@example.com",
      name: "Alice",
    });
    await createTestEmail({ id: "e1", personId: "p1" });

    const res = await authFetch("/api/people/grouped?q=example.com", {
      apiKey,
    });
    const body = await res.json();
    expect(body.data).toHaveLength(1);
    expect(body.data[0].id).toBe("p1");
  });

  it("returns empty when no match", async () => {
    await createTestPerson({ id: "p1", email: "alice@test.com" });
    await createTestEmail({ id: "e1", personId: "p1", subject: "Hello" });

    const res = await authFetch("/api/people/grouped?q=xyzzyunlikely", {
      apiKey,
    });
    const body = await res.json();
    expect(body.data).toHaveLength(0);
  });

  it("deduplicates when person matches both name and email content", async () => {
    await createTestPerson({
      id: "p1",
      email: "alice@test.com",
      name: "Alice",
    });
    await createTestEmail({
      id: "e1",
      personId: "p1",
      subject: "Alice needs help",
    });

    const res = await authFetch("/api/people/grouped?q=alice", { apiKey });
    const body = await res.json();
    expect(body.data).toHaveLength(1);
  });

  it("handles FTS special characters safely", async () => {
    await createTestPerson({ id: "p1", email: "alice@test.com" });
    await createTestEmail({ id: "e1", personId: "p1", subject: "Hello" });

    // These would crash an unescaped FTS MATCH query
    for (const q of ["AND", "OR", '"unclosed', "O'Brien"]) {
      const res = await authFetch(
        `/api/people/grouped?q=${encodeURIComponent(q)}`,
        { apiKey },
      );
      expect(res.status).toBe(200);
    }
  });

  it("does not leak FTS matches from inboxes a member cannot access", async () => {
    // Member has access to support@ only, not billing@
    const { userId: memberId, apiKey: memberKey } = await createTestUser({
      id: "member-1",
      role: "member",
      email: "member@example.com",
    });
    const db = getDb();
    const now = Math.floor(Date.now() / 1000);
    await db.insert(inboxPermissions).values({
      userId: memberId,
      email: "support@saasmail.test",
      createdAt: now,
      createdBy: memberId,
    });

    // Alice has emails in both inboxes — only the billing@ one mentions "salary"
    await createTestPerson({
      id: "p1",
      email: "alice@test.com",
      name: "Alice",
    });
    await createTestEmail({
      id: "e1",
      personId: "p1",
      recipient: "support@saasmail.test",
      subject: "General question",
      bodyText: "Just checking in",
    });
    await createTestEmail({
      id: "e2",
      personId: "p1",
      recipient: "billing@saasmail.test",
      subject: "Salary review",
      bodyText: "Details about salary",
      messageId: "msg-2@test.com",
    });

    // Member searches for "salary" — should get no results even though
    // Alice has a match, because the matching email is in a restricted inbox.
    const res = await authFetch("/api/people/grouped?q=salary", {
      apiKey: memberKey,
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toHaveLength(0);
  });
});
