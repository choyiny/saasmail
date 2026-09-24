import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import {
  applyMigrations,
  authFetch,
  cleanDb,
  createTestEmail,
  createTestPerson,
  createTestUser,
  getDb,
} from "./helpers";
import { emails } from "../db/emails.schema";
import { inboxPermissions } from "../db/inbox-permissions.schema";
import { inboxConversationState } from "../db/inbox-conversation-state.schema";
import { jmapChanges } from "../db/jmap-changes.schema";
import { mailboxes } from "../db/mailboxes.schema";
import { messageUserState } from "../db/message-user-state.schema";
import { senderIdentities } from "../db/sender-identities.schema";
import { setUserState } from "../lib/messages/state";
import { CORE_CAPABILITY, MAIL_CAPABILITY } from "../jmap/constants";

const MINE = "mine@saasmail.test";
const OTHER = "other@saasmail.test";

async function jmapJson(apiKey: string, methodCalls: unknown[]) {
  const response = await authFetch("/jmap/api", {
    method: "POST",
    apiKey,
    body: JSON.stringify({
      using: [CORE_CAPABILITY, MAIL_CAPABILITY],
      methodCalls,
    }),
  });
  expect(response.status).toBe(200);
  return response.json() as Promise<{
    methodResponses: [string, Record<string, any>, string][];
  }>;
}

async function member(id: string, inbox = MINE) {
  const { userId, apiKey } = await createTestUser({
    id,
    role: "member",
    email: `${id}@example.com`,
  });
  await getDb()
    .insert(inboxPermissions)
    .values({
      userId,
      email: inbox,
      createdAt: Math.floor(Date.now() / 1000),
      createdBy: null,
    });
  return { userId, apiKey };
}

async function stateFor(apiKey: string, userId: string) {
  const result = await jmapJson(apiKey, [
    ["Email/get", { accountId: userId, ids: [] }, "g"],
  ]);
  return result.methodResponses[0][1].state as string;
}

describe("JMAP changes and snooze projection", () => {
  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDb();
  });

  it("classifies created, updated, destroyed and omits create-then-destroy", async () => {
    const { userId, apiKey } = await member("changes-classify");
    await createTestPerson({
      id: "changes-person",
      email: "person@example.com",
    });
    await createTestEmail({
      id: "existing-update",
      personId: "changes-person",
      recipient: MINE,
      messageId: "existing-update@example.com",
    });
    await createTestEmail({
      id: "existing-delete",
      personId: "changes-person",
      recipient: MINE,
      messageId: "existing-delete@example.com",
    });
    const sinceState = await stateFor(apiKey, userId);

    await createTestEmail({
      id: "created-email",
      personId: "changes-person",
      recipient: MINE,
      messageId: "created-email@example.com",
    });
    await getDb()
      .update(emails)
      .set({ subject: "changed" })
      .where(eq(emails.id, "existing-update"));
    await getDb().delete(emails).where(eq(emails.id, "existing-delete"));
    await createTestEmail({
      id: "ephemeral-email",
      personId: "changes-person",
      recipient: MINE,
      messageId: "ephemeral-email@example.com",
    });
    await getDb().delete(emails).where(eq(emails.id, "ephemeral-email"));

    const result = await jmapJson(apiKey, [
      ["Email/changes", { accountId: userId, sinceState }, "c"],
    ]);
    const changes = result.methodResponses[0][1];
    expect(changes.created).toEqual(["received:created-email"]);
    expect(changes.updated).toEqual(["received:existing-update"]);
    expect(changes.destroyed).toEqual(["received:existing-delete"]);
    expect(changes.updatedProperties).toBeNull();
  });

  it("keeps personal seen changes private and other inbox changes out of scope", async () => {
    const first = await member("changes-first");
    const second = await member("changes-second");
    await createTestPerson({
      id: "privacy-person",
      email: "privacy@example.com",
    });
    await createTestEmail({
      id: "privacy-email",
      personId: "privacy-person",
      recipient: MINE,
      messageId: "privacy-email@example.com",
    });
    const secondState = await stateFor(second.apiKey, second.userId);

    await setUserState(
      getDb(),
      first.userId,
      [{ kind: "received", id: "privacy-email" }],
      { seen: true },
    );
    await createTestEmail({
      id: "other-inbox-email",
      personId: "privacy-person",
      recipient: OTHER,
      messageId: "other-inbox-email@example.com",
    });

    const result = await jmapJson(second.apiKey, [
      [
        "Email/changes",
        { accountId: second.userId, sinceState: secondState },
        "c",
      ],
    ]);
    expect(result.methodResponses[0][1]).toEqual(
      expect.objectContaining({
        created: [],
        updated: [],
        destroyed: [],
        hasMoreChanges: false,
      }),
    );
  });

  it("pages changes without duplicates and finishes at Email/get state", async () => {
    const { userId, apiKey } = await member("changes-page");
    await createTestPerson({ id: "page-person", email: "page@example.com" });
    const sinceState = await stateFor(apiKey, userId);
    for (let index = 0; index < 5; index += 1) {
      await createTestEmail({
        id: `page-${index}`,
        personId: "page-person",
        recipient: MINE,
        messageId: `page-${index}@example.com`,
      });
    }

    const seen: string[] = [];
    let state = sinceState;
    let finalState = "";
    for (let page = 0; page < 3; page += 1) {
      const result = await jmapJson(apiKey, [
        [
          "Email/changes",
          { accountId: userId, sinceState: state, maxChanges: 2 },
          "c",
        ],
      ]);
      const changes = result.methodResponses[0][1];
      seen.push(...changes.created, ...changes.updated, ...changes.destroyed);
      state = changes.newState;
      finalState = changes.newState;
      if (!changes.hasMoreChanges) break;
    }

    expect(new Set(seen)).toEqual(
      new Set(
        Array.from({ length: 5 }, (_, index) => `received:page-${index}`),
      ),
    );
    expect(seen).toHaveLength(5);
    expect(finalState).toBe(await stateFor(apiKey, userId));
  });

  it("rejects changed inbox fingerprints, expired states, oversized windows and maxChanges zero", async () => {
    const { userId, apiKey } = await member("changes-invalid");
    const baseState = await stateFor(apiKey, userId);

    await getDb()
      .insert(inboxPermissions)
      .values({
        userId,
        email: OTHER,
        createdAt: Math.floor(Date.now() / 1000),
        createdBy: null,
      });
    let result = await jmapJson(apiKey, [
      ["Email/changes", { accountId: userId, sinceState: baseState }, "c1"],
    ]);
    expect(result.methodResponses[0]).toEqual([
      "error",
      expect.objectContaining({ type: "cannotCalculateChanges" }),
      "c1",
    ]);

    const freshState = await stateFor(apiKey, userId);
    const [, seq, , fp] = freshState.split("-");
    const oldIssuedAt = Math.floor(Date.now() / 1000) - 30 * 24 * 60 * 60;
    const oldState = `j1-${seq}-${oldIssuedAt}-${fp}`;
    result = await jmapJson(apiKey, [
      ["Email/changes", { accountId: userId, sinceState: oldState }, "c2"],
    ]);
    expect(result.methodResponses[0][1].type).toBe("cannotCalculateChanges");

    result = await jmapJson(apiKey, [
      [
        "Email/changes",
        { accountId: userId, sinceState: freshState, maxChanges: 0 },
        "c3",
      ],
    ]);
    expect(result.methodResponses[0][1].type).toBe("invalidArguments");

    await getDb().run(sql`
      WITH RECURSIVE n(x) AS (
        SELECT 1
        UNION ALL
        SELECT x + 1 FROM n WHERE x < 10001
      )
      INSERT INTO jmap_changes (object_type, object_id, inbox, user_id, op, created_at)
      SELECT 'email', 'received:bulk-' || x, ${MINE}, NULL, 'u',
             CAST(strftime('%s','now') AS INTEGER)
      FROM n
    `);
    result = await jmapJson(apiKey, [
      ["Email/changes", { accountId: userId, sinceState: freshState }, "c4"],
    ]);
    expect(result.methodResponses[0][1].type).toBe("cannotCalculateChanges");
  });

  it("reports mailbox count changes and custom mailbox create/delete changes", async () => {
    const { userId, apiKey } = await member("mailbox-changes");
    await createTestPerson({
      id: "mailbox-change-person",
      email: "mb@example.com",
    });
    let sinceState = await stateFor(apiKey, userId);
    await createTestEmail({
      id: "mailbox-count-email",
      personId: "mailbox-change-person",
      recipient: MINE,
      messageId: "mailbox-count-email@example.com",
    });

    let result = await jmapJson(apiKey, [
      ["Mailbox/changes", { accountId: userId, sinceState }, "m1"],
    ]);
    expect(result.methodResponses[0][1].updatedProperties).toEqual([
      "totalEmails",
      "unreadEmails",
      "totalThreads",
      "unreadThreads",
    ]);
    expect(result.methodResponses[0][1].updated).toContain(`sys:${MINE}:inbox`);

    sinceState = result.methodResponses[0][1].newState;
    await getDb().insert(mailboxes).values({
      id: "changes-folder",
      inbox: MINE,
      name: "Changes",
      role: null,
      parentId: null,
      sortOrder: 0,
      createdBy: userId,
      createdAt: 1,
      updatedAt: 1,
    });
    result = await jmapJson(apiKey, [
      ["Mailbox/changes", { accountId: userId, sinceState }, "m2"],
    ]);
    expect(result.methodResponses[0][1].created).toEqual([
      "mbx:changes-folder",
    ]);
    expect(result.methodResponses[0][1].updatedProperties).toBeNull();

    sinceState = result.methodResponses[0][1].newState;
    await getDb().delete(mailboxes).where(eq(mailboxes.id, "changes-folder"));
    result = await jmapJson(apiKey, [
      ["Mailbox/changes", { accountId: userId, sinceState }, "m3"],
    ]);
    expect(result.methodResponses[0][1].destroyed).toEqual([
      "mbx:changes-folder",
    ]);
  });

  it("projects snoozed conversations into the normal JMAP inbox and counts", async () => {
    const { userId, apiKey } = await member("snooze-jmap");
    await getDb().insert(senderIdentities).values({
      email: MINE,
      displayName: "Mine",
      createdAt: 1,
      updatedAt: 1,
    });
    await createTestPerson({
      id: "snooze-person",
      email: "snooze@example.com",
    });
    await createTestEmail({
      id: "snooze-email",
      personId: "snooze-person",
      recipient: MINE,
      messageId: "snooze-email@example.com",
      conversationId: "snooze-thread",
    });
    await getDb()
      .insert(inboxConversationState)
      .values({
        inbox: MINE,
        conversationKey: "snooze-thread",
        snoozedUntil: Math.floor(Date.now() / 1000) + 3600,
        snoozedBy: userId,
        assignedUserId: null,
        assignedAt: null,
        updatedAt: Math.floor(Date.now() / 1000),
      });

    const get = await jmapJson(apiKey, [
      ["Email/get", { accountId: userId, ids: ["received:snooze-email"] }, "g"],
      [
        "Email/query",
        {
          accountId: userId,
          filter: { inMailbox: `sys:${MINE}:inbox` },
        },
        "q",
      ],
      ["Mailbox/get", { accountId: userId, ids: [`sys:${MINE}:inbox`] }, "m"],
    ]);
    expect(get.methodResponses[0][1].list[0].mailboxIds).toEqual({
      [`sys:${MINE}:inbox`]: true,
    });
    expect(get.methodResponses[1][1].ids).toContain("received:snooze-email");
    expect(get.methodResponses[2][1].list[0].totalEmails).toBe(1);
  });

  it("does not emit JMAP state changes for snooze-only updates", async () => {
    const { userId, apiKey } = await member("snooze-state");
    await getDb().insert(senderIdentities).values({
      email: MINE,
      displayName: "Mine",
      createdAt: 1,
      updatedAt: 1,
    });
    const before = await stateFor(apiKey, userId);
    await getDb()
      .insert(inboxConversationState)
      .values({
        inbox: MINE,
        conversationKey: "thread",
        snoozedUntil: Math.floor(Date.now() / 1000) + 3600,
        snoozedBy: userId,
        assignedUserId: null,
        assignedAt: null,
        updatedAt: Math.floor(Date.now() / 1000),
      });
    const after = await stateFor(apiKey, userId);
    const beforeParts = before.split("-");
    const afterParts = after.split("-");
    expect(afterParts[1]).toBe(beforeParts[1]);
    expect(afterParts[3]).toBe(beforeParts[3]);
  });
});
