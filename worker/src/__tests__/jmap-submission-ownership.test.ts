import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { applyMigrations, cleanDb, getDb } from "./helpers";
import { acct, idn } from "./jmap-ids";
import { outboxEmails } from "../db/outbox-emails.schema";
import { jmapDrafts } from "../db/jmap-drafts.schema";
import { jmapSubmissions } from "../db/jmap-submissions.schema";
import { attemptOutboxRow } from "../lib/outbox";
import {
  INBOX,
  OK,
  TERMINAL,
  TRANSIENT,
  draftCreate,
  jmapCall,
  recordingSender,
  seedAccount,
} from "./jmap-submission-fixtures";
import {
  isMethodError,
  onSuccessForCreation,
  parseOnSuccessArgs,
} from "../jmap/on-success";

function submitCalls(extra: Record<string, unknown> = {}) {
  return (userId: string): [string, Record<string, unknown>, string][] => [
    [
      "Email/set",
      { accountId: acct(userId), create: { d1: draftCreate() } },
      "a",
    ],
    [
      "EmailSubmission/set",
      {
        accountId: acct(userId),
        create: { k1: { identityId: idn(INBOX), emailId: "#d1" } },
        ...extra,
      },
      "b",
    ],
  ];
}

describe("on-success argument parsing", () => {
  it("rejects malformed arguments and derives each create's mode", () => {
    expect(parseOnSuccessArgs({ onSuccessUpdateEmail: [] })).toEqual({
      type: "invalidArguments",
      properties: ["onSuccessUpdateEmail"],
    });
    expect(parseOnSuccessArgs({ onSuccessDestroyEmail: [1] })).toEqual({
      type: "invalidArguments",
      properties: ["onSuccessDestroyEmail"],
    });
    const parsed = parseOnSuccessArgs({
      onSuccessUpdateEmail: { "#k1": { "keywords/$draft": null } },
      onSuccessDestroyEmail: ["#k1", "#k2"],
    });
    if (isMethodError(parsed)) throw new Error("unexpected error");
    expect(onSuccessForCreation(parsed, "k1")).toEqual({
      mode: "both",
      patch: { "keywords/$draft": null },
    });
    expect(onSuccessForCreation(parsed, "k2")).toEqual({
      mode: "destroy",
      patch: null,
    });
    expect(onSuccessForCreation(parsed, "k3")).toEqual({
      mode: "none",
      patch: null,
    });
  });

  it("treats an absent argument as absent, not as a malformed one", () => {
    const parsed = parseOnSuccessArgs({});
    if (isMethodError(parsed)) throw new Error("unexpected error");
    expect(parsed).toEqual({ update: null, destroy: null });
    const explicitNull = parseOnSuccessArgs({
      onSuccessUpdateEmail: null,
      onSuccessDestroyEmail: null,
    });
    if (isMethodError(explicitNull)) throw new Error("unexpected error");
    expect(explicitNull).toEqual({ update: null, destroy: null });
  });
});

describe("JMAP outbox ownership", () => {
  beforeAll(async () => {
    await applyMigrations();
  });
  beforeEach(async () => {
    await cleanDb();
  });

  it("stores the mode, patch and From header on the intention", async () => {
    const { authorId } = await seedAccount();
    const { sender } = recordingSender(OK);
    await jmapCall(
      authorId,
      submitCalls({
        onSuccessUpdateEmail: { "#k1": { "keywords/$flagged": true } },
      })(authorId),
      { sender },
    );
    const [row] = await getDb().select().from(jmapSubmissions);
    expect(row.onSuccessMode).toBe("update");
    expect(JSON.parse(row.onSuccessPatchJson!)).toEqual({
      "keywords/$flagged": true,
    });
    expect(row.fromHeader).toBe(`Hello Team <${INBOX}>`);
  });

  it("applies the on-success step and unlocks the draft after a send", async () => {
    const { authorId } = await seedAccount();
    const { sender } = recordingSender(OK);
    await jmapCall(authorId, submitCalls()(authorId), { sender });
    const [submission] = await getDb().select().from(jmapSubmissions);
    expect(submission.attemptState).toBe("accepted");
    // The step ran inside the same request, so the intention is settled and the
    // kept draft is unlocked again.
    expect(submission.onSuccessState).toBe("applied");
    const [draft] = await getDb().select().from(jmapDrafts);
    expect(draft.submitState).toBeNull();
    expect(draft.submitAttemptId).toBeNull();
  });

  it("queues the draft when the send is retried by the outbox", async () => {
    const { authorId } = await seedAccount();
    const { sender } = recordingSender(TRANSIENT);
    await jmapCall(authorId, submitCalls()(authorId), { sender });
    const [draft] = await getDb().select().from(jmapDrafts);
    expect(draft.submitState).toBe("queued");
  });

  it("releases the owned outbox row after an accepted inline send", async () => {
    const { authorId } = await seedAccount();
    const { sender } = recordingSender(OK);
    await jmapCall(authorId, submitCalls()(authorId), { sender });
    expect(await getDb().select().from(outboxEmails)).toEqual([]);
  });

  it("keeps a retrying row pending and owned by jmap", async () => {
    const { authorId } = await seedAccount();
    const { sender } = recordingSender(TRANSIENT);
    await jmapCall(authorId, submitCalls()(authorId), { sender });
    const rows = await getDb().select().from(outboxEmails);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("pending");
    expect(rows[0].bookkeepingOwner).toBe("jmap");
  });

  it("holds a jmap row the processor sends successfully", async () => {
    const { authorId } = await seedAccount();
    await jmapCall(authorId, submitCalls()(authorId), {
      sender: recordingSender(TRANSIENT).sender,
    });
    const [row] = await getDb().select().from(outboxEmails);
    await getDb()
      .update(outboxEmails)
      .set({ nextRetryAt: 0 })
      .where(eq(outboxEmails.id, row.id));
    expect(
      await attemptOutboxRow(getDb(), env, recordingSender(OK).sender, row.id),
    ).toBe("sent");
    const [held] = await getDb().select().from(outboxEmails);
    expect(held.status).toBe("bookkeeping_pending");
  });

  it("leaves no outbox row, intention or Sent row after a terminal failure", async () => {
    const { authorId } = await seedAccount();
    const res = await jmapCall(authorId, submitCalls()(authorId), {
      sender: recordingSender(TERMINAL).sender,
    });
    const result = res[1][1] as Record<string, any>;
    expect(result.notCreated.k1.type).toBe("forbiddenToSend");
    expect(await getDb().select().from(outboxEmails)).toEqual([]);
    expect(await getDb().select().from(jmapSubmissions)).toEqual([]);
    const { results } = await env.DB.prepare(
      "SELECT id FROM sent_emails",
    ).all();
    expect(results).toEqual([]);
  });
});
