// Mailbox/get with ids: null answers requestTooLarge only when the caller's
// mailbox list is longer than maxObjectsInGet (256), and before any count
// query; at exactly 256 it still lists every mailbox with its counts.
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { inboxPermissions } from "../db/inbox-permissions.schema";
import { mailboxes } from "../db/mailboxes.schema";
import { MAX_OBJECTS_IN_GET } from "../jmap/constants";
import {
  applyMigrations,
  cleanDb,
  createTestEmail,
  createTestPerson,
  createTestUser,
  getDb,
} from "./helpers";
import { acct, mbx, sys } from "./jmap-ids";
import { jmapCall } from "./jmap-submission-fixtures";

type Responses = [string, Record<string, any>, string][];

/** 42 inboxes x 6 system mailboxes = 252; four custom folders make 256. */
const INBOXES = Array.from(
  { length: 42 },
  (_, index) => `lim${String(index).padStart(2, "0")}@limit.test`,
);

async function seed() {
  const { userId } = await createTestUser({
    id: "limit-member",
    role: "member",
    email: "limit-member@example.com",
  });
  const now = Math.floor(Date.now() / 1000);
  for (let start = 0; start < INBOXES.length; start += 10) {
    await getDb()
      .insert(inboxPermissions)
      .values(
        INBOXES.slice(start, start + 10).map((email) => ({
          userId,
          email,
          createdAt: now,
          createdBy: null,
        })),
      );
  }
  await addFolders(userId, ["c0", "c1", "c2", "c3"]);
  await createTestPerson({ id: "limit-person", email: "p@example.com" });
  await createTestEmail({
    id: "limit-mail",
    personId: "limit-person",
    recipient: INBOXES[41],
    messageId: "limit-mail@example.com",
  });
  return userId;
}

async function addFolders(userId: string, ids: string[]) {
  const now = Math.floor(Date.now() / 1000);
  await getDb()
    .insert(mailboxes)
    .values(
      ids.map((id, index) => ({
        id,
        inbox: INBOXES[0],
        name: `Folder ${id}`,
        role: null,
        parentId: null,
        sortOrder: index,
        createdBy: userId,
        createdAt: now,
        updatedAt: now,
      })),
    );
}

async function mailboxGetAll(userId: string) {
  const [response] = (await jmapCall(userId, [
    [
      "Mailbox/get",
      {
        accountId: acct(userId),
        ids: null,
        properties: ["id", "totalEmails", "unreadEmails"],
      },
      "m",
    ],
  ])) as Responses;
  return response;
}

describe("Mailbox/get ids: null at the maxObjectsInGet boundary", () => {
  beforeAll(async () => {
    await applyMigrations();
  });
  beforeEach(async () => {
    await cleanDb();
  });

  it("lists all 256 mailboxes with counts, and refuses 257 with requestTooLarge", async () => {
    expect(MAX_OBJECTS_IN_GET).toBe(256);
    const userId = await seed();

    const [name, got] = await mailboxGetAll(userId);
    expect(name).toBe("Mailbox/get");
    expect(got.list).toHaveLength(256);
    expect(got.notFound).toEqual([]);
    const byId = new Map(
      got.list.map((m: { id: string }) => [m.id, m] as const),
    );
    expect(byId.get(sys(INBOXES[41], "inbox"))).toMatchObject({
      totalEmails: 1,
      unreadEmails: 1,
    });
    expect(byId.get(sys(INBOXES[0], "inbox"))).toMatchObject({
      totalEmails: 0,
    });
    expect(byId.get(mbx("c3"))).toMatchObject({ totalEmails: 0 });

    await addFolders(userId, ["c4"]);
    expect(await mailboxGetAll(userId)).toEqual([
      "error",
      { type: "requestTooLarge" },
      "m",
    ]);

    // Named ids still work past the limit, counted.
    const [namedName, named] = (
      (await jmapCall(userId, [
        [
          "Mailbox/get",
          {
            accountId: acct(userId),
            ids: [sys(INBOXES[41], "inbox"), mbx("c4")],
          },
          "m",
        ],
      ])) as Responses
    )[0];
    expect(namedName).toBe("Mailbox/get");
    expect(
      named.list.map((m: { id: string; totalEmails: number }) => [
        m.id,
        m.totalEmails,
      ]),
    ).toEqual([
      [sys(INBOXES[41], "inbox"), 1],
      [mbx("c4"), 0],
    ]);
  });
});
