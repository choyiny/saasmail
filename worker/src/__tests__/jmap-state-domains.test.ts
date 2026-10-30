// Cleanup spec §1: each JMAP state has one source.
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  applyMigrations,
  authFetch,
  cleanDb,
  createTestEmail,
  createTestPerson,
  createTestUser,
  getDb,
} from "./helpers";
import { senderIdentities } from "../db/sender-identities.schema";
import { recordingSender, runJmap } from "./jmap-harness";
import { acct } from "./jmap-ids";

const INBOX = "inbox@saasmail.test";

async function session(apiKey: string) {
  return (await authFetch("/.well-known/jmap", { apiKey })).json<
    Record<string, any>
  >();
}

describe("JMAP state domains", () => {
  let userId: string;
  let apiKey: string;

  beforeAll(async () => {
    await applyMigrations();
  });
  beforeEach(async () => {
    await cleanDb();
    ({ userId, apiKey } = await createTestUser({ id: "state-user" }));
    const now = Math.floor(Date.now() / 1000);
    await getDb().insert(senderIdentities).values({
      email: INBOX,
      displayName: "Inbox",
      createdAt: now,
      updatedAt: now,
    });
    await createTestPerson({ id: "p1", email: "c@example.com" });
  });

  it("the Session state doesn't change when mail arrives", async () => {
    const before = (await session(apiKey)).state;
    await createTestEmail({ id: "m1", personId: "p1", recipient: INBOX });
    expect((await session(apiKey)).state).toBe(before);
  });

  it("the Session state changes when the Session changes (an inbox appears)", async () => {
    const before = (await session(apiKey)).state;
    const now = Math.floor(Date.now() / 1000);
    await getDb()
      .insert(senderIdentities)
      .values({ email: "new@saasmail.test", createdAt: now, updatedAt: now });
    expect((await session(apiKey)).state).not.toBe(before);
  });

  it("Email/query's queryState is the change-log state, and moves with a change in the same second", async () => {
    const { sender } = recordingSender();
    const query = async () => {
      const [response] = await runJmap(
        userId,
        [["Email/query", { accountId: acct(userId) }, "q"]],
        sender,
      );
      return (response[1] as Record<string, any>).queryState as string;
    };
    const first = await query();
    expect(first).toMatch(/^j\d+-\d+-\d+-[0-9a-f]{16}$/);
    await createTestEmail({ id: "m1", personId: "p1", recipient: INBOX });
    const second = await query();
    await createTestEmail({
      id: "m2",
      personId: "p1",
      recipient: INBOX,
      messageId: "m2@example.com",
    });
    expect(second).not.toBe(first);
    expect(await query()).not.toBe(second);
  });

  it("the Identity state changes with a display name, and is what Identity/set compares", async () => {
    const { sender } = recordingSender();
    const get = async () => {
      const [response] = await runJmap(
        userId,
        [["Identity/get", { accountId: acct(userId) }, "i"]],
        sender,
      );
      return (response[1] as Record<string, any>).state as string;
    };
    const before = await get();
    await getDb()
      .update(senderIdentities)
      .set({ displayName: "Renamed" })
      .where(eq(senderIdentities.email, INBOX));
    const after = await get();
    expect(after).not.toBe(before);

    const [stale, current] = await runJmap(
      userId,
      [
        ["Identity/set", { accountId: acct(userId), ifInState: before }, "s1"],
        ["Identity/set", { accountId: acct(userId), ifInState: after }, "s2"],
      ],
      sender,
    );
    expect(stale[0]).toBe("error");
    expect((stale[1] as Record<string, any>).type).toBe("stateMismatch");
    expect(current[0]).toBe("Identity/set");
  });
});
