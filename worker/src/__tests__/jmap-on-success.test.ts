import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { applyMigrations, cleanDb, getDb } from "./helpers";
import { acct, idn, mbx, sys } from "./jmap-ids";
import { jmapDrafts } from "../db/jmap-drafts.schema";
import { senderIdentities } from "../db/sender-identities.schema";
import { jmapSubmissions } from "../db/jmap-submissions.schema";
import { readBlobBytes, resolveReadableBlob } from "../jmap/blobs";
import { currentJmapState } from "../jmap/state";
import type { AllowedInboxes } from "../lib/inbox-permissions";
import {
  INBOX,
  OK,
  TRANSIENT,
  draftCreate,
  jmapCall,
  recordingSender,
  seedAccount,
} from "./jmap-submission-fixtures";

const OTHER_INBOX = "other-team@saasmail.test";

const DRAFTS = () => sys(INBOX, "drafts");
const SENT = () => sys(INBOX, "sent");
const TRASH = () => sys(INBOX, "trash");
/** RFC 8621 §7.5.1's own example patch: remove `$draft`, move Drafts -> Sent. */
const FILE_INTO_SENT = () => ({
  [`mailboxIds/${DRAFTS()}`]: null,
  [`mailboxIds/${SENT()}`]: true,
  "keywords/$draft": null,
});
const ALL_PROPERTIES = [
  "id",
  "blobId",
  "threadId",
  "mailboxIds",
  "keywords",
  "size",
  "receivedAt",
  "messageId",
  "inReplyTo",
  "references",
  "sender",
  "from",
  "to",
  "cc",
  "bcc",
  "replyTo",
  "subject",
  "sentAt",
  "hasAttachment",
  "preview",
  "bodyValues",
  "textBody",
  "htmlBody",
  "attachments",
  "bodyStructure",
];

type Responses = [string, Record<string, any>, string][];

/** A second usable identity, so a draft can carry a From the submission rejects. */
async function addOtherIdentity(): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  await getDb().insert(senderIdentities).values({
    email: OTHER_INBOX,
    displayName: "Other Team",
    createdAt: now,
    updatedAt: now,
  });
}

/** Create a draft, return its id. */
async function createDraft(
  userId: string,
  overrides: Record<string, unknown> = {},
): Promise<string> {
  const res = (await jmapCall(userId, [
    [
      "Email/set",
      { accountId: acct(userId), create: { d1: draftCreate(overrides) } },
      "a",
    ],
  ])) as Responses;
  const created = res[0][1].created?.d1;
  if (!created) throw new Error(`draft create failed: ${JSON.stringify(res)}`);
  return created.id as string;
}

async function submit(
  userId: string,
  emailId: string,
  extra: Record<string, unknown>,
  sender = recordingSender(OK).sender,
) {
  return (await jmapCall(
    userId,
    [
      [
        "EmailSubmission/set",
        {
          accountId: acct(userId),
          create: { k1: { identityId: idn(INBOX), emailId } },
          ...extra,
        },
        "s",
      ],
    ],
    { sender },
  )) as Responses;
}

async function getEmail(userId: string, id: string) {
  const res = (await jmapCall(userId, [
    [
      "Email/get",
      {
        accountId: acct(userId),
        ids: [id],
        properties: ALL_PROPERTIES,
        fetchAllBodyValues: true,
      },
      "g",
    ],
  ])) as Responses;
  return res[0][1];
}

async function sentIds(userId: string) {
  const res = (await jmapCall(userId, [
    [
      "Email/query",
      { accountId: acct(userId), filter: { inMailbox: SENT() } },
      "q",
    ],
  ])) as Responses;
  return res[0][1].ids as string[];
}

describe("EmailSubmission/set on-success step", () => {
  beforeAll(async () => {
    await applyMigrations();
  });
  beforeEach(async () => {
    await cleanDb();
  });

  it("runs the RFC 8621 example in one request and keeps the Email id", async () => {
    const { authorId } = await seedAccount();
    const res = (await jmapCall(
      authorId,
      [
        [
          "Email/set",
          { accountId: acct(authorId), create: { d1: draftCreate() } },
          "a",
        ],
        [
          "EmailSubmission/set",
          {
            accountId: acct(authorId),
            create: { k1: { identityId: idn(INBOX), emailId: "#d1" } },
            onSuccessUpdateEmail: { "#k1": FILE_INTO_SENT() },
          },
          "b",
        ],
      ],
      { sender: recordingSender(OK).sender },
    )) as Responses;
    const draftId = res[0][1].created.d1.id;
    expect(res.map(([name, , callId]) => [name, callId])).toEqual([
      ["Email/set", "a"],
      ["EmailSubmission/set", "b"],
      ["Email/set", "b"],
    ]);
    expect(res[2][1].updated).toEqual({ [draftId]: null });
    const email = await getEmail(authorId, draftId);
    expect(email.list[0].mailboxIds).toEqual({ [SENT()]: true });
    expect(email.list[0].keywords).toEqual({ $seen: true });
    expect(await sentIds(authorId)).toEqual([draftId]);
    expect(await getDb().select().from(jmapDrafts)).toEqual([]);
    const [submission] = await getDb().select().from(jmapSubmissions);
    expect(submission.onSuccessState).toBe("applied");
    expect(submission.emailId).toBe(draftId);
  });

  it("updates the aliased Email under its D id, and forbids destroying it", async () => {
    const { authorId } = await seedAccount();
    const draftId = await createDraft(authorId);
    await submit(authorId, draftId, {
      onSuccessUpdateEmail: { "#k1": FILE_INTO_SENT() },
    });
    const res = (await jmapCall(
      authorId,
      [
        [
          "Email/set",
          {
            accountId: acct(authorId),
            update: { [draftId]: { "keywords/$flagged": true } },
          },
          "u",
        ],
        [
          "Email/set",
          {
            accountId: acct(authorId),
            update: {
              [draftId]: {
                [`mailboxIds/${SENT()}`]: null,
                [`mailboxIds/${TRASH()}`]: true,
              },
            },
          },
          "t",
        ],
        ["Email/set", { accountId: acct(authorId), destroy: [draftId] }, "d"],
      ],
      { sender: recordingSender(OK).sender },
    )) as Responses;
    expect(res[0][1].updated).toEqual({ [draftId]: null });
    expect(res[1][1].updated).toEqual({ [draftId]: null });
    expect(res[2][1].notDestroyed).toEqual({
      [draftId]: { type: "forbidden" },
    });
    const email = (await getEmail(authorId, draftId)).list[0];
    expect(email.keywords).toEqual({ $seen: true, $flagged: true });
    expect(email.mailboxIds).toEqual({ [TRASH()]: true });
  });

  it("keeps every immutable property when the draft is filed into Sent", async () => {
    const { authorId } = await seedAccount();
    const draftId = await createDraft(authorId);
    const before = (await getEmail(authorId, draftId)).list[0];
    await submit(authorId, draftId, {
      onSuccessUpdateEmail: { "#k1": FILE_INTO_SENT() },
    });
    const after = (await getEmail(authorId, draftId)).list[0];
    const strip = (email: Record<string, unknown>) => {
      const { mailboxIds, keywords, ...rest } = email;
      return rest;
    };
    expect(strip(after)).toEqual(strip(before));
    expect(after.mailboxIds).not.toEqual(before.mailboxIds);
  });

  it("files into Sent plus a custom folder with $flagged", async () => {
    const { authorId } = await seedAccount();
    const draftId = await createDraft(authorId);
    await submit(authorId, draftId, {
      onSuccessUpdateEmail: {
        "#k1": {
          mailboxIds: { [SENT()]: true, [mbx("f1")]: true },
          keywords: { $seen: true, $flagged: true },
        },
      },
    });
    const email = (await getEmail(authorId, draftId)).list[0];
    expect(email.mailboxIds).toEqual({ [SENT()]: true, [mbx("f1")]: true });
    expect(email.keywords).toEqual({ $seen: true, $flagged: true });
  });

  it("flags the draft and reveals S… for a flag-only patch", async () => {
    const { authorId } = await seedAccount();
    const draftId = await createDraft(authorId);
    const res = await submit(authorId, draftId, {
      onSuccessUpdateEmail: { "#k1": { "keywords/$flagged": true } },
    });
    expect(res[1][1].updated).toEqual({ [draftId]: null });
    const draft = (await getEmail(authorId, draftId)).list[0];
    expect(draft.keywords).toEqual({
      $draft: true,
      $seen: true,
      $flagged: true,
    });
    const sent = await sentIds(authorId);
    expect(sent).toHaveLength(1);
    expect(sent[0].startsWith("S")).toBe(true);
    const [row] = await getDb().select().from(jmapDrafts);
    expect(row.submitState).toBeNull();
  });

  it("moves the draft to Trash and reveals S…", async () => {
    const { authorId } = await seedAccount();
    const draftId = await createDraft(authorId);
    await submit(authorId, draftId, {
      onSuccessUpdateEmail: {
        "#k1": {
          [`mailboxIds/${DRAFTS()}`]: null,
          [`mailboxIds/${TRASH()}`]: true,
        },
      },
    });
    expect((await getEmail(authorId, draftId)).list[0].mailboxIds).toEqual({
      [TRASH()]: true,
    });
    expect(await sentIds(authorId)).toHaveLength(1);
  });

  it("rejects an invalid target, leaves the draft and reveals S…", async () => {
    const { authorId } = await seedAccount();
    const draftId = await createDraft(authorId);
    const { sender, calls } = recordingSender(OK);
    const res = await submit(
      authorId,
      draftId,
      {
        onSuccessUpdateEmail: {
          "#k1": {
            [`mailboxIds/${DRAFTS()}`]: null,
            [`mailboxIds/${sys(INBOX, "inbox")}`]: true,
            "keywords/$draft": null,
          },
        },
      },
      sender,
    );
    expect(calls).toHaveLength(1);
    expect(res[0][1].created.k1.id).toMatch(/^E/);
    expect(res[1][1].notUpdated[draftId].type).toBe("invalidProperties");
    expect((await getEmail(authorId, draftId)).list[0].mailboxIds).toEqual({
      [DRAFTS()]: true,
    });
    expect(await sentIds(authorId)).toHaveLength(1);
  });

  it("files a draft without $seen into Sent; $seen is implied", async () => {
    const { authorId } = await seedAccount();
    const draftId = await createDraft(authorId, {
      keywords: { $draft: true },
    });
    const res = await submit(authorId, draftId, {
      onSuccessUpdateEmail: { "#k1": FILE_INTO_SENT() },
    });
    expect(res[1][1].updated).toEqual({ [draftId]: null });
    const email = (await getEmail(authorId, draftId)).list[0];
    expect(email.mailboxIds).toEqual({ [SENT()]: true });
    expect(email.keywords).toEqual({ $seen: true });
    expect(await sentIds(authorId)).toEqual([draftId]);
  });

  it("still rejects a Sent target that keeps $draft", async () => {
    const { authorId } = await seedAccount();
    const draftId = await createDraft(authorId);
    const res = await submit(authorId, draftId, {
      onSuccessUpdateEmail: {
        "#k1": {
          [`mailboxIds/${DRAFTS()}`]: null,
          [`mailboxIds/${SENT()}`]: true,
        },
      },
    });
    // Still a draft (it keeps $draft), so the draft rules apply and Sent is
    // not a mailbox a draft may be in.
    expect(res[1][1].notUpdated[draftId]).toMatchObject({
      type: "invalidProperties",
    });
    expect((await sentIds(authorId))[0].startsWith("S")).toBe(true);
  });

  it("destroys the draft and keeps a complete S…", async () => {
    const { authorId } = await seedAccount();
    const draftId = await createDraft(authorId);
    const before = (await getEmail(authorId, draftId)).list[0];
    const res = await submit(authorId, draftId, {
      onSuccessDestroyEmail: ["#k1"],
    });
    expect(res[1][1].destroyed).toEqual([draftId]);
    expect((await getEmail(authorId, draftId)).notFound).toEqual([draftId]);
    const [sentId] = await sentIds(authorId);
    const sent = (await getEmail(authorId, sentId)).list[0];
    expect(sent.blobId).toBe(before.blobId);
    expect(sent.size).toBe(before.size);
    expect(sent.subject).toBe(before.subject);
    expect(sent.to).toEqual(before.to);
    const admin: AllowedInboxes = { isAdmin: true };
    const blob = await resolveReadableBlob(
      getDb(),
      admin,
      authorId,
      sent.blobId,
    );
    expect(blob).not.toBeNull();
    expect((await readBlobBytes(env, blob!))!.byteLength).toBe(sent.size);
  });

  it("lets destroy win over update", async () => {
    const { authorId } = await seedAccount();
    const draftId = await createDraft(authorId);
    const res = await submit(authorId, draftId, {
      onSuccessUpdateEmail: { "#k1": FILE_INTO_SENT() },
      onSuccessDestroyEmail: ["#k1"],
    });
    expect(res[1][1].destroyed).toEqual([draftId]);
    expect(res[1][1].notUpdated).toEqual({
      [draftId]: { type: "willDestroy" },
    });
  });

  it("reveals S… silently when neither argument is given", async () => {
    const { authorId } = await seedAccount();
    const draftId = await createDraft(authorId);
    const res = await submit(authorId, draftId, {});
    expect(res.map(([name]) => name)).toEqual(["EmailSubmission/set"]);
    expect(await sentIds(authorId)).toHaveLength(1);
    const [row] = await getDb().select().from(jmapDrafts);
    expect(row.submitState).toBeNull();
  });

  it("runs one implicit Email/set for several submissions, skipping a failed one", async () => {
    const { authorId } = await seedAccount();
    await addOtherIdentity();
    const one = await createDraft(authorId);
    const two = await createDraft(authorId);
    const three = await createDraft(authorId);
    // Its From is another identity's address, so submitting it as INBOX fails.
    const bad = await createDraft(authorId, {
      from: [{ name: "Other Team", email: OTHER_INBOX }],
      mailboxIds: { [sys(OTHER_INBOX, "drafts")]: true },
    });
    const res = (await jmapCall(
      authorId,
      [
        [
          "EmailSubmission/set",
          {
            accountId: acct(authorId),
            create: {
              k1: { identityId: idn(INBOX), emailId: one },
              k2: { identityId: idn(INBOX), emailId: two },
              k3: { identityId: idn(INBOX), emailId: three },
              k4: { identityId: idn(INBOX), emailId: bad },
            },
            onSuccessUpdateEmail: {
              "#k1": FILE_INTO_SENT(),
              "#k4": FILE_INTO_SENT(),
            },
            onSuccessDestroyEmail: ["#k2"],
          },
          "s",
        ],
      ],
      { sender: recordingSender(OK, OK, OK).sender },
    )) as Responses;
    expect(res.map(([name]) => name)).toEqual([
      "EmailSubmission/set",
      "Email/set",
    ]);
    expect(Object.keys(res[0][1].notCreated)).toEqual(["k4"]);
    expect(res[1][1].updated).toEqual({ [one]: null });
    expect(res[1][1].destroyed).toEqual([two]);
    const sent = await sentIds(authorId);
    expect(sent).toContain(one);
    expect(sent.filter((id) => id.startsWith("S"))).toHaveLength(2);
    expect(sent).not.toContain(bad);
  });

  it.each([
    [
      "file into Sent",
      () => ({ onSuccessUpdateEmail: { "#k1": FILE_INTO_SENT() } }),
    ],
    [
      "flag only",
      () => ({
        onSuccessUpdateEmail: { "#k1": { "keywords/$flagged": true } },
      }),
    ],
    ["destroy", () => ({ onSuccessDestroyEmail: ["#k1"] })],
    ["neither", () => ({})],
  ])("works with a retrying send: %s", async (_label, extra) => {
    const { authorId } = await seedAccount();
    const draftId = await createDraft(authorId);
    const res = await submit(
      authorId,
      draftId,
      extra(),
      recordingSender(TRANSIENT).sender,
    );
    expect(res[0][1].created.k1.id).toMatch(/^E/);
    const [submission] = await getDb().select().from(jmapSubmissions);
    expect(submission.onSuccessState).toBe("applied");
    const drafts = await getDb().select().from(jmapDrafts);
    // A kept draft stays locked until the outbox is terminal.
    for (const draft of drafts) expect(draft.submitState).toBe("queued");
    expect(await sentIds(authorId)).toHaveLength(1);
  });

  it("shows the alias as updated to its author and created to another member", async () => {
    const { authorId, memberId } = await seedAccount();
    const draftId = await createDraft(authorId);
    const admin: AllowedInboxes = { isAdmin: true };
    const member: AllowedInboxes = { isAdmin: false, inboxes: [INBOX] };
    // Taken after the draft exists, so the change rows under test are the
    // alias's alone.
    const authorSince = (await currentJmapState(getDb(), admin, authorId))
      .state;
    const memberSince = (await currentJmapState(getDb(), member, memberId))
      .state;
    await submit(authorId, draftId, {
      onSuccessUpdateEmail: { "#k1": FILE_INTO_SENT() },
    });
    const authorChanges = (await jmapCall(authorId, [
      [
        "Email/changes",
        { accountId: acct(authorId), sinceState: authorSince },
        "c",
      ],
    ])) as Responses;
    const memberChanges = (await jmapCall(memberId, [
      [
        "Email/changes",
        { accountId: acct(memberId), sinceState: memberSince },
        "c",
      ],
    ])) as Responses;
    expect(authorChanges[0][1]).toMatchObject({
      created: [],
      updated: [draftId],
      destroyed: [],
    });
    expect(memberChanges[0][1]).toMatchObject({
      created: [draftId],
      updated: [],
      destroyed: [],
    });
    const everything = JSON.stringify([authorChanges, memberChanges]);
    expect(everything).not.toMatch(/"S[A-Za-z0-9_-]+"/);
  });
});
