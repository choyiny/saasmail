import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { applyMigrations, cleanDb, getDb } from "./helpers";
import { people } from "../db/people.schema";
import { findPersonIdByEmail } from "../lib/find-person";

beforeAll(applyMigrations);
beforeEach(cleanDb);

const now = () => Math.floor(Date.now() / 1000);

async function addPerson(email: string, id = `p-${email}`) {
  await getDb().insert(people).values({
    id,
    email,
    name: null,
    lastEmailAt: now(),
    unreadCount: 0,
    totalCount: 0,
    createdAt: now(),
    updatedAt: now(),
  });
  return id;
}

async function personCount() {
  const rows = await getDb().select({ id: people.id }).from(people);
  return rows.length;
}

describe("findPersonIdByEmail", () => {
  it("returns the id of an existing person", async () => {
    const id = await addPerson("alice@example.com");
    expect(await findPersonIdByEmail(getDb(), "alice@example.com")).toBe(id);
  });

  it("matches case-insensitively, since callers pass raw subscriber input", async () => {
    const id = await addPerson("alice@example.com");
    expect(await findPersonIdByEmail(getDb(), "ALICE@Example.COM")).toBe(id);
  });

  it("returns null for an unknown address", async () => {
    expect(await findPersonIdByEmail(getDb(), "nobody@example.com")).toBeNull();
  });

  /**
   * The whole point of this helper. A find-or-create on
   * the campaign send path would insert one `people` row per recipient — up to
   * 10,000 per blast — burying real correspondents in a view ordered by
   * `people_last_email_at_idx`. Looking up an unknown address must be a pure
   * read.
   */
  it("never creates a people row for an unknown address", async () => {
    expect(await personCount()).toBe(0);
    await findPersonIdByEmail(getDb(), "nobody@example.com");
    expect(await personCount()).toBe(0);
  });

  it("leaves the existing people rows untouched when it does find a match", async () => {
    await addPerson("alice@example.com");
    await addPerson("bob@example.com");
    await findPersonIdByEmail(getDb(), "alice@example.com");
    expect(await personCount()).toBe(2);
  });
});
