import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { applyMigrations, cleanDb, getDb } from "./helpers";
import { people } from "../db/people.schema";
import { senderIdentities } from "../db/sender-identities.schema";
import {
  findOrCreatePersonId,
  outboundConversationId,
} from "../lib/sent-bookkeeping";

describe("sent bookkeeping", () => {
  beforeAll(async () => {
    await applyMigrations();
  });
  beforeEach(async () => {
    await cleanDb();
  });

  it("creates a person once and returns the same id afterwards", async () => {
    const first = await findOrCreatePersonId(getDb(), "bob@example.com", 100);
    const second = await findOrCreatePersonId(getDb(), "bob@example.com", 200);
    expect(second).toBe(first);
    expect(await getDb().select().from(people)).toHaveLength(1);
  });

  it("hashes a conversation from external participants only", async () => {
    await getDb().insert(senderIdentities).values({
      email: "mine@saasmail.test",
      createdAt: 1,
      updatedAt: 1,
    });
    const db = getDb();
    expect(
      await outboundConversationId(
        db,
        "mine@saasmail.test",
        "bob@example.com",
        ["teammate@saasmail.test"],
      ),
    ).toBeNull();
    const id = await outboundConversationId(
      db,
      "mine@saasmail.test",
      "bob@example.com",
      ["carol@example.com"],
    );
    expect(id).toMatch(/^c_[0-9a-f]{16}$/);
    expect(
      await outboundConversationId(
        db,
        "mine@saasmail.test",
        "carol@example.com",
        ["bob@example.com"],
      ),
    ).toBe(id);
  });
});
