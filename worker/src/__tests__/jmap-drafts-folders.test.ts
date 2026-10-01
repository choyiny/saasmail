// Drafts in custom folders (spec 2026-09-28): exactly one of Drafts/Trash of
// the draft's own inbox, plus custom folders of that inbox.
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { applyMigrations, cleanDb, createTestUser, getDb } from "./helpers";
import { jmapChanges } from "../db/jmap-changes.schema";
import { jmapDrafts } from "../db/jmap-drafts.schema";
import { mailboxes } from "../db/mailboxes.schema";
import { parseDraftEmailId } from "../jmap/public-ids";
import {
  MINE,
  OTHER,
  addIdentity,
  createDraft,
  draftCreate,
  recordingSender,
  runJmap,
} from "./jmap-harness";
import { acct, idn, mbx, sys } from "./jmap-ids";

async function folder(id: string, inbox: string) {
  const now = Math.floor(Date.now() / 1000);
  await getDb().insert(mailboxes).values({
    id,
    inbox,
    name: id,
    role: null,
    parentId: null,
    sortOrder: 1,
    createdBy: null,
    createdAt: now,
    updatedAt: now,
  });
}

function result(responses: unknown[][], callId: string) {
  return responses.find((r) => r[2] === callId)![1] as Record<string, any>;
}

describe("JMAP drafts in custom folders", () => {
  let userId: string;
  const { sender } = recordingSender();

  beforeAll(async () => {
    await applyMigrations();
  });
  beforeEach(async () => {
    await cleanDb();
    ({ userId } = await createTestUser({ id: "folders-user" }));
    await addIdentity(MINE);
    await addIdentity(OTHER);
    await folder("projects", MINE);
    await folder("elsewhere", OTHER);
  });

  async function get(id: string) {
    const [response] = await runJmap(
      userId,
      [
        [
          "Email/get",
          { accountId: acct(userId), ids: [id], properties: ["mailboxIds"] },
          "g",
        ],
      ],
      sender,
    );
    return (response[1] as Record<string, any>).list[0];
  }

  async function update(id: string, patch: Record<string, unknown>) {
    const [response] = await runJmap(
      userId,
      [
        [
          "Email/set",
          { accountId: acct(userId), update: { [id]: patch } },
          "u",
        ],
      ],
      sender,
    );
    return response[1] as Record<string, any>;
  }

  it("creates a draft in Drafts and a custom folder of its inbox", async () => {
    const draft = await createDraft(userId, sender, {
      mailboxIds: { [sys(MINE, "drafts")]: true, [mbx("projects")]: true },
    });
    expect((await get(draft.id)).mailboxIds).toEqual({
      [sys(MINE, "drafts")]: true,
      [mbx("projects")]: true,
    });
  });

  it("refuses a draft created outside Drafts, or in another inbox's folder", async () => {
    const [response] = await runJmap(
      userId,
      [
        [
          "Email/set",
          {
            accountId: acct(userId),
            create: {
              onlyFolder: draftCreate({
                mailboxIds: { [mbx("projects")]: true },
              }),
              inbox: draftCreate({
                mailboxIds: { [sys(MINE, "inbox")]: true },
              }),
              foreign: draftCreate({
                mailboxIds: {
                  [sys(MINE, "drafts")]: true,
                  [mbx("elsewhere")]: true,
                },
              }),
            },
          },
          "c",
        ],
      ],
      sender,
    );
    const notCreated = (response[1] as Record<string, any>).notCreated;
    for (const key of ["onlyFolder", "inbox", "foreign"]) {
      expect(notCreated[key], key).toMatchObject({
        type: "invalidProperties",
        properties: ["mailboxIds"],
      });
    }
  });

  it("adds and removes folders and moves between Drafts and Trash, never elsewhere", async () => {
    const draft = await createDraft(userId, sender);
    expect(
      (await update(draft.id, { [`mailboxIds/${mbx("projects")}`]: true }))
        .updated,
    ).toHaveProperty(draft.id);
    expect(
      (
        await update(draft.id, {
          [`mailboxIds/${sys(MINE, "drafts")}`]: null,
          [`mailboxIds/${sys(MINE, "trash")}`]: true,
        })
      ).updated,
    ).toHaveProperty(draft.id);
    expect((await get(draft.id)).mailboxIds).toEqual({
      [sys(MINE, "trash")]: true,
      [mbx("projects")]: true,
    });
    const archived = await update(draft.id, {
      [`mailboxIds/${sys(MINE, "trash")}`]: null,
      [`mailboxIds/${sys(MINE, "archive")}`]: true,
    });
    expect(archived.notUpdated[draft.id]).toMatchObject({
      type: "invalidProperties",
      properties: ["mailboxIds"],
    });
    expect(
      (await update(draft.id, { [`mailboxIds/${mbx("projects")}`]: null }))
        .updated,
    ).toHaveProperty(draft.id);
    expect((await get(draft.id)).mailboxIds).toEqual({
      [sys(MINE, "trash")]: true,
    });
  });

  it("is found by Email/query in the folder and counted in the folder", async () => {
    const draft = await createDraft(userId, sender, {
      mailboxIds: { [sys(MINE, "drafts")]: true, [mbx("projects")]: true },
    });
    const responses = await runJmap(
      userId,
      [
        [
          "Email/query",
          { accountId: acct(userId), filter: { inMailbox: mbx("projects") } },
          "q",
        ],
        [
          "Mailbox/get",
          { accountId: acct(userId), ids: [mbx("projects")] },
          "m",
        ],
      ],
      sender,
    );
    expect(result(responses, "q").ids).toEqual([draft.id]);
    expect(result(responses, "m").list[0]).toMatchObject({
      totalEmails: 1,
      unreadEmails: 0,
      totalThreads: 1,
    });
  });

  it("leaves a deleted folder, and tells its author the draft changed", async () => {
    const draft = await createDraft(userId, sender, {
      mailboxIds: { [sys(MINE, "drafts")]: true, [mbx("projects")]: true },
    });
    await getDb().delete(mailboxes).where(eq(mailboxes.id, "projects"));
    expect((await get(draft.id)).mailboxIds).toEqual({
      [sys(MINE, "drafts")]: true,
    });
    const rows = await getDb()
      .select()
      .from(jmapChanges)
      .where(eq(jmapChanges.objectId, `draft:${parseDraftEmailId(draft.id)}`));
    expect(rows.map((row) => [row.op, row.userId]).at(-1)).toEqual([
      "u",
      userId,
    ]);
  });

  it("filed into Sent keeps a folder the patch didn't remove, and drops one it did", async () => {
    const filing = {
      "keywords/$draft": null,
      [`mailboxIds/${sys(MINE, "drafts")}`]: null,
      [`mailboxIds/${sys(MINE, "sent")}`]: true,
    };
    const kept = await createDraft(userId, sender, {
      mailboxIds: { [sys(MINE, "drafts")]: true, [mbx("projects")]: true },
    });
    const dropped = await createDraft(userId, sender, {
      mailboxIds: { [sys(MINE, "drafts")]: true, [mbx("projects")]: true },
    });
    for (const [draft, patch] of [
      [kept, filing],
      [dropped, { ...filing, [`mailboxIds/${mbx("projects")}`]: null }],
    ] as const) {
      const responses = await runJmap(
        userId,
        [
          [
            "EmailSubmission/set",
            {
              accountId: acct(userId),
              create: { s1: { identityId: idn(MINE), emailId: draft.id } },
              onSuccessUpdateEmail: { "#s1": patch },
            },
            "s",
          ],
        ],
        sender,
      );
      expect(result(responses, "s").created.s1).toBeDefined();
    }
    expect((await get(kept.id)).mailboxIds).toEqual({
      [sys(MINE, "sent")]: true,
      [mbx("projects")]: true,
    });
    expect((await get(dropped.id)).mailboxIds).toEqual({
      [sys(MINE, "sent")]: true,
    });
  });
});
