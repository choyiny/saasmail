import { describe, it, expect, beforeAll } from "vitest";
import { eq } from "drizzle-orm";
import { gmailAccounts } from "../db/gmail-accounts.schema";
import { getDb, applyMigrations } from "./helpers";

describe("gmail_accounts", () => {
  beforeAll(async () => {
    await applyMigrations();
  });

  it("stores and reads back a connected account", async () => {
    const db = getDb();
    const now = Math.floor(Date.now() / 1000);
    await db.insert(gmailAccounts).values({
      id: "acct-1",
      emailAddress: "collector@xyspace.dev",
      refreshTokenEncrypted: "sealed-blob",
      accessToken: null,
      expiresAt: null,
      historyId: "12345",
      lastSyncedAt: null,
      lastError: null,
      connectedBy: "user-1",
      createdAt: now,
      updatedAt: now,
    });

    const [row] = await db
      .select()
      .from(gmailAccounts)
      .where(eq(gmailAccounts.id, "acct-1"));

    expect(row.emailAddress).toBe("collector@xyspace.dev");
    expect(row.historyId).toBe("12345");
    expect(row.lastError).toBeNull();
  });

  it("rejects a duplicate mailbox address", async () => {
    const db = getDb();
    const now = Math.floor(Date.now() / 1000);
    await expect(
      db.insert(gmailAccounts).values({
        id: "acct-2",
        emailAddress: "collector@xyspace.dev",
        refreshTokenEncrypted: "another-blob",
        historyId: "999",
        connectedBy: "user-1",
        createdAt: now,
        updatedAt: now,
      }),
    ).rejects.toThrow();
  });
});
