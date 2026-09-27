import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { applyMigrations, cleanDb, getDb } from "./helpers";
import { attachments } from "../db/attachments.schema";
import { jmapDrafts } from "../db/jmap-drafts.schema";
import { jmapMessageContent } from "../db/jmap-message-content.schema";
import { jmapSubmissions } from "../db/jmap-submissions.schema";
import { outboxEmails } from "../db/outbox-emails.schema";
import { sentEmails } from "../db/sent-emails.schema";
import {
  applyPendingOnSuccess,
  pruneJmapSubmissions,
  recoverClaimedSubmissions,
  releaseAppliedJmapOutboxRows,
  unlockQueuedDrafts,
} from "../jmap/recovery";
import { aliasDraftToSent } from "../jmap/on-success";
import { collectUnreferencedContent } from "../jmap/content";
import worker from "../index";
import {
  changeRows,
  insertJmapSentRow,
  insertStagedAttachment,
  insertTestContent,
  insertTestDraft,
  insertTestOutboxRow,
  insertTestSubmission,
  seedAccount,
} from "./jmap-submission-fixtures";

const NOW = Math.floor(Date.now() / 1000);
const OLD = NOW - 3600;

async function seedClaimed(
  authorId: string,
  opts: {
    outbox?: "pending" | "bookkeeping_pending" | "failed" | null;
    sent?: "sent" | "retrying" | "failed" | null;
    age?: number;
  },
) {
  await insertTestContent({ id: "c1", userId: authorId });
  await insertTestDraft({
    id: "d1",
    userId: authorId,
    contentId: "c1",
    submitState: "submitting",
    submitAttemptId: "e1",
  });
  await insertTestSubmission({
    id: "e1",
    userId: authorId,
    draftId: "d1",
    contentId: "c1",
    sentEmailId: "s1",
    attemptState: "claimed",
    createdAt: opts.age === undefined ? OLD : NOW - opts.age,
  });
  const r2Key = await insertStagedAttachment("s1");
  if (opts.outbox) {
    await insertTestOutboxRow({ sentEmailId: "s1", status: opts.outbox });
  }
  if (opts.sent) {
    await insertJmapSentRow({ id: "s1", contentId: "c1", status: opts.sent });
  }
  return { r2Key };
}

async function one<T>(rows: Promise<T[]>): Promise<T | undefined> {
  return (await rows)[0];
}

describe("JMAP submission recovery", () => {
  beforeAll(async () => {
    await applyMigrations();
  });
  beforeEach(async () => {
    await cleanDb();
  });

  it("leaves a young claimed intention alone", async () => {
    const { authorId } = await seedAccount();
    await seedClaimed(authorId, { outbox: null, sent: null, age: 60 });
    expect(await recoverClaimedSubmissions(getDb(), env, NOW)).toBe(0);
    expect(
      (await one(getDb().select().from(jmapSubmissions)))?.attemptState,
    ).toBe("claimed");
  });

  it("row 1: bookkeeping_pending -> Sent row sent, accepted, outbox released", async () => {
    const { authorId } = await seedAccount();
    await seedClaimed(authorId, { outbox: "bookkeeping_pending", sent: null });
    await recoverClaimedSubmissions(getDb(), env, NOW);
    const sent = await one(
      getDb().select().from(sentEmails).where(eq(sentEmails.id, "s1")),
    );
    expect(sent?.status).toBe("sent");
    expect(sent?.jmapContentId).toBe("c1");
    expect(
      (await one(getDb().select().from(jmapSubmissions)))?.attemptState,
    ).toBe("accepted");
    expect(await getDb().select().from(outboxEmails)).toEqual([]);
    // Hidden until the on-success step, which the next pass applies.
    expect(await changeRows("sent:s1")).toEqual([]);
    await applyPendingOnSuccess(getDb(), env, NOW + 3600);
    expect((await changeRows("sent:s1")).map((r) => r.op)).toEqual(["c"]);
    expect((await one(getDb().select().from(jmapDrafts)))?.submitState).toBe(
      null,
    );
  });

  it("row 1 records the Message-ID the held row says was delivered", async () => {
    const { authorId } = await seedAccount();
    await seedClaimed(authorId, { outbox: "bookkeeping_pending", sent: null });
    await getDb()
      .update(outboxEmails)
      .set({ deliveredMessageId: "cf-rec@cf.test" })
      .where(eq(outboxEmails.sentEmailId, "s1"));
    await recoverClaimedSubmissions(getDb(), env, NOW);
    const sent = await one(
      getDb().select().from(sentEmails).where(eq(sentEmails.id, "s1")),
    );
    expect(sent?.messageId).toBe("<cf-rec@cf.test>");
  });

  it("row 1 upgrades a retrying Sent row with the delivered Message-ID", async () => {
    const { authorId } = await seedAccount();
    await seedClaimed(authorId, {
      outbox: "bookkeeping_pending",
      sent: "retrying",
    });
    await getDb()
      .update(outboxEmails)
      .set({ deliveredMessageId: "<cf-up@cf.test>" })
      .where(eq(outboxEmails.sentEmailId, "s1"));
    await recoverClaimedSubmissions(getDb(), env, NOW);
    const sent = await one(
      getDb().select().from(sentEmails).where(eq(sentEmails.id, "s1")),
    );
    expect(sent?.status).toBe("sent");
    expect(sent?.messageId).toBe("<cf-up@cf.test>");
  });

  it("row 2: pending outbox -> retrying Sent row, accepted, claim kept", async () => {
    const { authorId } = await seedAccount();
    await seedClaimed(authorId, { outbox: "pending", sent: null });
    await recoverClaimedSubmissions(getDb(), env, NOW);
    expect(
      (
        await one(
          getDb().select().from(sentEmails).where(eq(sentEmails.id, "s1")),
        )
      )?.status,
    ).toBe("retrying");
    expect((await getDb().select().from(outboxEmails))[0].status).toBe(
      "pending",
    );
    expect((await one(getDb().select().from(jmapDrafts)))?.submitState).toBe(
      "queued",
    );
    await applyPendingOnSuccess(getDb(), env, NOW + 3600);
    // A pending outbox row never releases the claim.
    expect((await one(getDb().select().from(jmapDrafts)))?.submitState).toBe(
      "queued",
    );
  });

  it("row 3: failed outbox -> everything removed, claim released, no 'd' row", async () => {
    const { authorId } = await seedAccount();
    const { r2Key } = await seedClaimed(authorId, {
      outbox: "failed",
      sent: "retrying",
    });
    await recoverClaimedSubmissions(getDb(), env, NOW);
    expect(await getDb().select().from(jmapSubmissions)).toEqual([]);
    expect(await getDb().select().from(attachments)).toEqual([]);
    expect(await env.R2.get(r2Key)).toBeNull();
    expect(await getDb().select().from(sentEmails)).toEqual([]);
    expect(await getDb().select().from(outboxEmails)).toEqual([]);
    expect(await changeRows("sent:s1")).toEqual([]);
    expect((await one(getDb().select().from(jmapDrafts)))?.submitState).toBe(
      null,
    );
  });

  it("row 4: no outbox, Sent row present -> accepted from the intention", async () => {
    const { authorId } = await seedAccount();
    await seedClaimed(authorId, { outbox: null, sent: "retrying" });
    await recoverClaimedSubmissions(getDb(), env, NOW);
    expect(
      (await one(getDb().select().from(jmapSubmissions)))?.attemptState,
    ).toBe("accepted");
  });

  it("row 5: no outbox, no Sent row -> intention and staged files removed", async () => {
    const { authorId } = await seedAccount();
    const { r2Key } = await seedClaimed(authorId, { outbox: null, sent: null });
    await recoverClaimedSubmissions(getDb(), env, NOW);
    expect(await getDb().select().from(jmapSubmissions)).toEqual([]);
    expect(await getDb().select().from(attachments)).toEqual([]);
    expect(await env.R2.get(r2Key)).toBeNull();
    expect((await one(getDb().select().from(jmapDrafts)))?.submitState).toBe(
      null,
    );
  });

  it("applies a pending on-success step exactly once", async () => {
    const { authorId } = await seedAccount();
    await insertTestContent({ id: "c1", userId: authorId });
    await insertTestDraft({
      id: "d1",
      userId: authorId,
      contentId: "c1",
      submitState: "submitting",
      submitAttemptId: "e1",
    });
    await insertTestSubmission({
      id: "e1",
      userId: authorId,
      draftId: "d1",
      contentId: "c1",
      sentEmailId: "s1",
      attemptState: "accepted",
      onSuccessMode: "update",
      onSuccessPatch: { "keywords/$flagged": true },
      createdAt: OLD,
    });
    await insertJmapSentRow({ id: "s1", contentId: "c1" });
    expect(await applyPendingOnSuccess(getDb(), env, NOW)).toBe(1);
    expect(await applyPendingOnSuccess(getDb(), env, NOW)).toBe(0);
    const draft = await one(getDb().select().from(jmapDrafts));
    expect(draft?.flagged).toBe(1);
    expect((await changeRows("sent:s1")).map((r) => r.op)).toEqual(["c"]);
  });

  it("never replays a step after a crash that followed the alias batch", async () => {
    const { authorId } = await seedAccount();
    await insertTestContent({ id: "c1", userId: authorId });
    await insertTestDraft({ id: "d1", userId: authorId, contentId: "c1" });
    await insertTestSubmission({
      id: "e1",
      userId: authorId,
      draftId: "d1",
      contentId: "c1",
      sentEmailId: "s1",
      attemptState: "accepted",
      onSuccessMode: "update",
      onSuccessPatch: { "keywords/$draft": null },
      createdAt: OLD,
    });
    await insertJmapSentRow({ id: "s1", contentId: "c1" });
    const [submission] = await getDb().select().from(jmapSubmissions);
    // The request died right after this batch.
    expect(
      await aliasDraftToSent(env, {
        submission,
        draftId: "d1",
        draftReceivedAt: OLD,
        userId: authorId,
        system: "sent",
        folders: [],
        flagged: false,
        now: NOW,
      }),
    ).toBe(true);
    expect(await applyPendingOnSuccess(getDb(), env, NOW)).toBe(0);
    expect(
      await aliasDraftToSent(env, {
        submission,
        draftId: "d1",
        draftReceivedAt: OLD,
        userId: authorId,
        system: "sent",
        folders: [],
        flagged: false,
        now: NOW,
      }),
    ).toBe(false);
    // The draft's own insert, then the alias pair — exactly once.
    expect(
      (await changeRows("draft:d1")).map((r) => [
        r.op,
        r.user_id,
        r.exclude_user_id,
      ]),
    ).toEqual([
      ["c", authorId, null],
      ["u", authorId, null],
      ["c", null, authorId],
    ]);
    expect(await changeRows("sent:s1")).toEqual([]);
  });

  it("unlocks a queued draft only once its outbox row is terminal", async () => {
    const { authorId } = await seedAccount();
    await insertTestContent({ id: "c1", userId: authorId });
    await insertTestDraft({
      id: "d1",
      userId: authorId,
      contentId: "c1",
      submitState: "queued",
      submitAttemptId: "e1",
    });
    await insertTestSubmission({
      id: "e1",
      userId: authorId,
      draftId: "d1",
      contentId: "c1",
      sentEmailId: "s1",
      attemptState: "accepted",
      onSuccessState: "applied",
    });
    await insertTestOutboxRow({ sentEmailId: "s1", status: "pending" });
    expect(await unlockQueuedDrafts(getDb(), NOW)).toBe(0);
    await getDb().delete(outboxEmails);
    expect(await unlockQueuedDrafts(getDb(), NOW)).toBe(1);
    expect((await one(getDb().select().from(jmapDrafts)))?.submitState).toBe(
      null,
    );
  });

  it("prunes applied submissions after 7 days and writes a tombstone", async () => {
    const { authorId } = await seedAccount();
    await insertTestContent({ id: "c1", userId: authorId });
    for (const [id, age, state] of [
      ["old", 8 * 86400, "accepted"],
      ["recent", 6 * 86400, "accepted"],
      ["claimed", 8 * 86400, "claimed"],
    ] as const) {
      await insertTestSubmission({
        id,
        userId: authorId,
        draftId: `d-${id}`,
        contentId: "c1",
        sentEmailId: `s-${id}`,
        attemptState: state,
        onSuccessState: state === "accepted" ? "applied" : "pending",
        sendAt: NOW - age,
        createdAt: NOW - age,
      });
    }
    expect(await pruneJmapSubmissions(getDb(), NOW)).toBe(1);
    const left = (await getDb().select().from(jmapSubmissions)).map(
      (row) => row.id,
    );
    expect(left.sort()).toEqual(["claimed", "recent"]);
    expect((await changeRows("submission:old")).at(-1)?.op).toBe("d");
  });

  it("prunes and applies more rows than D1 binds in one statement", async () => {
    // D1 binds at most 100 parameters per statement: an unchunked IN list of
    // these ids throws, and the same rows would be picked again every hour.
    const { authorId } = await seedAccount();
    await insertTestContent({ id: "c1", userId: authorId });
    for (let i = 0; i < 150; i += 1) {
      await insertTestSubmission({
        id: `old-${i}`,
        userId: authorId,
        draftId: `d-old-${i}`,
        contentId: "c1",
        sentEmailId: `s-old-${i}`,
        attemptState: "accepted",
        onSuccessState: "applied",
        sendAt: NOW - 8 * 86400,
        createdAt: NOW - 8 * 86400,
      });
    }
    for (let i = 0; i < 100; i += 1) {
      await insertTestSubmission({
        id: `pending-${i}`,
        userId: authorId,
        draftId: `d-pending-${i}`,
        contentId: "c1",
        sentEmailId: `s-pending-${i}`,
        attemptState: "accepted",
        onSuccessState: "pending",
        onSuccessMode: "none",
        createdAt: OLD,
      });
    }
    expect(await pruneJmapSubmissions(getDb(), NOW)).toBe(150);
    expect(await applyPendingOnSuccess(getDb(), env, NOW)).toBe(100);
    const states = (await getDb().select().from(jmapSubmissions)).map(
      (row) => row.onSuccessState,
    );
    expect(states).toHaveLength(100);
    expect(new Set(states)).toEqual(new Set(["applied"]));
  });

  it("releases held JMAP rows only once their submission is applied", async () => {
    const { authorId } = await seedAccount();
    await insertTestContent({ id: "c1", userId: authorId });
    await insertTestSubmission({
      id: "e1",
      userId: authorId,
      draftId: "d1",
      contentId: "c1",
      sentEmailId: "s1",
      attemptState: "accepted",
      onSuccessState: "pending",
    });
    await insertTestOutboxRow({
      sentEmailId: "s1",
      status: "bookkeeping_pending",
    });
    await insertTestOutboxRow({
      sentEmailId: "s-campaign",
      status: "bookkeeping_pending",
      owner: "campaign",
    });
    expect(await releaseAppliedJmapOutboxRows(getDb())).toBe(0);
    await getDb()
      .update(jmapSubmissions)
      .set({ onSuccessState: "applied" })
      .where(eq(jmapSubmissions.id, "e1"));
    expect(await releaseAppliedJmapOutboxRows(getDb())).toBe(1);
    expect(
      (await getDb().select().from(outboxEmails)).map((row) => row.sentEmailId),
    ).toEqual(["s-campaign"]);
  });

  it("keeps content that an accepted, not-yet-applied submission needs", async () => {
    const { authorId } = await seedAccount();
    await insertTestContent({ id: "c1", userId: authorId });
    await getDb()
      .update(jmapMessageContent)
      .set({ createdAt: OLD - 86400 });
    await insertTestSubmission({
      id: "e1",
      userId: authorId,
      draftId: "gone",
      contentId: "c1",
      sentEmailId: "s1",
      attemptState: "accepted",
      onSuccessState: "pending",
    });
    expect(await collectUnreferencedContent(getDb(), env, NOW)).toBe(0);
  });

  it("runs from the hourly cron", async () => {
    const { authorId } = await seedAccount();
    await seedClaimed(authorId, { outbox: "bookkeeping_pending", sent: null });
    const waits: Promise<unknown>[] = [];
    await worker.scheduled!(
      { cron: "0 * * * *", scheduledTime: Date.now() } as ScheduledEvent,
      env,
      {
        waitUntil: (promise: Promise<unknown>) => {
          waits.push(promise);
        },
      } as ExecutionContext,
    );
    await Promise.all(waits);
    expect(
      (await one(getDb().select().from(jmapSubmissions)))?.attemptState,
    ).toBe("accepted");
  });
});
