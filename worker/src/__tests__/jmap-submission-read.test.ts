import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  applyMigrations,
  authFetch,
  cleanDb,
  createTestUser,
  getDb,
} from "./helpers";
import { jmapSubmissions } from "../db/jmap-submissions.schema";
import {
  CORE_CAPABILITY,
  MAIL_CAPABILITY,
  SUBMISSION_CAPABILITY,
} from "../jmap/constants";
import {
  MINE,
  addIdentity,
  createDraft,
  recordingSender,
  runJmap,
  submitCall,
} from "./jmap-harness";
import { acct, idn, sub } from "./jmap-ids";

describe("JMAP submission capability", () => {
  beforeAll(async () => {
    await applyMigrations();
  });
  beforeEach(async () => {
    await cleanDb();
  });

  it("advertises urn:ietf:params:jmap:submission and accepts it in using", async () => {
    const { userId, apiKey } = await createTestUser({ id: "sub-session" });
    const session = (await (
      await authFetch("/.well-known/jmap", { apiKey })
    ).json()) as Record<string, any>;
    expect(session.capabilities[SUBMISSION_CAPABILITY]).toEqual({});
    // RFC 4865 §3: FUTURERELEASE carries both EHLO arguments, the longest hold
    // in seconds and the latest release date-time in UTC.
    const submission =
      session.accounts[acct(userId)].accountCapabilities[SUBMISSION_CAPABILITY];
    expect(submission.maxDelayedSend).toBe(86400);
    expect(Object.keys(submission.submissionExtensions)).toEqual([
      "FUTURERELEASE",
    ]);
    const [interval, latest] = submission.submissionExtensions.FUTURERELEASE;
    expect(interval).toBe("86400");
    expect(latest).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    const expected = Date.now() + 86400_000;
    expect(Math.abs(Date.parse(latest) - expected)).toBeLessThan(10_000);
    expect(session.primaryAccounts[SUBMISSION_CAPABILITY]).toBe(acct(userId));

    const echo = await authFetch("/jmap/api", {
      method: "POST",
      apiKey,
      body: JSON.stringify({
        using: [CORE_CAPABILITY, MAIL_CAPABILITY, SUBMISSION_CAPABILITY],
        methodCalls: [["Core/echo", { ok: true }, "c1"]],
      }),
    });
    expect(echo.status).toBe(200);
  });
});

describe("EmailSubmission read methods and Identity/set", () => {
  let userId: string;

  beforeAll(async () => {
    await applyMigrations();
  });
  beforeEach(async () => {
    await cleanDb();
    ({ userId } = await createTestUser({ id: "sub-read-user" }));
    await addIdentity(MINE);
  });

  async function sendDraft(subject = "Hello Bob") {
    const { sender } = recordingSender();
    const draft = await createDraft(userId, sender, { subject });
    const responses = await runJmap(
      userId,
      [submitCall(userId, draft.id)],
      sender,
    );
    const created = (responses[0][1] as Record<string, any>).created.s1;
    return { draft, submissionId: created.id as string, sender };
  }

  it("gets an accepted submission, keeping emailId after the draft is destroyed", async () => {
    const { draft, submissionId, sender } = await sendDraft();
    await runJmap(
      userId,
      [["Email/set", { accountId: acct(userId), destroy: [draft.id] }, "d"]],
      sender,
    );
    const [get] = await runJmap(
      userId,
      [
        [
          "EmailSubmission/get",
          { accountId: acct(userId), ids: [submissionId, sub("nope")] },
          "g",
        ],
      ],
      sender,
    );
    const result = get[1] as Record<string, any>;
    expect(result.notFound).toEqual([sub("nope")]);
    expect(result.list).toEqual([
      {
        id: submissionId,
        identityId: idn(MINE),
        emailId: draft.id,
        threadId: draft.threadId,
        envelope: {
          mailFrom: { email: MINE, parameters: null },
          rcptTo: [{ email: "bob@example.com", parameters: null }],
        },
        sendAt: expect.stringMatching(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/),
        undoStatus: "final",
        deliveryStatus: null,
        dsnBlobIds: [],
        mdnBlobIds: [],
      },
    ]);
    const [filtered] = await runJmap(
      userId,
      [
        [
          "EmailSubmission/get",
          {
            accountId: acct(userId),
            ids: [submissionId],
            properties: ["emailId"],
          },
          "g",
        ],
      ],
      sender,
    );
    expect((filtered[1] as Record<string, any>).list).toEqual([
      { id: submissionId, emailId: draft.id },
    ]);
  });

  it("hides claimed intentions", async () => {
    await getDb()
      .insert(jmapSubmissions)
      .values({
        id: "claimed-1",
        userId,
        attemptState: "claimed",
        onSuccessState: "pending",
        draftId: "d",
        contentId: "c",
        identityId: idn(MINE),
        identityEmail: MINE,
        emailId: "Dd",
        threadId: "Tdd",
        sentEmailId: "sent-claimed",
        envelopeJson: "{}",
        onSuccessMode: "none",
        sendAt: 1,
        createdAt: 1,
      });
    const { sender } = recordingSender();
    const [get, query] = await runJmap(
      userId,
      [
        [
          "EmailSubmission/get",
          { accountId: acct(userId), ids: [sub("claimed-1")] },
          "g",
        ],
        ["EmailSubmission/query", { accountId: acct(userId) }, "q"],
      ],
      sender,
    );
    expect((get[1] as Record<string, any>).notFound).toEqual([
      sub("claimed-1"),
    ]);
    expect((query[1] as Record<string, any>).ids).toEqual([]);
  });

  it("queries with the RFC 8621 filters and sorts", async () => {
    const a = await sendDraft("First");
    const b = await sendDraft("Second");
    const { sender } = recordingSender();
    const q = (args: Record<string, unknown>) =>
      runJmap(
        userId,
        [["EmailSubmission/query", { accountId: acct(userId), ...args }, "q"]],
        sender,
      ).then((responses) => responses[0]);

    const byEmail = await q({ filter: { emailIds: [a.draft.id] } });
    expect((byEmail[1] as Record<string, any>).ids).toEqual([a.submissionId]);
    const byThread = await q({ filter: { threadIds: [b.draft.threadId] } });
    expect((byThread[1] as Record<string, any>).ids).toEqual([b.submissionId]);
    const byIdentity = await q({ filter: { identityIds: [idn(MINE)] } });
    expect((byIdentity[1] as Record<string, any>).ids).toHaveLength(2);
    expect(
      (
        (await q({ filter: { undoStatus: "pending" } }))[1] as Record<
          string,
          any
        >
      ).ids,
    ).toEqual([]);
    expect(
      (
        (await q({ filter: { after: "2999-01-01T00:00:00Z" } }))[1] as Record<
          string,
          any
        >
      ).ids,
    ).toEqual([]);
    expect(
      (
        (await q({ filter: { before: "2999-01-01T00:00:00Z" } }))[1] as Record<
          string,
          any
        >
      ).ids,
    ).toHaveLength(2);

    const sorted = [a, b].sort((x, y) => (x.draft.id < y.draft.id ? 1 : -1));
    const desc = await q({
      sort: [{ property: "emailId", isAscending: false }],
    });
    expect((desc[1] as Record<string, any>).ids).toEqual(
      sorted.map((item) => item.submissionId),
    );
    const page = await q({
      sort: [{ property: "sentAt" }],
      limit: 1,
      calculateTotal: true,
    });
    expect(page[1]).toMatchObject({
      position: 0,
      total: 2,
      canCalculateChanges: false,
    });
    expect((page[1] as Record<string, any>).ids).toHaveLength(1);

    expect(
      (await q({ filter: { operator: "AND", conditions: [] } }))[1],
    ).toMatchObject({ type: "unsupportedFilter" });
    expect((await q({ sort: [{ property: "undoStatus" }] }))[1]).toMatchObject({
      type: "unsupportedSort",
    });
  });

  it("reports submission changes and refuses queryChanges", async () => {
    const { sender } = recordingSender();
    const [before] = await runJmap(
      userId,
      [["EmailSubmission/get", { accountId: acct(userId), ids: [] }, "g"]],
      sender,
    );
    const since = (before[1] as Record<string, any>).state as string;
    const { submissionId } = await sendDraft();

    const [changes, queryChanges, old] = await runJmap(
      userId,
      [
        [
          "EmailSubmission/changes",
          { accountId: acct(userId), sinceState: since },
          "c",
        ],
        [
          "EmailSubmission/queryChanges",
          { accountId: acct(userId), sinceQueryState: since },
          "qc",
        ],
        [
          "EmailSubmission/changes",
          { accountId: acct(userId), sinceState: "j1-5-1-0123456789abcdef" },
          "o",
        ],
      ],
      sender,
    );
    expect(changes[1]).toMatchObject({
      created: [submissionId],
      updated: [],
      destroyed: [],
      hasMoreChanges: false,
    });
    expect(queryChanges).toEqual([
      "error",
      { type: "cannotCalculateChanges" },
      "qc",
    ]);
    expect(old[0]).toBe("error");
    expect((old[1] as Record<string, any>).type).toBe("cannotCalculateChanges");

    const after = (changes[1] as Record<string, any>).newState as string;
    await getDb().delete(jmapSubmissions);
    const [destroyed] = await runJmap(
      userId,
      [
        [
          "EmailSubmission/changes",
          { accountId: acct(userId), sinceState: after },
          "c",
        ],
      ],
      sender,
    );
    expect((destroyed[1] as Record<string, any>).destroyed).toEqual([
      submissionId,
    ]);
  });

  it("Identity/set is read-only", async () => {
    const { sender } = recordingSender();
    const [response] = await runJmap(
      userId,
      [
        [
          "Identity/set",
          {
            accountId: acct(userId),
            create: { n1: { email: MINE, name: "x" } },
            update: { [idn(MINE)]: { name: "Renamed" }, inope: { name: "x" } },
            destroy: [idn(MINE), "inope"],
          },
          "i",
        ],
      ],
      sender,
    );
    const result = response[1] as Record<string, any>;
    expect(response[0]).toBe("Identity/set");
    expect(result.notCreated.n1.type).toBe("forbidden");
    expect(result.notUpdated[idn(MINE)].type).toBe("forbidden");
    expect(result.notUpdated.inope.type).toBe("notFound");
    expect(result.notDestroyed[idn(MINE)].type).toBe("forbidden");
    expect(result.notDestroyed.inope.type).toBe("notFound");
    expect(result.created).toBeNull();
    expect(result.oldState).toBe(result.newState);
  });

  it("requires the submission capability for submission methods only", async () => {
    const { sender } = recordingSender();
    const responses = await runJmap(
      userId,
      [
        ["EmailSubmission/get", { accountId: acct(userId) }, "g"],
        ["Identity/set", { accountId: acct(userId) }, "s"],
        ["Identity/get", { accountId: acct(userId) }, "i"],
      ],
      sender,
      { using: [CORE_CAPABILITY, MAIL_CAPABILITY] },
    );
    expect(responses[0]).toEqual(["error", { type: "unknownMethod" }, "g"]);
    expect(responses[1]).toEqual(["error", { type: "unknownMethod" }, "s"]);
    expect(responses[2][0]).toBe("Identity/get");
  });
});
