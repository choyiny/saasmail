import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { applyMigrations, cleanDb, getDb } from "./helpers";
import { outboxEmails } from "../db/outbox-emails.schema";

describe("outbox_emails table", () => {
  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDb();
  });

  it("round-trips an outbox row", async () => {
    const db = getDb();
    const now = Math.floor(Date.now() / 1000);
    await db.insert(outboxEmails).values({
      id: "ob-1",
      sentEmailId: "se-1",
      fromAddress: "me@saasmail.test",
      toAddress: "to@example.com",
      subject: "Hi",
      bodyHtml: "<p>Hi</p>",
      transactional: 0,
      status: "pending",
      attempts: 1,
      lastError: "quota exceeded",
      nextRetryAt: now,
      createdAt: now,
      updatedAt: now,
    });
    const rows = await db
      .select()
      .from(outboxEmails)
      .where(eq(outboxEmails.id, "ob-1"));
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("pending");
    expect(rows[0].sequenceEmailId).toBeNull();
  });
});
