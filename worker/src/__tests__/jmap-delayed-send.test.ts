import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { applyMigrations, authFetch, cleanDb, getDb } from "./helpers";
import { acct, idn, sys } from "./jmap-ids";
import { jmapDrafts } from "../db/jmap-drafts.schema";
import { jmapSubmissions } from "../db/jmap-submissions.schema";
import { outboxEmails } from "../db/outbox-emails.schema";
import { sentEmails } from "../db/sent-emails.schema";
import { deleteContentIfUnreferenced } from "../jmap/content";
import { applyPendingOnSuccess, pruneJmapSubmissions } from "../jmap/recovery";
import { deleteEmailWithAttachments } from "../lib/delete-email";
import {
  parseAnyEmailId,
  parseSubmissionId,
  publicSubmissionId as publicIdOf,
} from "../jmap/public-ids";
import {
  cancelScheduledSubmission,
  recoverReleasingSubmissions,
  releaseOverdueSubmissions,
  releaseOutboxId,
  releaseScheduledSubmission,
  restoreOwedDrafts,
} from "../jmap/release";
import { outboxIdempotencyKey } from "../lib/outbox";
import {
  INBOX,
  OK,
  TERMINAL,
  TRANSIENT,
  changeRows,
  draftCreate,
  jmapCall,
  recordingSender,
  seedAccount,
} from "./jmap-submission-fixtures";

type Responses = [string, Record<string, any>, string][];

const DRAFTS = () => sys(INBOX, "drafts");
const SENT = () => sys(INBOX, "sent");
const FILE_INTO_SENT = () => ({
  [`mailboxIds/${DRAFTS()}`]: null,
  [`mailboxIds/${SENT()}`]: true,
  "keywords/$draft": null,
});
const BACK_TO_DRAFTS = () => ({
  mailboxIds: { [DRAFTS()]: true },
  keywords: { $draft: true, $seen: true },
});

async function createDraft(userId: string): Promise<string> {
  const res = (await jmapCall(userId, [
    [
      "Email/set",
      { accountId: acct(userId), create: { d1: draftCreate() } },
      "a",
    ],
  ])) as Responses;
  const created = res[0][1].created?.d1;
  if (!created) throw new Error(`draft create failed: ${JSON.stringify(res)}`);
  return created.id as string;
}

/** A delayed submission of `emailId`, filed into Sent by its on-success step. */
async function schedule(
  userId: string,
  emailId: string,
  parameters: Record<string, string> = { HOLDFOR: "600" },
  sender = recordingSender().sender,
): Promise<Responses> {
  return (await jmapCall(
    userId,
    [
      [
        "EmailSubmission/set",
        {
          accountId: acct(userId),
          create: {
            s1: {
              identityId: idn(INBOX),
              emailId,
              envelope: {
                mailFrom: { email: INBOX, parameters },
                rcptTo: [
                  { email: "alice@example.com" },
                  { email: "bob@example.com" },
                ],
              },
            },
          },
          onSuccessUpdateEmail: { "#s1": FILE_INTO_SENT() },
        },
        "s",
      ],
    ],
    { sender },
  )) as Responses;
}

/** A delayed submission with no on-success arguments: the draft stays a draft. */
async function scheduleKeepingDraft(userId: string, emailId: string) {
  const res = (await jmapCall(
    userId,
    [
      [
        "EmailSubmission/set",
        {
          accountId: acct(userId),
          create: {
            s1: {
              identityId: idn(INBOX),
              emailId,
              envelope: {
                mailFrom: { email: INBOX, parameters: { HOLDFOR: "600" } },
                rcptTo: [
                  { email: "alice@example.com" },
                  { email: "bob@example.com" },
                ],
              },
            },
          },
        },
        "s",
      ],
    ],
    { sender: recordingSender().sender },
  )) as Responses;
  return res[0][1].created.s1.id as string;
}

async function submissionRow(publicId: string) {
  const [row] = await getDb()
    .select()
    .from(jmapSubmissions)
    .where(eq(jmapSubmissions.id, parseSubmissionId(publicId)!));
  return row;
}

async function rowById(id: string) {
  const [row] = await getDb()
    .select()
    .from(jmapSubmissions)
    .where(eq(jmapSubmissions.id, id));
  return row;
}

function draftInternalId(publicId: string): string {
  const ref = parseAnyEmailId(publicId);
  if (!ref || ref.kind !== "draft") throw new Error(`not a draft: ${publicId}`);
  return ref.id;
}

async function sentStatus(sentEmailId: string) {
  const [row] = await getDb()
    .select({ status: sentEmails.status })
    .from(sentEmails)
    .where(eq(sentEmails.id, sentEmailId));
  return row?.status ?? null;
}

async function cancel(userId: string, submissionId: string) {
  const res = (await jmapCall(userId, [
    [
      "EmailSubmission/set",
      {
        accountId: acct(userId),
        update: { [submissionId]: { undoStatus: "canceled" } },
      },
      "c",
    ],
  ])) as Responses;
  return res[0][1];
}

async function emailGet(userId: string, id: string) {
  const res = (await jmapCall(userId, [
    [
      "Email/get",
      {
        accountId: acct(userId),
        ids: [id],
        properties: ["mailboxIds", "keywords", "receivedAt"],
      },
      "g",
    ],
  ])) as Responses;
  return res[0][1];
}

describe("JMAP delayed send (RFC 4865 FUTURERELEASE)", () => {
  let authorId: string;
  let authorApiKey: string;
  let memberId: string;

  beforeAll(async () => {
    await applyMigrations();
  });
  beforeEach(async () => {
    await cleanDb();
    ({ authorId, authorApiKey, memberId } = await seedAccount());
  });

  it("schedules without sending and files the same Email into Sent at once", async () => {
    const draftId = await createDraft(authorId);
    const { sender, calls } = recordingSender();
    const before = Math.floor(Date.now() / 1000);
    const res = await schedule(authorId, draftId, { HOLDFOR: "600" }, sender);

    const created = res[0][1].created.s1;
    expect(created.undoStatus).toBe("pending");
    const sendAt = Date.parse(created.sendAt) / 1000;
    expect(sendAt).toBeGreaterThanOrEqual(before + 600);
    expect(sendAt).toBeLessThanOrEqual(before + 605);
    expect(calls).toHaveLength(0);
    // RFC 8621 §7.5: the on-success step ran at create.
    expect(res[1][0]).toBe("Email/set");
    expect(res[1][1].updated).toEqual({ [draftId]: null });
    const got = await emailGet(authorId, draftId);
    expect(got.list[0].mailboxIds).toEqual({ [SENT()]: true });

    const row = await submissionRow(created.id);
    expect(row.attemptState).toBe("scheduled");
    expect(row.undoStatus).toBe("pending");
    expect(await sentStatus(row.sentEmailId)).toBe("scheduled");

    const read = (await jmapCall(authorId, [
      ["EmailSubmission/get", { accountId: acct(authorId) }, "r"],
    ])) as Responses;
    expect(read[0][1].list).toEqual([
      expect.objectContaining({
        id: created.id,
        undoStatus: "pending",
        sendAt: created.sendAt,
        envelope: expect.objectContaining({
          mailFrom: { email: INBOX, parameters: { HOLDFOR: "600" } },
        }),
      }),
    ]);
    expect((await changeRows(`submission:${row.id}`)).map((r) => r.op)).toEqual(
      ["c"],
    );
  });

  it("refuses holds beyond maxDelayedSend and other SMTP parameters", async () => {
    const draftId = await createDraft(authorId);
    for (const parameters of [
      { HOLDFOR: "86401" },
      { HOLDUNTIL: new Date(Date.now() + 90_000_000).toISOString() },
      { HOLDFOR: "60", HOLDUNTIL: new Date().toISOString() },
      { SIZE: "100" },
    ]) {
      const res = await schedule(authorId, draftId, parameters);
      expect(res[0][1].notCreated.s1).toMatchObject({
        type: "invalidProperties",
        properties: ["envelope"],
      });
    }
    const [draft] = await getDb().select().from(jmapDrafts);
    expect(draft.submitState).toBeNull();
  });

  it("releases once when due, and undoStatus turns final only after the provider accepted", async () => {
    const draftId = await createDraft(authorId);
    const res = await schedule(authorId, draftId);
    const row = await submissionRow(res[0][1].created.s1.id);

    const seenDuringSend: string[] = [];
    const { sender, calls } = recordingSender();
    const wrapped = {
      ...sender,
      async send(params: Parameters<typeof sender.send>[0]) {
        const [during] = await getDb()
          .select()
          .from(jmapSubmissions)
          .where(eq(jmapSubmissions.id, row.id));
        seenDuringSend.push(`${during.attemptState}/${during.undoStatus}`);
        return sender.send(params);
      },
    };

    expect(
      await releaseScheduledSubmission(env, row.id, {
        sender: wrapped,
        now: row.sendAt - 10,
      }),
    ).toBe("notDue");
    expect(calls).toHaveLength(0);

    expect(
      await releaseScheduledSubmission(env, row.id, {
        sender: wrapped,
        now: row.sendAt,
      }),
    ).toBe("sent");
    expect(seenDuringSend).toEqual(["releasing/pending"]);
    expect(calls).toHaveLength(1);
    expect(calls[0].to).toBe("Alice Example <alice@example.com>");

    const after = await submissionRow(res[0][1].created.s1.id);
    expect(after.attemptState).toBe("accepted");
    expect(after.undoStatus).toBe("final");
    expect(await sentStatus(row.sentEmailId)).toBe("sent");
    expect(
      await getDb()
        .select()
        .from(outboxEmails)
        .where(eq(outboxEmails.sentEmailId, row.sentEmailId)),
    ).toEqual([]);
    // The Email's receivedAt never moves, though sent_at now is the send time.
    const got = await emailGet(authorId, draftId);
    expect(got.list[0].mailboxIds).toEqual({ [SENT()]: true });

    // At-least-once delivery: a second release sends nothing.
    expect(
      await releaseScheduledSubmission(env, row.id, {
        sender: wrapped,
        now: row.sendAt + 5,
      }),
    ).toBe("skipped");
    expect(calls).toHaveLength(1);
    expect((await changeRows(`submission:${row.id}`)).map((r) => r.op)).toEqual(
      ["c", "u"],
    );
  });

  it("cancel wins while scheduled; the release then sends nothing", async () => {
    const draftId = await createDraft(authorId);
    const res = await schedule(authorId, draftId);
    const id = res[0][1].created.s1.id;
    const row = await submissionRow(id);

    const result = await cancel(authorId, id);
    expect(result.updated).toEqual({ [id]: null });
    expect(result.newState).not.toBe(result.oldState);
    expect((await submissionRow(id)).undoStatus).toBe("canceled");
    expect(await sentStatus(row.sentEmailId)).toBe("canceled");
    // Canceling twice is a no-op, not an error.
    expect((await cancel(authorId, id)).updated).toEqual({ [id]: null });

    const { sender, calls } = recordingSender();
    expect(
      await releaseScheduledSubmission(env, row.id, {
        sender,
        now: row.sendAt,
      }),
    ).toBe("skipped");
    expect(calls).toHaveLength(0);
    // JMAP cancel changes only the submission: the Email stays in Sent.
    expect((await emailGet(authorId, draftId)).list[0].mailboxIds).toEqual({
      [SENT()]: true,
    });
  });

  it("after the release claims it, cancel is cannotUnsend", async () => {
    const draftId = await createDraft(authorId);
    const res = await schedule(authorId, draftId);
    const id = res[0][1].created.s1.id;
    const row = await submissionRow(id);

    let during: Record<string, any> | null = null;
    const { sender } = recordingSender();
    const racing = {
      ...sender,
      async send(params: Parameters<typeof sender.send>[0]) {
        during = await cancel(authorId, id);
        return sender.send(params);
      },
    };
    expect(
      await releaseScheduledSubmission(env, row.id, {
        sender: racing,
        now: row.sendAt,
      }),
    ).toBe("sent");
    expect(during!.notUpdated[id].type).toBe("cannotUnsend");
    expect((await cancel(authorId, id)).notUpdated[id].type).toBe(
      "cannotUnsend",
    );
    expect((await submissionRow(id)).undoStatus).toBe("final");
  });

  it("a canceled scheduled Email moves back to Drafts under the same id", async () => {
    const draftId = await createDraft(authorId);
    const res = await schedule(authorId, draftId);
    const id = res[0][1].created.s1.id;
    const row = await submissionRow(id);
    const receivedAt = (await emailGet(authorId, draftId)).list[0].receivedAt;

    // Not yet canceled: Sent -> Drafts stays forbidden.
    const early = (await jmapCall(authorId, [
      [
        "Email/set",
        { accountId: acct(authorId), update: { [draftId]: BACK_TO_DRAFTS() } },
        "e",
      ],
    ])) as Responses;
    expect(early[0][1].notUpdated[draftId].type).toBe("invalidProperties");

    await cancel(authorId, id);
    const logged = (await changeRows(`draft:${draftInternalId(draftId)}`))
      .length;
    const moved = (await jmapCall(authorId, [
      [
        "Email/set",
        { accountId: acct(authorId), update: { [draftId]: BACK_TO_DRAFTS() } },
        "e",
      ],
    ])) as Responses;
    expect(moved[0][1].updated).toEqual({ [draftId]: null });

    const got = await emailGet(authorId, draftId);
    expect(got.list[0]).toMatchObject({
      mailboxIds: { [DRAFTS()]: true },
      keywords: { $draft: true, $seen: true },
      receivedAt,
    });
    expect(
      await getDb()
        .select()
        .from(jmapDrafts)
        .where(eq(jmapDrafts.id, draftInternalId(draftId))),
    ).toHaveLength(1);
    expect(await sentStatus(row.sentEmailId)).toBeNull();

    // The author sees an update of the same Email, everyone else a destroy.
    // Exactly these two rows: no trigger logged the draft insert or the Sent
    // row's delete on its own.
    const rows = await changeRows(`draft:${draftInternalId(draftId)}`);
    expect(rows.slice(logged)).toEqual([
      expect.objectContaining({ op: "u", user_id: authorId }),
      expect.objectContaining({
        op: "d",
        user_id: null,
        exclude_user_id: authorId,
      }),
    ]);
    // The member never sees the draft.
    expect((await emailGet(memberId, draftId)).notFound).toEqual([draftId]);
  });

  it("an immediate send's Email can never move back to Drafts", async () => {
    const draftId = await createDraft(authorId);
    await jmapCall(
      authorId,
      [
        [
          "EmailSubmission/set",
          {
            accountId: acct(authorId),
            create: { s1: { identityId: idn(INBOX), emailId: draftId } },
            onSuccessUpdateEmail: { "#s1": FILE_INTO_SENT() },
          },
          "s",
        ],
      ],
      { sender: recordingSender().sender },
    );
    const res = (await jmapCall(authorId, [
      [
        "Email/set",
        { accountId: acct(authorId), update: { [draftId]: BACK_TO_DRAFTS() } },
        "e",
      ],
    ])) as Responses;
    expect(res[0][1].notUpdated[draftId].type).toBe("invalidProperties");
  });

  it("web Outbox lists scheduled sends; Cancel cancels and moves the Email back to Drafts", async () => {
    const draftId = await createDraft(authorId);
    const res = await schedule(authorId, draftId);
    const row = await submissionRow(res[0][1].created.s1.id);

    const list = (await (
      await authFetch("/api/outbox/scheduled", { apiKey: authorApiKey })
    ).json()) as { items: Record<string, unknown>[] };
    expect(list.items).toEqual([
      expect.objectContaining({
        id: row.id,
        subject: "Quarterly numbers",
        toAddress: "alice@example.com",
        sendAt: row.sendAt,
      }),
    ]);

    const canceled = await authFetch(`/api/outbox/scheduled/${row.id}/cancel`, {
      apiKey: authorApiKey,
      method: "POST",
    });
    expect(canceled.status).toBe(200);
    expect(await canceled.json()).toEqual({
      canceled: true,
      movedToDrafts: true,
      willMove: false,
    });
    expect((await emailGet(authorId, draftId)).list[0].mailboxIds).toEqual({
      [DRAFTS()]: true,
    });
    expect((await submissionRow(res[0][1].created.s1.id)).restoreToDrafts).toBe(
      0,
    );
  });

  it("web Cancel after the send started is a 409", async () => {
    const draftId = await createDraft(authorId);
    const res = await schedule(authorId, draftId);
    const row = await submissionRow(res[0][1].created.s1.id);
    await releaseScheduledSubmission(env, row.id, {
      sender: recordingSender().sender,
      now: row.sendAt,
    });
    const response = await authFetch(`/api/outbox/scheduled/${row.id}/cancel`, {
      apiKey: authorApiKey,
      method: "POST",
    });
    expect(response.status).toBe(409);
  });

  it("recovery finishes a web Cancel whose move back to Drafts didn't happen", async () => {
    const draftId = await createDraft(authorId);
    const res = await schedule(authorId, draftId);
    const row = await submissionRow(res[0][1].created.s1.id);
    expect(
      await cancelScheduledSubmission(env, {
        submissionId: row.id,
        userId: authorId,
        restoreToDrafts: true,
      }),
    ).toBe("canceled");
    expect(await restoreOwedDrafts(env, Math.floor(Date.now() / 1000))).toBe(1);
    expect((await emailGet(authorId, draftId)).list[0].mailboxIds).toEqual({
      [DRAFTS()]: true,
    });
    expect((await submissionRow(res[0][1].created.s1.id)).restoreToDrafts).toBe(
      0,
    );
  });

  it("keeps the content while scheduled, even if its Sent row is deleted, and then cancels", async () => {
    const draftId = await createDraft(authorId);
    const res = await schedule(authorId, draftId);
    const row = await submissionRow(res[0][1].created.s1.id);
    await getDb().delete(sentEmails).where(eq(sentEmails.id, row.sentEmailId));
    expect(await deleteContentIfUnreferenced(getDb(), env, row.contentId)).toBe(
      false,
    );
    const { sender, calls } = recordingSender();
    expect(
      await releaseScheduledSubmission(env, row.id, {
        sender,
        now: row.sendAt,
      }),
    ).toBe("canceled");
    expect(calls).toHaveLength(0);
    expect((await submissionRow(res[0][1].created.s1.id)).undoStatus).toBe(
      "canceled",
    );
  });

  it("a transient failure hands retries to the outbox; a terminal one fails the Email", async () => {
    const first = await createDraft(authorId);
    const a = await submissionRow(
      (await schedule(authorId, first))[0][1].created.s1.id,
    );
    expect(
      await releaseScheduledSubmission(env, a.id, {
        sender: recordingSender(TRANSIENT).sender,
        now: a.sendAt,
      }),
    ).toBe("retrying");
    const retrying = await rowById(a.id);
    expect([retrying.attemptState, retrying.undoStatus]).toEqual([
      "accepted",
      "final",
    ]);
    expect(await sentStatus(a.sentEmailId)).toBe("retrying");

    const second = await createDraft(authorId);
    const b = await submissionRow(
      (await schedule(authorId, second))[0][1].created.s1.id,
    );
    expect(
      await releaseScheduledSubmission(env, b.id, {
        sender: recordingSender(TERMINAL).sender,
        now: b.sendAt,
      }),
    ).toBe("failed");
    const failed = await rowById(b.id);
    expect([failed.attemptState, failed.undoStatus]).toEqual([
      "accepted",
      "final",
    ]);
    expect(await sentStatus(b.sentEmailId)).toBe("failed");
  });

  it("the hourly sweep releases overdue sends, and recovery gives back an interrupted claim", async () => {
    const draftId = await createDraft(authorId);
    const row = await submissionRow(
      (await schedule(authorId, draftId))[0][1].created.s1.id,
    );

    // A claim that never reached the provider (no outbox row) is given back.
    await getDb()
      .update(jmapSubmissions)
      .set({ attemptState: "releasing", releasedAt: row.sendAt - 3600 })
      .where(eq(jmapSubmissions.id, row.id));
    expect(await recoverReleasingSubmissions(env, row.sendAt)).toBe(1);
    expect((await rowById(row.id)).attemptState).toBe("scheduled");

    const { sender, calls } = recordingSender();
    expect(await releaseOverdueSubmissions(env, row.sendAt, sender)).toBe(0);
    expect(await releaseOverdueSubmissions(env, row.sendAt + 120, sender)).toBe(
      1,
    );
    expect(calls).toHaveLength(1);
    expect((await rowById(row.id)).undoStatus).toBe("final");
  });

  it("deleting a scheduled message in the web UI cancels it at once", async () => {
    const draftId = await createDraft(authorId);
    const row = await submissionRow(
      (await schedule(authorId, draftId))[0][1].created.s1.id,
    );
    await deleteEmailWithAttachments(getDb(), env.R2, row.sentEmailId, {
      isAdmin: true,
    });
    expect((await rowById(row.id)).undoStatus).toBe("canceled");
    const { sender, calls } = recordingSender();
    expect(
      await releaseScheduledSubmission(env, row.id, {
        sender,
        now: row.sendAt,
      }),
    ).toBe("skipped");
    expect(calls).toHaveLength(0);
  });

  it("recovery never re-creates a deleted scheduled message: it cancels it and keeps the draft", async () => {
    const draftId = await createDraft(authorId);
    const id = await scheduleKeepingDraft(authorId, draftId);
    const row = await submissionRow(id);
    // The on-success step hadn't run (draft still locked, Sent row hidden)
    // when the Sent message was deleted.
    await getDb()
      .update(jmapSubmissions)
      .set({ onSuccessState: "pending" })
      .where(eq(jmapSubmissions.id, row.id));
    await getDb()
      .update(jmapDrafts)
      .set({ submitState: "submitting", submitAttemptId: row.id })
      .where(eq(jmapDrafts.id, draftInternalId(draftId)));
    await getDb().delete(sentEmails).where(eq(sentEmails.id, row.sentEmailId));

    await applyPendingOnSuccess(getDb(), env, row.createdAt + 3600);
    const settled = await rowById(row.id);
    expect([settled.undoStatus, settled.onSuccessState]).toEqual([
      "canceled",
      "applied",
    ]);
    expect(await sentStatus(row.sentEmailId)).toBeNull();
    const [draft] = await getDb()
      .select()
      .from(jmapDrafts)
      .where(eq(jmapDrafts.id, draftInternalId(draftId)));
    expect(draft.submitState).toBeNull();

    const { sender, calls } = recordingSender();
    await releaseScheduledSubmission(env, row.id, { sender, now: row.sendAt });
    expect(calls).toHaveLength(0);
  });

  it("web Cancel of a send that kept its draft says there is nothing to move", async () => {
    const draftId = await createDraft(authorId);
    const id = await scheduleKeepingDraft(authorId, draftId);
    const row = await submissionRow(id);
    const response = await authFetch(`/api/outbox/scheduled/${row.id}/cancel`, {
      apiKey: authorApiKey,
      method: "POST",
    });
    expect(await response.json()).toEqual({
      canceled: true,
      movedToDrafts: false,
      willMove: false,
    });
    expect((await rowById(row.id)).restoreToDrafts).toBe(0);
    // The draft was never filed away, and its canceled copy stays in Sent.
    expect((await emailGet(authorId, draftId)).list[0].mailboxIds).toEqual({
      [DRAFTS()]: true,
    });
    expect(await sentStatus(row.sentEmailId)).toBe("canceled");
  });

  it("a release that throws gives its claim back and retries with the same idempotency key", async () => {
    const draftId = await createDraft(authorId);
    const row = await submissionRow(
      (await schedule(authorId, draftId))[0][1].created.s1.id,
    );
    const keys: (string | undefined)[] = [];
    let fail = true;
    const sender = {
      ...recordingSender().sender,
      async send(params: { idempotencyKey?: string }) {
        keys.push(params.idempotencyKey);
        if (fail) throw new Error("network");
        return OK;
      },
    };
    await expect(
      releaseScheduledSubmission(env, row.id, {
        sender: sender as never,
        now: row.sendAt,
      }),
    ).rejects.toThrow("network");
    expect((await rowById(row.id)).attemptState).toBe("scheduled");

    fail = false;
    expect(
      await releaseScheduledSubmission(env, row.id, {
        sender: sender as never,
        now: row.sendAt,
      }),
    ).toBe("sent");
    const key = outboxIdempotencyKey(releaseOutboxId(row.id));
    expect(keys).toEqual([key, key]);
  });

  it("recovery settles a release the provider accepted before its bookkeeping", async () => {
    const draftId = await createDraft(authorId);
    const row = await submissionRow(
      (await schedule(authorId, draftId))[0][1].created.s1.id,
    );
    const now = row.sendAt + 3600;
    await getDb()
      .update(jmapSubmissions)
      .set({ attemptState: "releasing", releasedAt: row.sendAt })
      .where(eq(jmapSubmissions.id, row.id));
    await getDb()
      .insert(outboxEmails)
      .values({
        id: releaseOutboxId(row.id),
        sentEmailId: row.sentEmailId,
        bookkeepingOwner: "jmap",
        fromAddress: INBOX,
        toAddress: "alice@example.com",
        subject: "Quarterly numbers",
        status: "bookkeeping_pending",
        attempts: 1,
        deliveredMessageId: "<delivered-1@example.com>",
        nextRetryAt: now,
        createdAt: now,
        updatedAt: now,
      });
    expect(await recoverReleasingSubmissions(env, now)).toBe(1);
    const settled = await rowById(row.id);
    expect([settled.attemptState, settled.undoStatus]).toEqual([
      "accepted",
      "final",
    ]);
    expect(await sentStatus(row.sentEmailId)).toBe("sent");
    expect(
      await getDb()
        .select()
        .from(outboxEmails)
        .where(eq(outboxEmails.sentEmailId, row.sentEmailId)),
    ).toEqual([]);
  });

  it("prunes a canceled send after 7 days, but not while a move back to Drafts is owed", async () => {
    const first = await createDraft(authorId);
    const kept = await submissionRow(
      (await schedule(authorId, first))[0][1].created.s1.id,
    );
    await cancelScheduledSubmission(env, {
      submissionId: kept.id,
      userId: authorId,
      restoreToDrafts: true,
    });
    const second = await createDraft(authorId);
    const pruned = await submissionRow(
      (await schedule(authorId, second))[0][1].created.s1.id,
    );
    await cancel(authorId, publicIdOf(pruned.id));

    const later = pruned.sendAt + 8 * 24 * 3600;
    expect(await pruneJmapSubmissions(getDb(), later)).toBe(1);
    expect(await rowById(pruned.id)).toBeUndefined();
    expect(await rowById(kept.id)).toBeDefined();
  });
});
