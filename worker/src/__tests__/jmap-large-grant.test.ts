// D1 binds at most 100 parameters per statement. A member granted 150 inboxes
// (plus one inbox they are not granted, with mail in it) drives every JMAP read
// and write path and the web message list through the real worker, with each
// statement's bound-parameter count recorded, and none may pass 100.
import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { users } from "../db/auth.schema";
import { createDb } from "../db/client";
import { inboxPermissions } from "../db/inbox-permissions.schema";
import { jmapDrafts } from "../db/jmap-drafts.schema";
import { mailboxes } from "../db/mailboxes.schema";
import { messageMailboxes } from "../db/message-mailboxes.schema";
import { senderIdentities } from "../db/sender-identities.schema";
import { CORE_CAPABILITY, MAIL_CAPABILITY } from "../jmap/constants";
import { openEventSource } from "../jmap/event-source";
import { executeJmapCalls } from "../jmap/http";
import { jmapStateIssuedAt } from "../jmap/state";
import { THREAD_CHANGES_QUERY_BUDGET } from "../jmap/thread-changes";
import { storeUpload } from "../jmap/upload";
import { resolveAllowedInboxes } from "../lib/inbox-permissions";
import worker from "../index";
import {
  applyMigrations,
  cleanDb,
  createTestEmail,
  createTestPerson,
  createTestSentEmail,
  createTestUser,
  getDb,
} from "./helpers";
import { acct, drf, mbx, rid, sid, sys, thread } from "./jmap-ids";
import {
  INBOX,
  insertTestContent,
  insertTestDraft,
  jmapCall,
  seedAccount,
} from "./jmap-submission-fixtures";

const D1_MAX_PARAMS = 100;
const GRANTED = Array.from(
  { length: 150 },
  (_, index) => `box${String(index + 1).padStart(3, "0")}@big.test`,
);
const FIRST = GRANTED[0];
const LAST = GRANTED[149];
const CONTROL = "control@big.test";

type Statement = { sql: string; params: number };

/** env.DB with every statement and its bound-parameter count recorded. */
function recordingD1(): { db: D1Database; statements: Statement[] } {
  const statements: Statement[] = [];
  const wrap = (statement: any, entry: Statement): any =>
    new Proxy(statement, {
      get(target, prop) {
        const value = target[prop];
        if (prop === "bind") {
          return (...args: unknown[]) => {
            entry.params = args.length;
            return wrap(value.apply(target, args), entry);
          };
        }
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  const db = new Proxy(env.DB, {
    get(target, prop) {
      if (prop === "prepare") {
        return (query: string) => {
          const entry = { sql: query, params: 0 };
          statements.push(entry);
          return wrap(target.prepare(query), entry);
        };
      }
      if (prop === "exec") {
        return (query: string) => {
          statements.push({ sql: query, params: 0 });
          return target.exec(query);
        };
      }
      const value = (target as any)[prop];
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { db, statements };
}

function expectWithinD1Limit(statements: Statement[]) {
  expect(statements.length).toBeGreaterThan(0);
  const widest = Math.max(...statements.map((s) => s.params));
  const over = statements.filter((s) => s.params > D1_MAX_PARAMS);
  expect(
    over.map((s) => `${s.params}: ${s.sql.slice(0, 200)}`),
    `widest statement: ${widest} parameters`,
  ).toEqual([]);
}

const ctx = {
  waitUntil: () => {},
  passThroughOnException: () => {},
  props: {},
} as unknown as ExecutionContext;

/** A request through the real worker, on a recorded D1. */
async function recordedFetch(
  path: string,
  apiKey: string,
  init: RequestInit = {},
): Promise<{ response: Response; statements: Statement[] }> {
  const recorded = recordingD1();
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${apiKey}`);
  if (typeof init.body === "string") {
    headers.set("Content-Type", "application/json");
  }
  const response = await worker.fetch!(
    new Request(`http://localhost${path}`, { ...init, headers }) as any,
    { ...env, DB: recorded.db } as unknown as CloudflareBindings,
    ctx,
  );
  return { response, statements: recorded.statements };
}

type MethodResponse = [string, Record<string, any>, string];

async function jmap(
  apiKey: string,
  methodCalls: unknown[],
): Promise<{ responses: MethodResponse[]; statements: Statement[] }> {
  const { response, statements } = await recordedFetch("/jmap/api", apiKey, {
    method: "POST",
    body: JSON.stringify({
      using: [CORE_CAPABILITY, MAIL_CAPABILITY],
      methodCalls,
    }),
  });
  expect(response.status).toBe(200);
  const body = (await response.json()) as { methodResponses: MethodResponse[] };
  expectWithinD1Limit(statements);
  return { responses: body.methodResponses, statements };
}

async function grant(userId: string, inboxes: string[]) {
  const now = Math.floor(Date.now() / 1000);
  // A multi-row insert of 32+ permission rows would itself pass 100.
  for (let start = 0; start < inboxes.length; start += 10) {
    await getDb()
      .insert(inboxPermissions)
      .values(
        inboxes.slice(start, start + 10).map((email) => ({
          userId,
          email,
          createdAt: now,
          createdBy: null,
        })),
      );
  }
}

async function addIdentity(email: string) {
  const now = Math.floor(Date.now() / 1000);
  await getDb()
    .insert(senderIdentities)
    .values({ email, displayName: "Box", createdAt: now, updatedAt: now });
}

async function seed() {
  const { userId, apiKey } = await createTestUser({
    id: "big-member",
    role: "member",
    email: "big-member@example.com",
  });
  await grant(userId, GRANTED);
  await addIdentity(FIRST);
  await addIdentity(LAST);
  await createTestPerson({ id: "big-person", email: "alice@example.com" });
  for (const id of ["first-a", "first-b", "first-c"]) {
    await createTestEmail({
      id,
      personId: "big-person",
      recipient: FIRST,
      messageId: `${id}@example.com`,
      conversationId: `conv-${id}`,
    });
  }
  await createTestEmail({
    id: "last-orig",
    personId: "big-person",
    recipient: LAST,
    messageId: "orig@example.com",
    conversationId: "conv-last-orig",
  });
  await createTestEmail({
    id: "control-mail",
    personId: "big-person",
    recipient: CONTROL,
    messageId: "control@example.com",
    conversationId: "conv-control",
  });
  return { userId, apiKey };
}

async function currentState(apiKey: string, userId: string) {
  const { responses } = await jmap(apiKey, [
    ["Email/get", { accountId: acct(userId), ids: [] }, "s"],
  ]);
  return responses[0][1].state as string;
}

const FIRST_IDS = ["first-a", "first-b", "first-c"].map(rid);

describe("a member granted 150 inboxes: every statement binds at most 100 parameters", () => {
  beforeAll(async () => {
    await applyMigrations();
  });
  beforeEach(async () => {
    await cleanDb();
  });

  it("Email/query and Email/get stay in the grant", async () => {
    const { userId, apiKey } = await seed();
    const { responses } = await jmap(apiKey, [
      [
        "Email/query",
        {
          accountId: acct(userId),
          filter: { inMailbox: sys(FIRST, "inbox") },
        },
        "q",
      ],
      [
        "Email/get",
        {
          accountId: acct(userId),
          ids: [...FIRST_IDS, rid("control-mail")],
          properties: ["id", "mailboxIds"],
        },
        "g",
      ],
    ]);
    const [, query] = responses[0];
    expect([...query.ids].sort()).toEqual([...FIRST_IDS].sort());
    expect(query.canCalculateChanges).toBe(true);
    expect(query.ids).not.toContain(rid("control-mail"));

    const [, got] = responses[1];
    expect(got.list.map((email: { id: string }) => email.id).sort()).toEqual(
      [...FIRST_IDS].sort(),
    );
    for (const email of got.list) {
      expect(email.mailboxIds).toEqual({ [sys(FIRST, "inbox")]: true });
    }
    expect(got.notFound).toEqual([rid("control-mail")]);
  });

  it("Email/changes and Email/queryChanges report new mail in inbox #150", async () => {
    const { userId, apiKey } = await seed();
    const sinceState = await currentState(apiKey, userId);
    const before = await jmap(apiKey, [
      ["Email/query", { accountId: acct(userId), filter: {} }, "q"],
    ]);
    const queryState = before.responses[0][1].queryState as string;
    expect(before.responses[0][1].ids).not.toContain(rid("control-mail"));

    // Newest, and last by id among equal timestamps: index 0.
    await createTestEmail({
      id: "zz-last-new",
      personId: "big-person",
      recipient: LAST,
      messageId: "zz-last-new@example.com",
      conversationId: "conv-zz-last-new",
    });
    const { responses } = await jmap(apiKey, [
      ["Email/changes", { accountId: acct(userId), sinceState }, "c"],
      [
        "Email/queryChanges",
        { accountId: acct(userId), filter: {}, sinceQueryState: queryState },
        "qc",
      ],
    ]);
    expect(responses[0][0]).toBe("Email/changes");
    expect(responses[0][1].created).toEqual([rid("zz-last-new")]);
    expect(responses[1][0]).toBe("Email/queryChanges");
    expect(responses[1][1].added).toEqual([
      { id: rid("zz-last-new"), index: 0 },
    ]);
  });

  it("Mailbox/get counts only the mailboxes it returns; ids null is requestTooLarge before any count", async () => {
    const { userId, apiKey } = await seed();
    const six = (
      ["inbox", "drafts", "sent", "archive", "junk", "trash"] as const
    ).map((role) => sys(FIRST, role));
    const { responses, statements } = await jmap(apiKey, [
      ["Mailbox/get", { accountId: acct(userId), ids: six }, "m"],
    ]);
    const [, got] = responses[0];
    expect(got.list.map((m: { id: string }) => m.id)).toEqual(six);
    expect(got.notFound).toEqual([]);
    const counts = Object.fromEntries(
      got.list.map((m: Record<string, any>) => [
        m.id,
        [m.totalEmails, m.unreadEmails, m.totalThreads, m.unreadThreads],
      ]),
    );
    expect(counts[sys(FIRST, "inbox")]).toEqual([3, 3, 3, 3]);
    for (const role of [
      "drafts",
      "sent",
      "archive",
      "junk",
      "trash",
    ] as const) {
      expect(counts[sys(FIRST, role)], role).toEqual([0, 0, 0, 0]);
    }
    // Four count statements per returned mailbox, none for the other 894.
    expect(
      statements.filter((s) => /COUNT\(/i.test(s.sql)).length,
    ).toBeLessThanOrEqual(6 * 4 * 2);

    const all = await jmap(apiKey, [
      ["Mailbox/get", { accountId: acct(userId), ids: null }, "m"],
    ]);
    expect(all.responses[0]).toEqual([
      "error",
      { type: "requestTooLarge" },
      "m",
    ]);
    expect(all.statements.filter((s) => /COUNT\(/i.test(s.sql))).toEqual([]);
  });

  it("Mailbox/query lists all 900 mailboxes without counting any", async () => {
    const { userId, apiKey } = await seed();
    const { responses, statements } = await jmap(apiKey, [
      ["Mailbox/query", { accountId: acct(userId) }, "q"],
    ]);
    const [, query] = responses[0];
    expect(query.total).toBe(900);
    expect(query.ids).toHaveLength(900);
    expect(query.ids).toContain(sys(LAST, "trash"));
    expect(query.ids).not.toContain(sys(CONTROL, "inbox"));
    expect(statements.filter((s) => /COUNT\(/i.test(s.sql))).toEqual([]);
  });

  it("Thread/changes and Thread/get see a new thread in inbox #150", async () => {
    const { userId, apiKey } = await seed();
    const sinceState = await currentState(apiKey, userId);
    await createTestEmail({
      id: "last-thread",
      personId: "big-person",
      recipient: LAST,
      messageId: "last-thread@example.com",
      conversationId: "conv-last-thread",
    });
    const threadId = thread("conv-last-thread");
    const { responses } = await jmap(apiKey, [
      ["Thread/changes", { accountId: acct(userId), sinceState }, "c"],
      ["Thread/get", { accountId: acct(userId), ids: [threadId] }, "g"],
    ]);
    expect(responses[0][0]).toBe("Thread/changes");
    expect(responses[0][1].created).toEqual([threadId]);
    expect(responses[0][1].updated).toEqual([]);
    expect(responses[1][1].list).toEqual([
      { id: threadId, emailIds: [rid("last-thread")] },
    ]);
  });

  it("Email/set create and Email/import of a reply join the original's thread in inbox #150", async () => {
    const { userId, apiKey } = await seed();
    const original = thread("conv-last-orig");
    const created = await jmap(apiKey, [
      [
        "Email/set",
        {
          accountId: acct(userId),
          create: {
            d1: {
              mailboxIds: { [sys(LAST, "drafts")]: true },
              keywords: { $draft: true },
              from: [{ email: LAST }],
              to: [{ email: "alice@example.com" }],
              subject: "Re: hello",
              inReplyTo: ["orig@example.com"],
              bodyValues: { t: { value: "Reply" } },
              textBody: [{ partId: "t", type: "text/plain" }],
            },
          },
        },
        "s",
      ],
    ]);
    expect(created.responses[0][1].notCreated).toBeNull();
    expect(created.responses[0][1].created.d1.threadId).toBe(original);

    const raw = [
      `From: ${LAST}`,
      "To: alice@example.com",
      "Subject: Re: hello",
      "Date: Tue, 29 Sep 2026 10:00:00 +0000",
      "Message-ID: <big-import@big.test>",
      "In-Reply-To: <orig@example.com>",
      "MIME-Version: 1.0",
      "Content-Type: text/plain; charset=utf-8",
      "",
      "Imported reply.",
      "",
    ].join("\r\n");
    const upload = await storeUpload(getDb(), env, {
      userId,
      accountId: acct(userId),
      contentType: "message/rfc822",
      declaredLength: new TextEncoder().encode(raw).byteLength,
      body: new Response(raw).body,
      maxBytes: 50 * 1024 * 1024,
    });
    const imported = await jmap(apiKey, [
      [
        "Email/import",
        {
          accountId: acct(userId),
          emails: {
            m1: {
              blobId: upload.blob!.blobId,
              mailboxIds: { [sys(LAST, "drafts")]: true },
              keywords: { $draft: true },
            },
          },
        },
        "i",
      ],
    ]);
    expect(imported.responses[0][1].notCreated).toBeNull();
    expect(imported.responses[0][1].created.m1.threadId).toBe(original);
  });

  it("the web message list for inbox #1 returns that inbox's messages only", async () => {
    const { apiKey } = await seed();
    const { response, statements } = await recordedFetch(
      `/api/messages?inbox=${encodeURIComponent(FIRST)}`,
      apiKey,
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      messages: { ref: string; inbox: string }[];
    };
    expect(body.messages.map((m) => m.inbox)).toEqual([FIRST, FIRST, FIRST]);
    expect(body.messages.map((m) => m.ref).sort()).toEqual(
      ["received:first-a", "received:first-b", "received:first-c"].sort(),
    );
    expectWithinD1Limit(statements);
  });

  it("the push stream serves its first state event and stays within 40 queries", async () => {
    const { apiKey } = await seed();
    const recorded = recordingD1();
    let nowMs =
      (jmapStateIssuedAt(Math.floor(Date.now() / 1000)) + 3600) * 1000;
    let done: Promise<unknown> | null = null;
    let tick = 0;
    const response = await openEventSource(
      new Request("http://localhost/jmap/eventsource/?types=*&ping=0", {
        headers: { Authorization: `Bearer ${apiKey}` },
      }),
      { ...env, DB: recorded.db } as unknown as CloudflareBindings,
      {
        now: () => nowMs,
        // A change in inbox #150 before every tick: the worst case.
        sleep: async (ms) => {
          nowMs += ms;
          tick += 1;
          await createTestEmail({
            id: `push-${tick}`,
            personId: "big-person",
            recipient: LAST,
            messageId: `push-${tick}@example.com`,
          });
        },
        waitUntil: (promise) => {
          done = promise;
        },
      },
    );
    expect(response.status).toBe(200);
    const text = await response.text();
    await done;
    const states = text
      .split("\n\n")
      .filter((block) => block.startsWith("event: state"));
    expect(states.length).toBeGreaterThan(1);
    expect(recorded.statements.length).toBeLessThanOrEqual(40);
    expectWithinD1Limit(recorded.statements);
  });
});

async function stateOf(userId: string): Promise<string> {
  const [response] = (await jmapCall(userId, [
    ["Email/get", { accountId: acct(userId), ids: [] }, "s"],
  ])) as MethodResponse[];
  return response[1].state as string;
}

describe("list sizes past the old per-statement ceilings", () => {
  beforeAll(async () => {
    await applyMigrations();
  });
  beforeEach(async () => {
    await cleanDb();
  });

  it("Thread/changes with 300 changed drafts in one thread: created within its 30-query budget", async () => {
    const { authorId: userId } = await seedAccount();
    const sinceState = await stateOf(userId);
    await insertTestContent({ id: "c-300", userId, threadKey: "t-300" });
    const now = Math.floor(Date.now() / 1000);
    const drafts = Array.from({ length: 300 }, (_, index) => ({
      id: `d300-${String(index).padStart(3, "0")}`,
      userId,
      contentId: "c-300",
      inbox: INBOX,
      receivedAt: now,
      mailboxRole: "drafts" as const,
      seen: 1,
      flagged: 0,
      createdAt: now,
      updatedAt: now,
    }));
    for (let start = 0; start < drafts.length; start += 5) {
      await getDb()
        .insert(jmapDrafts)
        .values(drafts.slice(start, start + 5));
    }

    const recorded = recordingD1();
    const [user] = await getDb()
      .select()
      .from(users)
      .where(eq(users.id, userId));
    const allowed = await resolveAllowedInboxes(getDb(), user);
    const [response] = await executeJmapCalls(
      createDb({ DB: recorded.db }),
      allowed,
      user,
      [CORE_CAPABILITY, MAIL_CAPABILITY],
      [["Thread/changes", { accountId: acct(userId), sinceState }, "c"]],
      { env: env as unknown as CloudflareBindings, createdIds: new Map() },
    );
    expect(response[0]).toBe("Thread/changes");
    expect((response[1] as Record<string, unknown>).created).toEqual([
      thread("t-300"),
    ]);
    expect(recorded.statements.length).toBeLessThanOrEqual(
      THREAD_CHANGES_QUERY_BUDGET,
    );
    expectWithinD1Limit(recorded.statements);
  });

  it("inMailboxOtherThan naming 60 custom folders finds exactly the Emails outside them", async () => {
    const { authorId: userId } = await seedAccount();
    const now = Math.floor(Date.now() / 1000);
    const folders = Array.from(
      { length: 60 },
      (_, index) => `x${String(index).padStart(2, "0")}`,
    );
    const folderRows = folders.map((id, index) => ({
      id,
      inbox: INBOX,
      name: `Folder ${id}`,
      role: null,
      parentId: null,
      sortOrder: 10 + index,
      createdBy: userId,
      createdAt: now,
      updatedAt: now,
    }));
    for (let start = 0; start < folderRows.length; start += 5) {
      await getDb()
        .insert(mailboxes)
        .values(folderRows.slice(start, start + 5));
    }
    await createTestPerson({ id: "fold-person", email: "fold@example.com" });
    const received = Array.from({ length: 10 }, (_, index) => `fr-${index}`);
    for (const id of received) {
      await createTestEmail({
        id,
        personId: "fold-person",
        recipient: INBOX,
        messageId: `${id}@example.com`,
      });
    }
    await createTestSentEmail({ id: "fs-filed", fromAddress: INBOX });
    await createTestSentEmail({ id: "fs-free", fromAddress: INBOX });
    // Received fr-0..fr-5 and one sent row filed in named folders; f1 (not
    // named) holds fr-9, which stays in the result.
    const filings: [string, string, string][] = [
      ...received
        .slice(0, 6)
        .map((id, index): [string, string, string] => [
          "received",
          id,
          folders[index * 10],
        ]),
      ["sent", "fs-filed", folders[59]],
      ["received", "fr-9", "f1"],
    ];
    for (const [messageKind, messageId, mailboxId] of filings) {
      await getDb()
        .insert(messageMailboxes)
        .values({ messageKind, messageId, mailboxId, addedAt: now });
    }
    await insertTestContent({ id: "c-filed", userId });
    await insertTestContent({ id: "c-free", userId });
    await insertTestDraft({ id: "dr-filed", userId, contentId: "c-filed" });
    await insertTestDraft({ id: "dr-free", userId, contentId: "c-free" });
    await getDb()
      .update(jmapDrafts)
      .set({ folderIds: JSON.stringify([folders[33]]) })
      .where(eq(jmapDrafts.id, "dr-filed"));

    const recorded = recordingD1();
    const [user] = await getDb()
      .select()
      .from(users)
      .where(eq(users.id, userId));
    const allowed = await resolveAllowedInboxes(getDb(), user);
    const [response] = await executeJmapCalls(
      createDb({ DB: recorded.db }),
      allowed,
      user,
      [CORE_CAPABILITY, MAIL_CAPABILITY],
      [
        [
          "Email/query",
          {
            accountId: acct(userId),
            filter: { inMailboxOtherThan: folders.map(mbx) },
          },
          "q",
        ],
      ],
      { env: env as unknown as CloudflareBindings, createdIds: new Map() },
    );
    expect(response[0]).toBe("Email/query");
    const ids = (response[1] as { ids: string[] }).ids;
    expect([...ids].sort()).toEqual(
      [
        rid("fr-6"),
        rid("fr-7"),
        rid("fr-8"),
        rid("fr-9"),
        sid("fs-free"),
        drf("dr-free"),
      ].sort(),
    );
    expectWithinD1Limit(recorded.statements);
  });
});
