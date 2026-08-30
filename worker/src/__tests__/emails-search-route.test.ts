import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import {
  applyMigrations,
  cleanDb,
  createTestUser,
  createTestPerson,
  createTestEmail,
  authFetch,
} from "./helpers";

describe("GET /api/emails/search", () => {
  let apiKey: string;

  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDb();
    ({ apiKey } = await createTestUser());
  });

  it("returns message-level hits matching the query, scoped to allowed inboxes", async () => {
    await createTestPerson({ id: "s1", email: "alice@example.com" });
    await createTestEmail({
      id: "e1",
      personId: "s1",
      subject: "Invoice for March",
      bodyText: "amount due",
    });
    await createTestEmail({
      id: "e2",
      personId: "s1",
      subject: "Lunch plans",
      bodyText: "burritos",
      messageId: "msg-2@example.com",
    });

    const res = await authFetch("/api/emails/search?q=invoice", { apiKey });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      hits: Array<{ subject: string | null }>;
      hasMore: boolean;
      truncated: boolean;
    };
    expect(body.hits.length).toBe(1);
    expect(body.hits[0].subject).toContain("Invoice");
    expect(typeof body.hasMore).toBe("boolean");
    expect(typeof body.truncated).toBe("boolean");
  });

  it("requires a non-empty q", async () => {
    const res = await authFetch("/api/emails/search?q=", { apiKey });
    expect(res.status).toBe(400);
  });
});
