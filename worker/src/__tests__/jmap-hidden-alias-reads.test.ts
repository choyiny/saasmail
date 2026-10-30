import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { applyMigrations, cleanDb, getDb } from "./helpers";
import { acct, drf, sid, sys } from "./jmap-ids";
import {
  INBOX,
  insertJmapSentRow,
  insertTestContent,
  insertTestDraft,
  insertTestSubmission,
  jmapCall,
  seedAccount,
} from "./jmap-submission-fixtures";
import { publicRawBlobId } from "../jmap/public-ids";
import { currentJmapState } from "../jmap/state";
import type { AllowedInboxes } from "../lib/inbox-permissions";

const MEMBER: AllowedInboxes = { isAdmin: false, inboxes: [INBOX] };

describe("hidden and aliased JMAP Sent rows", () => {
  beforeAll(async () => {
    await applyMigrations();
  });
  beforeEach(async () => {
    await cleanDb();
  });

  async function seedHidden() {
    const ids = await seedAccount();
    await insertTestContent({ id: "c1", userId: ids.authorId });
    await insertTestDraft({
      id: "d1",
      userId: ids.authorId,
      contentId: "c1",
      submitState: "submitting",
      submitAttemptId: "e1",
    });
    await insertTestSubmission({
      id: "e1",
      userId: ids.authorId,
      draftId: "d1",
      contentId: "c1",
      sentEmailId: "s1",
      attemptState: "accepted",
      onSuccessState: "pending",
    });
    await insertJmapSentRow({ id: "s1", contentId: "c1" });
    return ids;
  }

  async function readSurface(userId: string) {
    const account = acct(userId);
    const res = await jmapCall(userId, [
      ["Email/get", { accountId: account, ids: null, properties: ["id"] }, "g"],
      ["Email/query", { accountId: account, calculateTotal: true }, "q"],
      [
        "Email/query",
        { accountId: account, filter: { inMailbox: sys(INBOX, "sent") } },
        "qs",
      ],
      ["Thread/get", { accountId: account, ids: null }, "t"],
      ["Mailbox/get", { accountId: account, ids: [sys(INBOX, "sent")] }, "m"],
    ]);
    return JSON.stringify(res);
  }

  it("never shows a hidden Sent row to anyone", async () => {
    const { authorId, memberId } = await seedHidden();
    for (const userId of [authorId, memberId]) {
      expect(await readSurface(userId)).not.toContain(sid("s1"));
      const res = await jmapCall(userId, [
        [
          "Mailbox/get",
          { accountId: acct(userId), ids: [sys(INBOX, "sent")] },
          "m",
        ],
        [
          "Email/get",
          { accountId: acct(userId), ids: [sid("s1")], properties: ["id"] },
          "byId",
        ],
      ]);
      expect(res[0][1].list[0].totalEmails).toBe(0);
      // RFC 8621 §4.2: an id that resolves to nothing is reported in notFound.
      // That discloses nothing the caller didn't already supply.
      expect(res[1][1].list).toEqual([]);
      expect(res[1][1].notFound).toEqual([sid("s1")]);
    }
  });

  it("doesn't serve a hidden row's raw blob to another member", async () => {
    const { memberId } = await seedHidden();
    const { resolveReadableBlob } = await import("../jmap/blobs");
    const blob = await resolveReadableBlob(
      getDb(),
      MEMBER,
      memberId,
      publicRawBlobId("c1"),
    );
    expect(blob).toBeNull();
  });

  it("never lists a hidden row in Email/changes", async () => {
    const { memberId } = await seedAccount();
    const since = (await currentJmapState(getDb(), MEMBER, memberId)).state;
    await insertTestContent({ id: "c2", userId: "jmap-author" });
    await insertTestDraft({ id: "d2", userId: "jmap-author", contentId: "c2" });
    await insertTestSubmission({
      id: "e2",
      userId: "jmap-author",
      draftId: "d2",
      contentId: "c2",
      sentEmailId: "s2",
      attemptState: "accepted",
      onSuccessState: "pending",
    });
    await insertJmapSentRow({ id: "s2", contentId: "c2" });
    const res = await jmapCall(memberId, [
      ["Email/changes", { accountId: acct(memberId), sinceState: since }, "c"],
    ]);
    expect(JSON.stringify(res[0][1])).not.toContain(sid("s2"));
  });

  it("shows an aliased row under its draft id, with the draft's receivedAt", async () => {
    const { authorId } = await seedAccount();
    await insertTestContent({ id: "c3", userId: authorId });
    await insertTestSubmission({
      id: "e3",
      userId: authorId,
      draftId: "d3",
      contentId: "c3",
      sentEmailId: "s3",
      attemptState: "accepted",
      onSuccessState: "applied",
    });
    await insertJmapSentRow({
      id: "s3",
      contentId: "c3",
      jmapEmailId: "d3",
      jmapReceivedAt: 1_700_000_000,
    });
    const res = await jmapCall(authorId, [
      [
        "Email/get",
        {
          accountId: acct(authorId),
          ids: [drf("d3"), sid("s3")],
          properties: ["id", "receivedAt", "mailboxIds", "blobId"],
        },
        "g",
      ],
      [
        "Email/query",
        {
          accountId: acct(authorId),
          filter: { inMailbox: sys(INBOX, "sent") },
        },
        "q",
      ],
    ]);
    const get = res[0][1];
    expect(get.list).toEqual([
      {
        id: drf("d3"),
        // contentEmailObject emits an RFC 8620 UTCDate: no fractional seconds.
        receivedAt: "2023-11-14T22:13:20Z",
        mailboxIds: { [sys(INBOX, "sent")]: true },
        blobId: publicRawBlobId("c3"),
      },
    ]);
    expect(get.notFound).toEqual([sid("s3")]);
    expect(res[1][1].ids).toEqual([drf("d3")]);
  });
});
