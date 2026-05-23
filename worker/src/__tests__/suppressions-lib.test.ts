import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { applyMigrations, cleanDb, getDb } from "./helpers";
import { suppressions } from "../db/suppressions.schema";
import { isSuppressed } from "../lib/suppressions";

async function insertSuppression(email: string) {
  const db = getDb();
  await db.insert(suppressions).values({
    id: `sup-${email}`,
    email: email.toLowerCase(),
    reason: "unsubscribe",
    createdAt: Math.floor(Date.now() / 1000),
  });
}

describe("isSuppressed", () => {
  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDb();
  });

  it("returns false when the email is not on the list", async () => {
    const db = getDb();
    expect(await isSuppressed(db, "alice@example.com")).toBe(false);
  });

  it("returns true for an exact-match email", async () => {
    await insertSuppression("alice@example.com");
    const db = getDb();
    expect(await isSuppressed(db, "alice@example.com")).toBe(true);
  });

  it("matches case-insensitively", async () => {
    await insertSuppression("alice@example.com");
    const db = getDb();
    expect(await isSuppressed(db, "Alice@Example.COM")).toBe(true);
  });

  it("does NOT strip Gmail plus-tags (exact normalized match only)", async () => {
    await insertSuppression("user+a@gmail.com");
    const db = getDb();
    expect(await isSuppressed(db, "user@gmail.com")).toBe(false);
    expect(await isSuppressed(db, "user+a@gmail.com")).toBe(true);
  });
});
