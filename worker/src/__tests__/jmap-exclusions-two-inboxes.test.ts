// inMailboxOtherThan used to add one `AND NOT (inbox = X AND <in folder>)`
// clause per excluded (inbox, mailbox) pair; the clauses are now grouped (one
// JSON inbox list per system folder or draft role, one JSON list of
// [inbox, mailbox id] pairs for custom folders) so the statement's parameter
// count is fixed. Grouping must not change the meaning: across two inboxes,
// with the same role excluded in one inbox or both, custom folders of each,
// and drafts in Drafts, Drafts + folder and Trash, every random exclusion set
// (alone and under inMailbox) must give exactly the Emails whose Email/get
// mailboxIds name none of the excluded mailboxes.
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { emails } from "../db/emails.schema";
import { mailboxes } from "../db/mailboxes.schema";
import { senderIdentities } from "../db/sender-identities.schema";
import {
  applyMigrations,
  cleanDb,
  createTestPerson,
  createTestSentEmail,
  getDb,
} from "./helpers";
import { acct, mbx, rid, sid, sys } from "./jmap-ids";
import {
  INBOX,
  OK,
  draftCreate,
  jmapCall,
  recordingSender,
  seedAccount,
} from "./jmap-submission-fixtures";

type Responses = [string, Record<string, any>, string][];

const SECOND = "second@saasmail.test";
const PERSON = "exc-person";
const ROLES = ["inbox", "drafts", "sent", "archive", "junk", "trash"] as const;

/** A small deterministic PRNG, so a failing seed can be replayed. */
function mulberry32(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function call(userId: string, name: string, args: Record<string, any>) {
  const [response] = (await jmapCall(
    userId,
    [[name, { accountId: acct(userId), ...args }, "c"]],
    { sender: recordingSender(OK).sender },
  )) as Responses;
  return response;
}

async function queryIds(
  userId: string,
  filter: Record<string, unknown>,
): Promise<string[]> {
  const [name, result] = await call(userId, "Email/query", { filter });
  if (name !== "Email/query") {
    throw new Error(`Email/query failed: ${JSON.stringify(result)}`);
  }
  return [...(result.ids as string[])].sort();
}

let clock = Math.floor(Date.now() / 1000) - 50_000;
let serial = 0;

async function received(inbox: string): Promise<string> {
  serial += 1;
  clock += 5;
  const id = `exc-r-${String(serial).padStart(3, "0")}`;
  await getDb()
    .insert(emails)
    .values({
      id,
      personId: PERSON,
      recipient: inbox,
      subject: `Received ${id}`,
      bodyHtml: "<p>x</p>",
      bodyText: "x",
      rawHeaders: "{}",
      messageId: `${id}@example.com`,
      isRead: 0,
      conversationId: `conv-${id}`,
      receivedAt: clock,
      createdAt: clock,
    });
  return rid(id);
}

async function webSent(inbox: string): Promise<string> {
  serial += 1;
  clock += 5;
  const id = `exc-s-${String(serial).padStart(3, "0")}`;
  await createTestSentEmail({
    id,
    fromAddress: inbox,
    toAddress: "someone@example.com",
    sentAt: clock,
  });
  return sid(id);
}

async function draft(userId: string, inbox: string): Promise<string> {
  serial += 1;
  const [, result] = await call(userId, "Email/set", {
    create: {
      d: draftCreate({
        from: [{ email: inbox }],
        mailboxIds: { [sys(inbox, "drafts")]: true },
        subject: `Draft ${serial}`,
      }),
    },
  });
  if (!result.created?.d) {
    throw new Error(`draft create failed: ${JSON.stringify(result)}`);
  }
  return result.created.d.id as string;
}

async function folder(id: string, inbox: string, userId: string) {
  const now = Math.floor(Date.now() / 1000);
  await getDb()
    .insert(mailboxes)
    .values({
      id,
      inbox,
      name: `Folder ${id}`,
      role: null,
      parentId: null,
      sortOrder: 2,
      createdBy: userId,
      createdAt: now,
      updatedAt: now,
    });
}

/**
 * Two inboxes, each with system mail in every folder, custom folders of its
 * own, mail filed in one or two custom folders on top of Inbox or Archive,
 * web-sent mail in Sent (+ a folder) and Trash, and drafts in Drafts,
 * Drafts + a folder and Trash. Returns every Email id and every mailbox id.
 */
async function seedTwoInboxes(userId: string) {
  const now = Math.floor(Date.now() / 1000);
  await getDb().insert(senderIdentities).values({
    email: SECOND,
    displayName: "Second",
    createdAt: now,
    updatedAt: now,
  });
  await folder("f2", INBOX, userId); // INBOX already has f1 (seedAccount)
  await folder("g1", SECOND, userId);
  await folder("g2", SECOND, userId);
  const custom: Record<string, [string, string]> = {
    [INBOX]: [mbx("f1"), mbx("f2")],
    [SECOND]: [mbx("g1"), mbx("g2")],
  };

  const updates: Record<string, Record<string, unknown>> = {};
  for (const inbox of [INBOX, SECOND]) {
    const box = (role: (typeof ROLES)[number]) => sys(inbox, role);
    const [c1, c2] = custom[inbox];
    await received(inbox); // plain Inbox
    updates[await received(inbox)] = { mailboxIds: { [box("archive")]: true } };
    updates[await received(inbox)] = { mailboxIds: { [box("junk")]: true } };
    updates[await received(inbox)] = { mailboxIds: { [box("trash")]: true } };
    updates[await received(inbox)] = {
      mailboxIds: { [box("inbox")]: true, [c1]: true },
    };
    updates[await received(inbox)] = {
      mailboxIds: { [box("archive")]: true, [c2]: true },
    };
    updates[await received(inbox)] = {
      mailboxIds: { [box("inbox")]: true, [c1]: true, [c2]: true },
    };
    await webSent(inbox); // plain Sent
    updates[await webSent(inbox)] = {
      mailboxIds: { [box("sent")]: true, [c1]: true },
    };
    updates[await webSent(inbox)] = { mailboxIds: { [box("trash")]: true } };
    await draft(userId, inbox); // plain Drafts
    updates[await draft(userId, inbox)] = {
      mailboxIds: { [box("drafts")]: true, [c2]: true },
    };
    updates[await draft(userId, inbox)] = {
      mailboxIds: { [box("trash")]: true },
    };
  }
  const [, set] = await call(userId, "Email/set", { update: updates });
  expect(set.notUpdated ?? {}).toEqual({});

  const all = await queryIds(userId, {});
  const [, got] = await call(userId, "Email/get", {
    ids: all,
    properties: ["mailboxIds"],
  });
  const membership = new Map<string, Set<string>>(
    got.list.map((email: { id: string; mailboxIds: Record<string, true> }) => [
      email.id,
      new Set(Object.keys(email.mailboxIds)),
    ]),
  );
  const mailboxIds = [
    ...[INBOX, SECOND].flatMap((inbox) =>
      ROLES.map((role) => sys(inbox, role)),
    ),
    ...custom[INBOX],
    ...custom[SECOND],
  ];
  return { all, membership, mailboxIds };
}

beforeAll(async () => {
  await applyMigrations();
});
beforeEach(async () => {
  await cleanDb();
  await createTestPerson({ id: PERSON, email: "exc@example.com" });
});

describe("inMailboxOtherThan across two inboxes: grouped exclusions mean the per-pair clauses", () => {
  it("every random set of excluded mailboxes, alone and under inMailbox, gives the Emails in none of them", async () => {
    const { authorId: userId } = await seedAccount();
    const { all, membership, mailboxIds } = await seedTwoInboxes(userId);
    // The mix must really reach every mailbox, or a case tests nothing.
    for (const id of mailboxIds) {
      expect(
        all.some((email) => membership.get(email)?.has(id)),
        `nothing seeded in ${id}`,
      ).toBe(true);
    }
    expect(all.length).toBeGreaterThan(20);

    const outside = (excluded: string[], within?: string) =>
      all
        .filter((email) => {
          const boxes = membership.get(email)!;
          if (within !== undefined && !boxes.has(within)) return false;
          return excluded.every((id) => !boxes.has(id));
        })
        .sort();

    // Hand-picked shapes first: the same role in both inboxes (one grouped
    // clause), each inbox excluding a different role, custom folders of both
    // inboxes, and Drafts vs Trash for drafts.
    const shapes: string[][] = [
      [sys(INBOX, "inbox"), sys(SECOND, "inbox")],
      [sys(INBOX, "archive"), sys(SECOND, "junk")],
      [sys(INBOX, "trash"), sys(SECOND, "drafts")],
      [sys(INBOX, "drafts"), sys(SECOND, "trash")],
      [mbx("f1"), mbx("g2")],
      [mbx("f1"), mbx("f2"), mbx("g1"), mbx("g2")],
      [sys(INBOX, "sent"), mbx("g1"), sys(SECOND, "archive"), mbx("f2")],
    ];
    const random = mulberry32(0xe8c1);
    for (let round = 0; round < 25; round += 1) {
      shapes.push(mailboxIds.filter(() => random() < 0.3));
    }

    for (const excluded of shapes) {
      const label = JSON.stringify(excluded);
      expect(
        await queryIds(userId, { inMailboxOtherThan: excluded }),
        label,
      ).toEqual(outside(excluded));
      const within = mailboxIds[Math.floor(random() * mailboxIds.length)];
      expect(
        await queryIds(userId, {
          inMailbox: within,
          inMailboxOtherThan: excluded,
        }),
        `${label} within ${within}`,
      ).toEqual(outside(excluded, within));
    }
  });

  it("a member granted one inbox: excluding the other inbox's mailboxes removes nothing, its own still exclude", async () => {
    const { authorId, memberId } = await seedAccount();
    await seedTwoInboxes(authorId);
    // The member (granted INBOX only) has drafts of their own too.
    const memberDraft = await draft(memberId, INBOX);
    const everything = await queryIds(memberId, {});
    expect(everything).toContain(memberDraft);

    const foreign = [
      ...ROLES.map((role) => sys(SECOND, role)),
      mbx("g1"),
      mbx("g2"),
    ];
    expect(await queryIds(memberId, { inMailboxOtherThan: foreign })).toEqual(
      everything,
    );

    const drafts = await queryIds(memberId, {
      inMailbox: sys(INBOX, "drafts"),
    });
    expect(drafts).toEqual([memberDraft]);
    expect(
      await queryIds(memberId, {
        inMailboxOtherThan: [...foreign, sys(INBOX, "drafts")],
      }),
    ).toEqual(everything.filter((id) => id !== memberDraft));
  });
});
