import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { senderIdentities } from "../db/sender-identities.schema";
import { emails } from "../db/emails.schema";
import { people } from "../db/people.schema";
import { getDb, applyMigrations, cleanDb } from "./helpers";

beforeAll(async () => {
  await applyMigrations();
});

beforeEach(async () => {
  await cleanDb();
});

describe("sender_identities gmail mapping", () => {
  it("defaults source to cloudflare for an existing-style row", async () => {
    const db = getDb();
    const now = Math.floor(Date.now() / 1000);
    await db.insert(senderIdentities).values({
      email: "support@acme.dev",
      displayName: "Support",
      createdAt: now,
      updatedAt: now,
    });

    const [row] = await db
      .select()
      .from(senderIdentities)
      .where(eq(senderIdentities.email, "support@acme.dev"));

    expect(row.source).toBe("cloudflare");
    expect(row.gmailAccountId).toBeNull();
    expect(row.gmailGroupAddress).toBeNull();
  });

  it("stores a gmail-sourced inbox mapped to an account and a group address", async () => {
    const db = getDb();
    const now = Math.floor(Date.now() / 1000);
    await db.insert(senderIdentities).values({
      email: "support@acme.dev",
      displayName: "Support",
      source: "gmail",
      gmailAccountId: "acct-1",
      gmailGroupAddress: "support@acme.dev",
      createdAt: now,
      updatedAt: now,
    });

    const [row] = await db
      .select()
      .from(senderIdentities)
      .where(eq(senderIdentities.email, "support@acme.dev"));

    expect(row.source).toBe("gmail");
    expect(row.gmailAccountId).toBe("acct-1");
    expect(row.gmailGroupAddress).toBe("support@acme.dev");
  });

  it("allows a personal mailbox mapping with no group filter", async () => {
    const db = getDb();
    const now = Math.floor(Date.now() / 1000);
    await db.insert(senderIdentities).values({
      email: "cho@acme.dev",
      source: "gmail",
      gmailAccountId: "acct-2",
      gmailGroupAddress: null,
      createdAt: now,
      updatedAt: now,
    });

    const [row] = await db
      .select()
      .from(senderIdentities)
      .where(eq(senderIdentities.email, "cho@acme.dev"));

    expect(row.gmailGroupAddress).toBeNull();
    expect(row.source).toBe("gmail");
  });
});

describe("emails gmail identifiers", () => {
  it("stores gmail message and thread ids", async () => {
    const db = getDb();
    const now = Math.floor(Date.now() / 1000);
    await db.insert(people).values({
      id: "p1",
      email: "jane@example.com",
      lastEmailAt: now,
      unreadCount: 0,
      totalCount: 1,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(emails).values({
      id: "e1",
      personId: "p1",
      recipient: "support@acme.dev",
      subject: "Hi",
      messageId: "<m1@example.com>",
      gmailMessageId: "18c9f0",
      gmailThreadId: "18c9ee",
      receivedAt: now,
      createdAt: now,
    });

    const [row] = await db.select().from(emails).where(eq(emails.id, "e1"));
    expect(row.gmailMessageId).toBe("18c9f0");
    expect(row.gmailThreadId).toBe("18c9ee");
  });

  it("leaves the gmail ids null for a Cloudflare-sourced email", async () => {
    const db = getDb();
    const now = Math.floor(Date.now() / 1000);
    await db.insert(people).values({
      id: "p1",
      email: "jane@example.com",
      lastEmailAt: now,
      unreadCount: 0,
      totalCount: 1,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(emails).values({
      id: "e1",
      personId: "p1",
      recipient: "support@acme.dev",
      messageId: "<m2@example.com>",
      receivedAt: now,
      createdAt: now,
    });

    const [row] = await db.select().from(emails).where(eq(emails.id, "e1"));
    expect(row.gmailMessageId).toBeNull();
    expect(row.gmailThreadId).toBeNull();
  });
});
