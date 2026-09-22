import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { sentEmails } from "../db/sent-emails.schema";
import { getDb, applyMigrations, cleanDb } from "./helpers";

beforeAll(async () => {
  await applyMigrations();
});

beforeEach(async () => {
  await cleanDb();
});

describe("sent_emails gmail identifiers", () => {
  it("stores gmail message and thread ids", async () => {
    const db = getDb();
    const now = Math.floor(Date.now() / 1000);
    await db.insert(sentEmails).values({
      id: "se1",
      fromAddress: "support@acme.dev",
      toAddress: "jane@example.com",
      subject: "Re: Hi",
      gmailMessageId: "18c9f0",
      gmailThreadId: "18c9ee",
      sentAt: now,
      createdAt: now,
    });

    const [row] = await db
      .select()
      .from(sentEmails)
      .where(eq(sentEmails.id, "se1"));
    expect(row.gmailMessageId).toBe("18c9f0");
    expect(row.gmailThreadId).toBe("18c9ee");
  });

  it("leaves the gmail ids null for Cloudflare-sent mail", async () => {
    const db = getDb();
    const now = Math.floor(Date.now() / 1000);
    await db.insert(sentEmails).values({
      id: "se2",
      fromAddress: "support@acme.dev",
      toAddress: "jane@example.com",
      subject: "Hi",
      sentAt: now,
      createdAt: now,
    });

    const [row] = await db
      .select()
      .from(sentEmails)
      .where(eq(sentEmails.id, "se2"));
    expect(row.gmailMessageId).toBeNull();
    expect(row.gmailThreadId).toBeNull();
  });

  it("allows two rows to share a gmailThreadId, since every message in a Gmail conversation shares one", async () => {
    const db = getDb();
    const now = Math.floor(Date.now() / 1000);
    await db.insert(sentEmails).values([
      {
        id: "se3",
        fromAddress: "support@acme.dev",
        toAddress: "jane@example.com",
        subject: "Hi",
        gmailMessageId: "msg-a",
        gmailThreadId: "thread-shared",
        sentAt: now,
        createdAt: now,
      },
      {
        id: "se4",
        fromAddress: "support@acme.dev",
        toAddress: "jane@example.com",
        subject: "Re: Hi",
        gmailMessageId: "msg-b",
        gmailThreadId: "thread-shared",
        sentAt: now,
        createdAt: now,
      },
    ]);

    const rows = await db
      .select()
      .from(sentEmails)
      .where(eq(sentEmails.gmailThreadId, "thread-shared"));
    expect(rows.map((r) => r.id).sort()).toEqual(["se3", "se4"]);
  });
});
