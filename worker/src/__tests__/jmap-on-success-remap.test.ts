import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { applyMigrations, cleanDb, getDb } from "./helpers";
import { acct, idn, mbx, sys } from "./jmap-ids";
import { jmapSubmissions } from "../db/jmap-submissions.schema";
import { senderIdentities } from "../db/sender-identities.schema";
import { remapOnSuccessPatch } from "../jmap/on-success";
import type { MailboxDescriptor } from "../jmap/mailboxes";
import {
  INBOX,
  OK,
  draftCreate,
  jmapCall,
  recordingSender,
  seedAccount,
} from "./jmap-submission-fixtures";

// Import spec §2: the stored on-success patch is remapped to the draft's own
// inbox; a plain Email/set is not.

type Responses = [string, Record<string, any>, string][];

const OTHER = "privacy@saasmail.test";

async function addOtherInbox() {
  const now = Math.floor(Date.now() / 1000);
  await getDb().insert(senderIdentities).values({
    email: OTHER,
    displayName: "Privacy",
    createdAt: now,
    updatedAt: now,
  });
}

async function getEmail(userId: string, id: string) {
  const res = (await jmapCall(userId, [
    [
      "Email/get",
      {
        accountId: acct(userId),
        ids: [id],
        properties: ["id", "mailboxIds", "keywords"],
      },
      "g",
    ],
  ])) as Responses;
  return res[0][1].list[0];
}

/** aerc's patch shape, naming `inbox`'s Sent and Drafts. */
function aercPatch(inbox: string) {
  return {
    "keywords/$draft": null,
    [`mailboxIds/${sys(inbox, "sent")}`]: true,
    [`mailboxIds/${sys(inbox, "drafts")}`]: null,
  };
}

describe("on-success remap at submission", () => {
  beforeAll(async () => {
    await applyMigrations();
  });
  beforeEach(async () => {
    await cleanDb();
  });

  it("stores the remapped patch and files an Email/set draft into its own Sent", async () => {
    const { authorId } = await seedAccount();
    await addOtherInbox();
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
            onSuccessUpdateEmail: { "#k1": aercPatch(OTHER) },
          },
          "s",
        ],
      ],
      { sender: recordingSender(OK).sender },
    )) as Responses;
    const draftId = res[0][1].created.d1.id;
    expect(res[2][1].updated).toEqual({ [draftId]: null });
    const [row] = await getDb().select().from(jmapSubmissions);
    expect(JSON.parse(row.onSuccessPatchJson!)).toEqual(aercPatch(INBOX));
    const email = await getEmail(authorId, draftId);
    expect(email.mailboxIds).toEqual({ [sys(INBOX, "sent")]: true });
  });

  it("remaps the patch of a delayed send too", async () => {
    const { authorId } = await seedAccount();
    await addOtherInbox();
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
            create: {
              k1: {
                identityId: idn(INBOX),
                emailId: "#d1",
                envelope: {
                  mailFrom: { email: INBOX, parameters: { HOLDFOR: "600" } },
                  rcptTo: [
                    { email: "alice@example.com" },
                    { email: "bob@example.com" },
                  ],
                },
              },
            },
            onSuccessUpdateEmail: { "#k1": aercPatch(OTHER) },
          },
          "s",
        ],
      ],
      { sender: recordingSender(OK).sender },
    )) as Responses;
    const draftId = res[0][1].created.d1.id;
    expect(res[1][1].created.k1.undoStatus).toBe("pending");
    expect(res[2][1].updated).toEqual({ [draftId]: null });
    const email = await getEmail(authorId, draftId);
    expect(email.mailboxIds).toEqual({ [sys(INBOX, "sent")]: true });
  });

  it("leaves a custom folder of the other inbox alone, so the implicit Email/set rejects it", async () => {
    const { authorId } = await seedAccount();
    await addOtherInbox();
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
            onSuccessUpdateEmail: {
              "#k1": {
                ...aercPatch(OTHER),
                [`mailboxIds/${mbx("nope")}`]: true,
              },
            },
          },
          "s",
        ],
      ],
      { sender: recordingSender(OK).sender },
    )) as Responses;
    const draftId = res[0][1].created.d1.id;
    expect(res[2][1].notUpdated[draftId].type).toBe("invalidProperties");
  });
});

describe("plain Email/set stays strict", () => {
  beforeAll(async () => {
    await applyMigrations();
  });
  beforeEach(async () => {
    await cleanDb();
  });

  it("refuses moving a draft into another inbox's Sent", async () => {
    const { authorId } = await seedAccount();
    await addOtherInbox();
    const res = (await jmapCall(authorId, [
      [
        "Email/set",
        { accountId: acct(authorId), create: { d1: draftCreate() } },
        "a",
      ],
      [
        "Email/set",
        {
          accountId: acct(authorId),
          update: {
            "#d1": {
              "keywords/$draft": null,
              [`mailboxIds/${sys(OTHER, "sent")}`]: true,
              [`mailboxIds/${sys(INBOX, "drafts")}`]: null,
            },
          },
        },
        "b",
      ],
      [
        "Email/set",
        {
          accountId: acct(authorId),
          update: {
            "#d1": {
              [`mailboxIds/${sys(OTHER, "drafts")}`]: true,
              [`mailboxIds/${sys(INBOX, "drafts")}`]: null,
            },
          },
        },
        "c",
      ],
    ])) as Responses;
    const draftId = res[0][1].created.d1.id;
    expect(res[1][1].notUpdated[draftId].type).toBe("invalidProperties");
    expect(res[2][1].notUpdated[draftId].type).toBe("invalidProperties");
    const email = await getEmail(authorId, draftId);
    expect(email.mailboxIds).toEqual({ [sys(INBOX, "drafts")]: true });
  });
});

describe("remapOnSuccessPatch", () => {
  const A = "a@saasmail.test";
  const B = "b@saasmail.test";
  const descriptors = new Map<string, MailboxDescriptor>();
  for (const inbox of [A, B]) {
    for (const role of ["inbox", "drafts", "sent", "trash"] as const) {
      descriptors.set(sys(inbox, role), {
        kind: "system",
        id: sys(inbox, role),
        inbox,
        role,
      } as MailboxDescriptor);
    }
  }
  descriptors.set(mbx("fb"), {
    kind: "custom",
    id: mbx("fb"),
    mailboxId: "fb",
    inbox: B,
  } as MailboxDescriptor);

  it("rewrites another inbox's system mailboxes to the draft's own", () => {
    expect(
      remapOnSuccessPatch(
        {
          "keywords/$draft": null,
          [`mailboxIds/${sys(B, "sent")}`]: true,
          [`mailboxIds/${sys(B, "drafts")}`]: null,
        },
        A,
        descriptors,
      ),
    ).toEqual({
      "keywords/$draft": null,
      [`mailboxIds/${sys(A, "sent")}`]: true,
      [`mailboxIds/${sys(A, "drafts")}`]: null,
    });
  });

  it("leaves custom folders, unknown ids and own ids alone", () => {
    const patch = {
      [`mailboxIds/${mbx("fb")}`]: true,
      "mailboxIds/unknown": true,
      [`mailboxIds/${sys(A, "trash")}`]: true,
    };
    expect(remapOnSuccessPatch(patch, A, descriptors)).toEqual(patch);
  });

  it("collapses equal values in either order", () => {
    const own = `mailboxIds/${sys(A, "sent")}`;
    const other = `mailboxIds/${sys(B, "sent")}`;
    expect(
      remapOnSuccessPatch({ [own]: true, [other]: true }, A, descriptors),
    ).toEqual({ [own]: true });
    expect(
      remapOnSuccessPatch({ [other]: true, [own]: true }, A, descriptors),
    ).toEqual({ [own]: true });
  });

  it("keeps a conflicting pair exactly as sent, in either order", () => {
    const own = `mailboxIds/${sys(A, "drafts")}`;
    const other = `mailboxIds/${sys(B, "drafts")}`;
    const first = { [own]: true, [other]: null };
    const second = { [other]: null, [own]: true };
    expect(Object.entries(remapOnSuccessPatch(first, A, descriptors))).toEqual(
      Object.entries(first),
    );
    expect(Object.entries(remapOnSuccessPatch(second, A, descriptors))).toEqual(
      Object.entries(second),
    );
  });

  it("rewrites a whole-object mailboxIds", () => {
    expect(
      remapOnSuccessPatch(
        {
          mailboxIds: { [sys(B, "sent")]: true, [mbx("fb")]: true },
        },
        A,
        descriptors,
      ),
    ).toEqual({ mailboxIds: { [sys(A, "sent")]: true, [mbx("fb")]: true } });
    expect(
      remapOnSuccessPatch(
        { mailboxIds: { [sys(B, "sent")]: true, [sys(A, "sent")]: true } },
        A,
        descriptors,
      ),
    ).toEqual({ mailboxIds: { [sys(A, "sent")]: true } });
  });
});
