import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { applyMigrations, cleanDb, getDb } from "./helpers";
import { blocklist } from "../db/blocklist.schema";
import { isBlocked, domainOf } from "../lib/blocklist";

async function addRule(type: "email" | "domain", value: string) {
  await getDb()
    .insert(blocklist)
    .values({
      id: `blk-${type}-${value}`,
      type,
      value: value.toLowerCase(),
      createdAt: Math.floor(Date.now() / 1000),
    });
}

beforeAll(applyMigrations);
beforeEach(cleanDb);

describe("domainOf", () => {
  it("extracts the lowercased domain", () => {
    expect(domainOf("Alice@Example.COM")).toBe("example.com");
  });
});

describe("isBlocked", () => {
  it("returns false when nothing matches", async () => {
    expect(await isBlocked(getDb(), "alice@example.com")).toBe(false);
  });

  it("matches an exact email rule case-insensitively", async () => {
    await addRule("email", "alice@example.com");
    expect(await isBlocked(getDb(), "ALICE@example.com")).toBe(true);
  });

  it("matches a domain rule for any address at that domain", async () => {
    await addRule("domain", "spammer.com");
    expect(await isBlocked(getDb(), "anyone@spammer.com")).toBe(true);
  });

  it("does not match a lookalike domain", async () => {
    await addRule("domain", "spammer.com");
    expect(await isBlocked(getDb(), "x@notspammer.com")).toBe(false);
  });

  it("does not treat an email rule as a domain rule", async () => {
    await addRule("email", "alice@example.com");
    expect(await isBlocked(getDb(), "bob@example.com")).toBe(false);
  });
});
