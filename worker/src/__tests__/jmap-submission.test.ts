import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { and, eq } from "drizzle-orm";
import {
  applyMigrations,
  cleanDb,
  createTestEmail,
  createTestPerson,
  createTestUser,
  getDb,
} from "./helpers";
import { attachments } from "../db/attachments.schema";
import { jmapDrafts } from "../db/jmap-drafts.schema";
import { jmapMessageContent } from "../db/jmap-message-content.schema";
import { jmapSubmissions } from "../db/jmap-submissions.schema";
import { outboxEmails } from "../db/outbox-emails.schema";
import { sentEmails } from "../db/sent-emails.schema";
import { suppressions } from "../db/suppressions.schema";
import { NoopSender, PostmarkSender } from "../lib/email-sender";
import { attemptOutboxRow } from "../lib/outbox";
import { submissionAttachmentLeaves } from "../lib/submit-message";
import { parseDraftEmailId, parseRawBlobId } from "../jmap/public-ids";
import {
  MINE,
  OK,
  OTHER,
  PERMANENT,
  TRANSIENT,
  addIdentity,
  createDraft,
  draftCreate,
  recordingSender,
  runJmap,
  submitCall,
  uploadBlob,
} from "./jmap-harness";
import { acct, drf, idn, rid, sid, sys } from "./jmap-ids";

type Created = {
  id: string;
  threadId: string;
  sendAt: string;
  undoStatus: string;
};

function submissionResult(responses: unknown[][], callId = "s") {
  const found = responses.find((response) => response[2] === callId);
  if (!found) throw new Error(`no response for ${callId}`);
  return found[1] as Record<string, any>;
}

async function draftRow(draftId: string) {
  const [row] = await getDb()
    .select()
    .from(jmapDrafts)
    .where(eq(jmapDrafts.id, parseDraftEmailId(draftId)!));
  return row;
}

async function sentRowsFor(contentId: string) {
  return getDb()
    .select()
    .from(sentEmails)
    .where(eq(sentEmails.jmapContentId, contentId));
}

async function sentObjectsNamed(filename: string) {
  // R2 is not reset between tests, so R2 assertions are scoped by a filename
  // unique to the test.
  return (await env.R2.list({ prefix: "attachments/sent/" })).objects
    .map((object) => object.key)
    .filter((key) => key.endsWith(`/${filename}`));
}

async function expectNothingStaged(draftId: string, filename?: string) {
  expect(await getDb().select().from(jmapSubmissions)).toHaveLength(0);
  expect(
    await getDb()
      .select()
      .from(attachments)
      .where(eq(attachments.kind, "sent")),
  ).toHaveLength(0);
  if (filename) expect(await sentObjectsNamed(filename)).toEqual([]);
  expect(await getDb().select().from(outboxEmails)).toHaveLength(0);
  const draft = await draftRow(draftId);
  expect(draft.submitState).toBeNull();
  expect(draft.submitAttemptId).toBeNull();
}

describe("EmailSubmission/set create", () => {
  let userId: string;
  let apiKey: string;

  beforeAll(async () => {
    await applyMigrations();
  });
  beforeEach(async () => {
    await cleanDb();
    ({ userId, apiKey } = await createTestUser({ id: "sub-user" }));
    await addIdentity(MINE);
  });

  it("sends a draft created earlier in the same request, exactly, as a visible Sent Email", async () => {
    const png = new Uint8Array([137, 80, 78, 71]);
    const logo = await uploadBlob(userId, apiKey, png, "image/png");
    const notes = await uploadBlob(
      userId,
      apiKey,
      new TextEncoder().encode("notes"),
      "text/plain",
    );
    const { sender, calls } = recordingSender();
    const [stateBefore] = await runJmap(
      userId,
      [["Email/get", { accountId: acct(userId), ids: [] }, "g"]],
      sender,
    );

    const responses = await runJmap(
      userId,
      [
        [
          "Email/set",
          {
            accountId: acct(userId),
            create: {
              d1: draftCreate({
                cc: [{ name: "Doe, Jane", email: "jane@example.com" }],
                bodyValues: {
                  t: { value: "Hi Bob" },
                  h: { value: '<p>Hi Bob <img src="cid:logo@mine"></p>' },
                },
                attachments: [
                  {
                    blobId: logo,
                    type: "image/png",
                    name: "logo.png",
                    disposition: "inline",
                    cid: "logo@mine",
                  },
                  {
                    blobId: notes,
                    type: "text/plain",
                    name: "notes.txt",
                    disposition: "attachment",
                  },
                ],
              }),
            },
          },
          "e1",
        ],
        submitCall(userId, "#d1"),
      ],
      sender,
    );

    const draft = (responses[0][1] as Record<string, any>).created.d1;
    const result = submissionResult(responses);
    const created = result.created.s1 as Created;
    expect(created.id).toMatch(/^E[A-Za-z0-9_-]+$/);
    expect(created.undoStatus).toBe("final");
    expect(created.threadId).toBe(draft.threadId);
    expect(created.sendAt).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);

    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call.from).toBe("Mine <mine@saasmail.test>");
    expect(call.to).toBe("Bob Example <bob@example.com>");
    expect(call.cc).toEqual(['"Doe, Jane" <jane@example.com>']);
    expect(call.subject).toBe("Hello Bob");
    expect(call.html).toBe('<p>Hi Bob <img src="cid:logo@mine"></p>');
    expect(call.text).toBe("Hi Bob");
    expect(call.headers?.["Message-ID"]).toMatch(/^<.+@saasmail\.test>$/);
    expect(call.headers?.Date).toMatch(
      /^[A-Z][a-z]{2}, \d\d [A-Z][a-z]{2} \d{4} \d\d:\d\d:\d\d [+-]\d{4}$/,
    );
    expect(call.headers?.["List-Unsubscribe"]).toBeUndefined();
    expect(
      (call.attachments ?? []).map((a) => [
        a.filename,
        a.contentType,
        a.contentId ?? null,
        a.disposition,
      ]),
    ).toEqual([
      ["logo.png", "image/png", "logo@mine", "inline"],
      ["notes.txt", "text/plain", null, "attachment"],
    ]);
    expect(
      Array.from(new Uint8Array(call.attachments![0].content as Uint8Array)),
    ).toEqual(Array.from(png));

    const contentId = parseRawBlobId(draft.blobId)!;
    const [sent] = await sentRowsFor(contentId);
    expect(sent).toMatchObject({
      status: "sent",
      fromAddress: MINE,
      toAddress: "bob@example.com",
      subject: "Hello Bob",
      messageId: call.headers?.["Message-ID"],
    });
    expect(JSON.parse(sent.cc!)).toEqual([
      { email: "jane@example.com", name: "Doe, Jane" },
    ]);
    const staged = await getDb()
      .select()
      .from(attachments)
      .where(
        and(eq(attachments.emailId, sent.id), eq(attachments.kind, "sent")),
      );
    expect(staged.map((row) => [row.filename, row.contentId]).sort()).toEqual([
      ["logo.png", "logo@mine"],
      ["notes.txt", null],
    ]);
    expect(
      (await env.R2.list({ prefix: `attachments/sent/${sent.id}/` })).objects,
    ).toHaveLength(2);

    const [submission] = await getDb().select().from(jmapSubmissions);
    expect(submission).toMatchObject({
      attemptState: "accepted",
      onSuccessState: "applied",
      emailId: draft.id,
      identityEmail: MINE,
      sentEmailId: sent.id,
    });
    expect((await draftRow(draft.id)).submitState).toBeNull();
    expect(await getDb().select().from(outboxEmails)).toHaveLength(0);

    const [query, changes] = await runJmap(
      userId,
      [
        [
          "Email/query",
          { accountId: acct(userId), filter: { inMailbox: sys(MINE, "sent") } },
          "q",
        ],
        [
          "Email/changes",
          {
            accountId: acct(userId),
            sinceState: (stateBefore[1] as Record<string, any>).state,
          },
          "c",
        ],
      ],
      sender,
    );
    expect((query[1] as Record<string, any>).ids).toEqual([sid(sent.id)]);
    // Spec §5: claiming and releasing the draft's lock writes no Email change.
    expect((changes[1] as Record<string, any>).updated).not.toContain(draft.id);
    expect((changes[1] as Record<string, any>).created).toContain(sid(sent.id));
  });

  it("is transactional: a suppressed To still receives it, with the body untouched", async () => {
    await getDb().insert(suppressions).values({
      id: "sup-bob",
      email: "bob@example.com",
      reason: "unsubscribe",
      createdAt: 1,
    });
    const { sender, calls } = recordingSender();
    const draft = await createDraft(userId, sender);
    const responses = await runJmap(
      userId,
      [submitCall(userId, draft.id)],
      sender,
    );
    expect(submissionResult(responses).created.s1).toBeDefined();
    expect(calls).toHaveLength(1);
    expect(calls[0].html).toBe("<p>Hi Bob</p>");
    expect(calls[0].headers?.["List-Unsubscribe"]).toBeUndefined();
  });

  it("rejects a missing, non-draft or unresolved emailId and an unknown identity", async () => {
    await createTestPerson({ id: "p-bob", email: "bob@example.com" });
    await createTestEmail({ id: "recv-1", personId: "p-bob", recipient: MINE });
    const { sender, calls } = recordingSender();
    const responses = await runJmap(
      userId,
      [
        [
          "EmailSubmission/set",
          {
            accountId: acct(userId),
            create: {
              a: { identityId: idn(MINE), emailId: drf("missing") },
              b: { identityId: idn(MINE), emailId: rid("recv-1") },
              c: { identityId: idn(MINE), emailId: "#nope" },
              d: { identityId: idn("nobody@saasmail.test"), emailId: drf("x") },
              e: {
                identityId: idn(MINE),
                emailId: drf("x"),
                sendAt: "2026-01-01T00:00:00Z",
              },
            },
          },
          "s",
        ],
      ],
      sender,
    );
    const { notCreated, created } = submissionResult(responses);
    expect(created).toBeNull();
    expect(notCreated.a).toMatchObject({
      type: "invalidProperties",
      properties: ["emailId"],
    });
    expect(notCreated.b).toMatchObject({
      type: "invalidProperties",
      properties: ["emailId"],
    });
    expect(notCreated.c).toMatchObject({
      type: "invalidProperties",
      properties: ["emailId"],
    });
    expect(notCreated.d).toMatchObject({
      type: "invalidProperties",
      properties: ["emailId", "identityId"],
    });
    expect(notCreated.e).toMatchObject({
      type: "invalidProperties",
      properties: ["sendAt"],
    });
    expect(calls).toHaveLength(0);
  });

  it("rejects a From that isn't the identity's address with forbiddenFrom", async () => {
    await addIdentity(OTHER, "Other");
    const { sender, calls } = recordingSender();
    const draft = await createDraft(userId, sender);
    const responses = await runJmap(
      userId,
      [submitCall(userId, draft.id, { identityId: idn(OTHER) })],
      sender,
    );
    expect(submissionResult(responses).notCreated.s1).toMatchObject({
      type: "forbiddenFrom",
    });
    expect(calls).toHaveLength(0);
    await expectNothingStaged(draft.id);
  });

  it("with a provider that can't send them, refuses a second To and Bcc; always refuses a missing To", async () => {
    const { sender, calls } = recordingSender();
    const twoTo = await createDraft(userId, sender, {
      to: [
        { name: null, email: "bob@example.com" },
        { name: null, email: "carol@example.com" },
      ],
    });
    const withBcc = await createDraft(userId, sender, {
      bcc: [{ name: null, email: "hidden@example.com" }],
    });
    const noTo = await createDraft(userId, sender, {
      to: [],
      cc: [{ name: null, email: "carol@example.com" }],
    });
    const responses = await runJmap(
      userId,
      [
        submitCall(userId, twoTo.id, {}, "a"),
        submitCall(userId, withBcc.id, {}, "b"),
        submitCall(userId, noTo.id, {}, "c"),
      ],
      sender,
    );
    expect(submissionResult(responses, "a").notCreated.s1).toMatchObject({
      type: "invalidEmail",
      properties: ["to"],
    });
    expect(submissionResult(responses, "b").notCreated.s1).toMatchObject({
      type: "invalidEmail",
      properties: ["bcc"],
    });
    expect(submissionResult(responses, "c").notCreated.s1).toMatchObject({
      type: "noRecipients",
    });
    expect(calls).toHaveLength(0);
  });

  it("checks a supplied envelope", async () => {
    const { sender, calls } = recordingSender();
    const draft = await createDraft(userId, sender);
    const cases: [Record<string, unknown>, Record<string, unknown>][] = [
      [
        {
          mailFrom: { email: "someone@else.com" },
          rcptTo: [{ email: "bob@example.com" }],
        },
        { type: "forbiddenMailFrom" },
      ],
      [
        { mailFrom: { email: MINE }, rcptTo: [{ email: "eve@example.com" }] },
        { type: "invalidEmail" },
      ],
      [
        {
          mailFrom: { email: MINE },
          rcptTo: [
            { email: "bob@example.com", parameters: { NOTIFY: "NEVER" } },
          ],
        },
        { type: "invalidProperties", properties: ["envelope"] },
      ],
    ];
    for (const [envelope, expected] of cases) {
      const responses = await runJmap(
        userId,
        [submitCall(userId, draft.id, { envelope })],
        sender,
      );
      expect(submissionResult(responses).notCreated.s1).toMatchObject(expected);
    }
    expect(calls).toHaveLength(0);
    const accepted = await runJmap(
      userId,
      [
        submitCall(userId, draft.id, {
          envelope: {
            mailFrom: { email: MINE, parameters: null },
            rcptTo: [{ email: "BOB@example.com" }],
          },
        }),
      ],
      sender,
    );
    expect(submissionResult(accepted).created.s1).toBeDefined();
  });

  it("rejects a draft whose attachment copy vanished, before claiming anything", async () => {
    const blob = await uploadBlob(
      userId,
      apiKey,
      new Uint8Array([1]),
      "application/pdf",
    );
    const { sender, calls } = recordingSender();
    const draft = await createDraft(userId, sender, {
      attachments: [
        { blobId: blob, type: "application/pdf", name: "vanished.pdf" },
      ],
    });
    const [content] = await getDb()
      .select()
      .from(jmapMessageContent)
      .where(eq(jmapMessageContent.id, parseRawBlobId(draft.blobId)!));
    for (const leaf of submissionAttachmentLeaves(content)) {
      await env.R2.delete(leaf.r2Key!);
    }
    const responses = await runJmap(
      userId,
      [submitCall(userId, draft.id)],
      sender,
    );
    expect(submissionResult(responses).notCreated.s1).toMatchObject({
      type: "invalidEmail",
      properties: ["attachments"],
    });
    expect(calls).toHaveLength(0);
    await expectNothingStaged(draft.id, "vanished.pdf");
  });

  it("with no provider configured, refuses with forbiddenToSend rather than tooLarge", async () => {
    const draft = await createDraft(userId, recordingSender().sender);
    const responses = await runJmap(
      userId,
      [submitCall(userId, draft.id)],
      new NoopSender(),
    );
    expect(submissionResult(responses).notCreated.s1).toEqual({
      type: "forbiddenToSend",
      description: "No email provider is configured on this server",
    });
    await expectNothingStaged(draft.id);
  });

  it("rejects a message over the provider cap with tooLarge.maxSize (Postmark: 10 MB)", async () => {
    const { sender } = recordingSender();
    const draft = await createDraft(userId, sender);
    await getDb()
      .update(jmapMessageContent)
      .set({ size: 10_000_001 })
      .where(eq(jmapMessageContent.id, parseRawBlobId(draft.blobId)!));
    const fetchMock = async () => {
      throw new Error("Postmark must not be called");
    };
    const postmark = new PostmarkSender(
      "pm_test",
      fetchMock as unknown as typeof fetch,
    );
    const responses = await runJmap(
      userId,
      [submitCall(userId, draft.id)],
      postmark,
    );
    expect(submissionResult(responses).notCreated.s1).toMatchObject({
      type: "tooLarge",
      maxSize: 10_000_000,
    });
    await expectNothingStaged(draft.id);
  });

  it("a terminal provider failure writes no Sent row and leaves nothing staged", async () => {
    const blob = await uploadBlob(
      userId,
      apiKey,
      new Uint8Array([7]),
      "application/pdf",
    );
    const { sender, calls } = recordingSender([PERMANENT]);
    const draft = await createDraft(userId, sender, {
      attachments: [
        { blobId: blob, type: "application/pdf", name: "rejected.pdf" },
      ],
    });
    const responses = await runJmap(
      userId,
      [submitCall(userId, draft.id)],
      sender,
    );
    expect(submissionResult(responses).notCreated.s1).toEqual({
      type: "forbiddenToSend",
      description: "550 mailbox unavailable",
    });
    expect(calls).toHaveLength(1);
    expect(await sentRowsFor(parseRawBlobId(draft.blobId)!)).toHaveLength(0);
    await expectNothingStaged(draft.id, "rejected.pdf");
  });

  it("a retrying send is accepted, keeps the draft queued, and unlocks once the outbox gives up", async () => {
    const first = recordingSender([TRANSIENT]);
    const draft = await createDraft(userId, first.sender);
    const accepted = await runJmap(
      userId,
      [submitCall(userId, draft.id)],
      first.sender,
    );
    expect(submissionResult(accepted).created.s1).toBeDefined();
    const [sent] = await sentRowsFor(parseRawBlobId(draft.blobId)!);
    expect(sent.status).toBe("retrying");
    expect((await draftRow(draft.id)).submitState).toBe("queued");

    const second = recordingSender();
    const blocked = await runJmap(
      userId,
      [submitCall(userId, draft.id)],
      second.sender,
    );
    expect(submissionResult(blocked).notCreated.s1).toMatchObject({
      type: "forbiddenToSend",
      description: "This message is already being sent",
    });
    expect(second.calls).toHaveLength(0);

    const [row] = await getDb()
      .select()
      .from(outboxEmails)
      .where(eq(outboxEmails.sentEmailId, sent.id));
    await getDb()
      .update(outboxEmails)
      .set({ nextRetryAt: 0 })
      .where(eq(outboxEmails.id, row.id));
    const failing = recordingSender([PERMANENT]);
    expect(await attemptOutboxRow(getDb(), env, failing.sender, row.id)).toBe(
      "failed",
    );

    const third = recordingSender();
    const resent = await runJmap(
      userId,
      [submitCall(userId, draft.id)],
      third.sender,
    );
    expect(submissionResult(resent).created.s1).toBeDefined();
    expect(third.calls).toHaveLength(1);
  });

  it("two concurrent submissions of one draft make exactly one provider call", async () => {
    const { sender: base } = recordingSender();
    const draft = await createDraft(userId, base);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { sender, calls } = recordingSender();
    const blockingSend = sender.send.bind(sender);
    sender.send = async (params) => {
      const result = await blockingSend(params);
      await gate; // hold the winner inside the provider call
      return result;
    };

    const first = runJmap(userId, [submitCall(userId, draft.id)], sender);
    const second = runJmap(userId, [submitCall(userId, draft.id)], sender);
    const loser = await Promise.race([
      first.then(() => "first"),
      second.then(() => "second"),
      new Promise((resolve) => setTimeout(() => resolve("timeout"), 5000)),
    ]);
    release();
    const results = (await Promise.all([first, second])).map((responses) =>
      submissionResult(responses),
    );

    expect(loser).not.toBe("timeout");
    expect(calls).toHaveLength(1);
    expect(results.filter((result) => result.created?.s1)).toHaveLength(1);
    expect(
      results.find((result) => result.notCreated?.s1)?.notCreated.s1,
    ).toMatchObject({ type: "forbiddenToSend" });
  });

  it("an R2 staging failure leaves neither rows nor objects and releases the draft", async () => {
    const blob = await uploadBlob(
      userId,
      apiKey,
      new Uint8Array([9]),
      "application/pdf",
    );
    const { sender, calls } = recordingSender();
    const draft = await createDraft(userId, sender, {
      attachments: [
        { blobId: blob, type: "application/pdf", name: "staging.pdf" },
      ],
    });
    const r2 = new Proxy(env.R2, {
      get(target, prop) {
        if (prop === "put") {
          return async (key: string, ...rest: unknown[]) => {
            if (key.startsWith("attachments/sent/")) throw new Error("r2 down");
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            return (target as any).put(key, ...rest);
          };
        }
        const value = Reflect.get(target, prop);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const failingEnv = new Proxy(env, {
      get(target, prop) {
        return prop === "R2" ? r2 : Reflect.get(target, prop);
      },
    }) as CloudflareBindings;

    const responses = await runJmap(
      userId,
      [submitCall(userId, draft.id)],
      sender,
      {
        env: failingEnv,
      },
    );
    expect(responses[0][0]).toBe("EmailSubmission/set");
    expect(
      (responses[0][1] as { notCreated: Record<string, { type: string }> })
        .notCreated.s1.type,
    ).toBe("serverFail");
    expect(calls).toHaveLength(0);
    await expectNothingStaged(draft.id, "staging.pdf");
  });

  it("sends a text-only draft as text with its Reply-To, and refuses two Reply-To addresses", async () => {
    const { sender, calls } = recordingSender();
    const textOnly = await createDraft(userId, sender, {
      bodyValues: { t: { value: "Line one\nwrite to <help@example.com>" } },
      htmlBody: undefined,
      replyTo: [{ name: "Tickets", email: "tickets@example.com" }],
    });
    const [sent] = await runJmap(
      userId,
      [submitCall(userId, textOnly.id)],
      sender,
    );
    expect(
      (sent[1] as { created: Record<string, unknown> }).created.s1,
    ).toBeTruthy();
    expect(calls).toHaveLength(1);
    expect(calls[0].html).toBe("");
    expect(calls[0].text).toBe("Line one\nwrite to <help@example.com>");
    expect(calls[0].headers?.["Reply-To"]).toBe("tickets@example.com");

    const twoReplyTo = await createDraft(userId, sender, {
      replyTo: [{ email: "a@example.com" }, { email: "b@example.com" }],
    });
    const [refused] = await runJmap(
      userId,
      [submitCall(userId, twoReplyTo.id)],
      sender,
    );
    expect(
      (refused[1] as { notCreated: Record<string, unknown> }).notCreated.s1,
    ).toMatchObject({ type: "invalidEmail", properties: ["replyTo"] });
    expect(calls).toHaveLength(1);
  });

  it("reports a create the provider accepted even when its bookkeeping fails", async () => {
    const { sender, calls } = recordingSender();
    const draft = await createDraft(userId, sender);
    await env.DB.prepare(
      `CREATE TRIGGER sent_insert_fails BEFORE INSERT ON sent_emails
       BEGIN SELECT RAISE(ABORT, 'd1 down'); END`,
    ).run();
    let responses: unknown[][];
    try {
      responses = await runJmap(userId, [submitCall(userId, draft.id)], sender);
    } finally {
      await env.DB.prepare("DROP TRIGGER sent_insert_fails").run();
    }
    expect(calls).toHaveLength(1);
    expect(responses[0][0]).toBe("EmailSubmission/set");
    expect(
      (responses[0][1] as { created: Record<string, { id: string }> }).created
        .s1.id,
    ).toMatch(/^E/);
    // Recovery finishes it: the held outbox row is the evidence, and the
    // draft stays locked so nothing resends it meanwhile.
    const [outbox] = await getDb().select().from(outboxEmails);
    expect(outbox.status).toBe("bookkeeping_pending");
    expect((await draftRow(draft.id)).submitState).toBe("submitting");
  });

  it("still answers with the submission when its on-success step fails", async () => {
    const { sender, calls } = recordingSender();
    const draft = await createDraft(userId, sender);
    await env.DB.prepare(
      `CREATE TRIGGER on_success_fails BEFORE UPDATE OF on_success_state ON jmap_submissions
       BEGIN SELECT RAISE(ABORT, 'd1 down'); END`,
    ).run();
    let responses: unknown[][];
    try {
      responses = await runJmap(
        userId,
        [
          [
            "EmailSubmission/set",
            {
              accountId: acct(userId),
              create: { s1: { identityId: idn(MINE), emailId: draft.id } },
              onSuccessUpdateEmail: {
                "#s1": { "keywords/$flagged": true },
              },
            },
            "s",
          ],
        ],
        sender,
      );
    } finally {
      await env.DB.prepare("DROP TRIGGER on_success_fails").run();
    }
    expect(calls).toHaveLength(1);
    expect(responses[0][0]).toBe("EmailSubmission/set");
    expect(
      (responses[0][1] as { created: Record<string, { id: string }> }).created
        .s1.id,
    ).toMatch(/^E/);
    expect(responses[1]).toEqual([
      "error",
      expect.objectContaining({ type: "serverFail" }),
      "s",
    ]);
    // The step stays pending, so the hourly recovery applies it.
    const [submission] = await getDb().select().from(jmapSubmissions);
    expect(submission.onSuccessState).toBe("pending");
  });

  it("a failing create still reports the creates already sent in the same call", async () => {
    const blob = await uploadBlob(
      userId,
      apiKey,
      new Uint8Array([9]),
      "application/pdf",
    );
    const { sender, calls } = recordingSender();
    const plain = await createDraft(userId, sender);
    const withFile = await createDraft(userId, sender, {
      attachments: [{ blobId: blob, type: "application/pdf", name: "b.pdf" }],
    });
    const r2 = new Proxy(env.R2, {
      get(target, prop) {
        if (prop === "put") {
          return async (key: string, ...rest: unknown[]) => {
            if (key.startsWith("attachments/sent/")) throw new Error("r2 down");
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            return (target as any).put(key, ...rest);
          };
        }
        const value = Reflect.get(target, prop);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const failingEnv = new Proxy(env, {
      get(target, prop) {
        return prop === "R2" ? r2 : Reflect.get(target, prop);
      },
    }) as CloudflareBindings;

    const responses = await runJmap(
      userId,
      [
        [
          "EmailSubmission/set",
          {
            accountId: acct(userId),
            create: {
              a: { identityId: idn(MINE), emailId: plain.id },
              b: { identityId: idn(MINE), emailId: withFile.id },
            },
          },
          "s",
        ],
      ],
      sender,
      { env: failingEnv },
    );
    expect(responses[0][0]).toBe("EmailSubmission/set");
    const result = responses[0][1] as {
      created: Record<string, { id: string }>;
      notCreated: Record<string, { type: string }>;
    };
    expect(result.created.a.id).toMatch(/^E/);
    expect(result.notCreated.b.type).toBe("serverFail");
    expect(calls).toHaveLength(1);
  });

  it("keeps the staged attachments when D1 fails after the outbox row exists", async () => {
    const blob = await uploadBlob(
      userId,
      apiKey,
      new Uint8Array([5]),
      "application/pdf",
    );
    const { sender } = recordingSender([TRANSIENT]);
    const draft = await createDraft(userId, sender, {
      attachments: [{ blobId: blob, type: "application/pdf", name: "a.pdf" }],
    });
    await env.DB.prepare(
      `CREATE TRIGGER outbox_update_fails BEFORE UPDATE ON outbox_emails
       BEGIN SELECT RAISE(ABORT, 'd1 down'); END`,
    ).run();
    let responses: unknown[][];
    try {
      responses = await runJmap(userId, [submitCall(userId, draft.id)], sender);
    } finally {
      await env.DB.prepare("DROP TRIGGER outbox_update_fails").run();
    }
    expect(
      (responses[0][1] as { notCreated: Record<string, { type: string }> })
        .notCreated.s1.type,
    ).toBe("serverFail");
    const [outbox] = await getDb().select().from(outboxEmails);
    expect(outbox.status).toBe("pending");
    expect(
      await getDb()
        .select()
        .from(attachments)
        .where(
          and(
            eq(attachments.emailId, outbox.sentEmailId),
            eq(attachments.kind, "sent"),
          ),
        ),
    ).toHaveLength(1);
    const [submission] = await getDb().select().from(jmapSubmissions);
    expect(submission.attemptState).toBe("claimed");
    expect((await draftRow(draft.id)).submitState).toBe("submitting");
  });

  it("keeps a reply's exact subject and threads it with the original", async () => {
    await createTestPerson({ id: "p-bob", email: "bob@example.com" });
    await createTestEmail({
      id: "orig-1",
      personId: "p-bob",
      recipient: MINE,
      subject: "Question",
      messageId: "orig-1@example.com",
    });
    const { sender, calls } = recordingSender();
    const draft = await createDraft(userId, sender, {
      subject: "Question",
      inReplyTo: ["orig-1@example.com"],
      references: ["orig-1@example.com"],
    });
    const responses = await runJmap(
      userId,
      [submitCall(userId, draft.id)],
      sender,
    );
    expect(submissionResult(responses).created.s1).toBeDefined();
    expect(calls[0].subject).toBe("Question");
    expect(calls[0].headers?.["In-Reply-To"]).toBe("<orig-1@example.com>");
    expect(calls[0].headers?.References).toBe("<orig-1@example.com>");

    const [sent] = await sentRowsFor(parseRawBlobId(draft.blobId)!);
    expect(sent.personId).toBe("p-bob");
    expect(sent.inReplyTo).toBe("<orig-1@example.com>");
    const [get] = await runJmap(
      userId,
      [
        [
          "Email/get",
          {
            accountId: acct(userId),
            ids: [rid("orig-1"), sid(sent.id)],
            properties: ["threadId"],
          },
          "g",
        ],
      ],
      sender,
    );
    const [original, reply] = (get[1] as Record<string, any>).list;
    expect(reply.threadId).toBe(original.threadId);
  });

  it("runs the on-success step and treats update/destroy as read-only", async () => {
    const { sender } = recordingSender();
    const draft = await createDraft(userId, sender);
    // PR 6 supports the on-success arguments: a destroy now takes the draft away
    // in the implicit Email/set that follows this response.
    const destroyed = await runJmap(
      userId,
      [
        [
          "EmailSubmission/set",
          {
            accountId: acct(userId),
            create: { s1: { identityId: idn(MINE), emailId: draft.id } },
            onSuccessDestroyEmail: ["#s1"],
          },
          "s",
        ],
      ],
      sender,
    );
    expect(destroyed[0][0]).toBe("EmailSubmission/set");
    expect(submissionResult(destroyed).created.s1.id).toMatch(/^E/);
    // RFC 8621 §7.5: the implicit Email/set answers under the same call id.
    expect(destroyed[1][0]).toBe("Email/set");
    expect(destroyed[1][1].destroyed).toEqual([draft.id]);

    const kept = await createDraft(userId, sender);
    const sent = await runJmap(userId, [submitCall(userId, kept.id)], sender);
    const id = submissionResult(sent).created.s1.id as string;
    const [changed] = await runJmap(
      userId,
      [
        [
          "EmailSubmission/set",
          {
            accountId: acct(userId),
            update: { [id]: { undoStatus: "canceled" }, Enope: {} },
            destroy: [id, "Enope"],
          },
          "s",
        ],
      ],
      sender,
    );
    const result = changed[1] as Record<string, any>;
    expect(result.notUpdated[id].type).toBe("forbidden");
    expect(result.notUpdated.Enope.type).toBe("notFound");
    expect(result.notDestroyed[id].type).toBe("forbidden");
    expect(result.notDestroyed.Enope.type).toBe("notFound");

    // More ids than D1 binds in one statement are still answered one by one.
    const many = Array.from({ length: 150 }, (_, i) => `Enope${i}`);
    const [bulk] = await runJmap(
      userId,
      [
        [
          "EmailSubmission/set",
          { accountId: acct(userId), destroy: [id, ...many] },
          "s",
        ],
      ],
      sender,
    );
    expect(bulk[0]).toBe("EmailSubmission/set");
    const bulkResult = bulk[1] as Record<string, any>;
    expect(bulkResult.notDestroyed[id].type).toBe("forbidden");
    expect(bulkResult.notDestroyed.Enope149.type).toBe("notFound");
  });
});
