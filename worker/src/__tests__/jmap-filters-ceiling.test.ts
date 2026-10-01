// What Email/query actually answers for the filter shapes real clients send
// (aerc's AND trees, a substring inside a word across every kind of message,
// inMailboxOtherThan), and the RFC 8620 §5.5 page ceiling — over HTTP and
// against emailQuery() directly with a small ceiling.
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  applyMigrations,
  authFetch,
  cleanDb,
  createTestEmail,
  createTestPerson,
  createTestSentEmail,
  createTestUser,
  getDb,
} from "./helpers";
import { users } from "../db/auth.schema";
import { emails } from "../db/emails.schema";
import { senderIdentities } from "../db/sender-identities.schema";
import {
  resolveAllowedInboxes,
  type AllowedInboxes,
} from "../lib/inbox-permissions";
import { setMailboxState } from "../lib/messages/state";
import {
  CORE_CAPABILITY,
  MAIL_CAPABILITY,
  MAX_QUERY_RESULTS,
} from "../jmap/constants";
import { emailQuery, emailQueryChanges } from "../jmap/emails";
import { acct, rid, sid, sys } from "./jmap-ids";
import { MINE, createDraft, recordingSender } from "./jmap-harness";

const THEIRS = "theirs@saasmail.test";
const PERSON = "filters-person";
/** D1 caps the bound parameters of one statement, so keep a chunk small. */
const INSERT_ROWS = 10;

type MethodResponse = [string, Record<string, any>, string];

async function addIdentity(email: string, displayName = "Inbox") {
  const now = Math.floor(Date.now() / 1000);
  await getDb()
    .insert(senderIdentities)
    .values({ email, displayName, createdAt: now, updatedAt: now });
}

async function jmapJson(apiKey: string, methodCalls: unknown[]) {
  const response = await authFetch("/jmap/api", {
    method: "POST",
    apiKey,
    body: JSON.stringify({
      using: [CORE_CAPABILITY, MAIL_CAPABILITY],
      methodCalls,
    }),
  });
  expect(response.status).toBe(200);
  return ((await response.json()) as { methodResponses: MethodResponse[] })
    .methodResponses;
}

/** One Email/query over HTTP: its [name, result, callId] response. */
async function emailQueryOverHttp(
  apiKey: string,
  userId: string,
  args: Record<string, unknown>,
  callId = "q",
): Promise<MethodResponse> {
  const responses = await jmapJson(apiKey, [
    ["Email/query", { accountId: acct(userId), ...args }, callId],
  ]);
  return responses[0];
}

async function allowedFor(userId: string): Promise<AllowedInboxes> {
  const db = getDb();
  const [user] = await db.select().from(users).where(eq(users.id, userId));
  return resolveAllowedInboxes(db, user);
}

/** A method error or a query result, as loose data for assertions. */
function loose(value: unknown): Record<string, any> {
  return value as Record<string, any>;
}

type Seed = { id: string; receivedAt: number };

/**
 * Received mail in bulk, at the times asked for so the newest-first order is
 * known. Each row binds 8 columns, well inside the per-statement cap.
 */
async function insertReceived(inbox: string, seeds: Seed[]) {
  const db = getDb();
  for (let start = 0; start < seeds.length; start += INSERT_ROWS) {
    await db.insert(emails).values(
      seeds.slice(start, start + INSERT_ROWS).map((seed) => ({
        id: seed.id,
        personId: PERSON,
        recipient: inbox,
        subject: `Bulk ${seed.id}`,
        bodyText: "bulk body",
        messageId: `${seed.id}@example.com`,
        receivedAt: seed.receivedAt,
        createdAt: seed.receivedAt,
      })),
    );
  }
}

/** Every seed's id, newest first, as Email/query orders them. */
function newestFirst(seeds: Seed[]) {
  return [...seeds].reverse().map((seed) => rid(seed.id));
}

describe("JMAP Email/query filters and the page ceiling", () => {
  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDb();
  });

  it("matches `subject` on the subject alone, not on a body that mentions it", async () => {
    const { userId, apiKey } = await createTestUser({ id: "filters-subject" });
    await addIdentity(MINE);
    await createTestPerson({ id: PERSON, email: "sender@example.com" });
    await createTestEmail({
      id: "subject-hit",
      personId: PERSON,
      recipient: MINE,
      subject: "Quarterly report",
      bodyText: "figures attached",
      messageId: "<subject-hit@example.com>",
    });
    await createTestEmail({
      id: "subject-miss",
      personId: PERSON,
      recipient: MINE,
      subject: "Other",
      bodyText: "the quarterly numbers look fine",
      messageId: "<subject-miss@example.com>",
    });

    const [name, result] = await emailQueryOverHttp(apiKey, userId, {
      filter: { subject: "quarterly" },
    });

    expect(name).toBe("Email/query");
    expect([...result.ids].sort()).toEqual([rid("subject-hit")]);
  });

  it("matches a `body` substring inside a word, in received, sent and draft mail alike", async () => {
    const { userId, apiKey } = await createTestUser({ id: "filters-body" });
    await addIdentity(MINE);
    await createTestPerson({ id: PERSON, email: "sender@example.com" });
    await createTestEmail({
      id: "body-received",
      personId: PERSON,
      recipient: MINE,
      subject: "Groceries",
      bodyText: "I like xbananasx a lot",
      messageId: "<body-received@example.com>",
    });
    await createTestSentEmail({
      id: "body-sent",
      fromAddress: MINE,
      toAddress: "sender@example.com",
      subject: "Re: Groceries",
      bodyText: "sent xbananasx",
    });
    const { sender } = recordingSender();
    const hit = await createDraft(userId, sender, {
      bodyValues: { t: { value: "draft xbananasx" }, h: { value: "<p>x</p>" } },
    });
    // The text is "plain words"; only the body part's id says "bananas".
    const partIdOnly = await createDraft(userId, sender, {
      bodyValues: { bananas: { value: "plain words" } },
      textBody: [{ partId: "bananas", type: "text/plain" }],
      htmlBody: [],
    });
    await createTestEmail({
      id: "body-subject-only",
      personId: PERSON,
      recipient: MINE,
      subject: "bananas",
      bodyText: "nothing to see here",
      messageId: "<body-subject-only@example.com>",
    });

    const [name, result] = await emailQueryOverHttp(apiKey, userId, {
      filter: { body: "bananas" },
    });

    expect(name).toBe("Email/query");
    expect([...result.ids].sort()).toEqual(
      [rid("body-received"), sid("body-sent"), hit.id].sort(),
    );
    expect(result.ids).not.toContain(partIdOnly.id);
    expect(result.ids).not.toContain(rid("body-subject-only"));
  });

  it("`inMailboxOtherThan` excludes each named mailbox's own inbox and ignores ids that name none", async () => {
    const { userId, apiKey } = await createTestUser({
      id: "filters-other-than",
    });
    await addIdentity(MINE);
    await addIdentity(THEIRS);
    await createTestPerson({ id: PERSON, email: "sender@example.com" });
    const allowed = await allowedFor(userId);

    for (const [inbox, tag] of [
      [MINE, "mine"],
      [THEIRS, "theirs"],
    ] as const) {
      for (const state of ["plain", "spam", "trash"]) {
        await createTestEmail({
          id: `${state}-${tag}`,
          personId: PERSON,
          recipient: inbox,
          subject: `${state} in ${tag}`,
          bodyText: state,
          messageId: `<${state}-${tag}@example.com>`,
        });
      }
      await setMailboxState(
        getDb(),
        allowed,
        userId,
        [{ kind: "received", id: `spam-${tag}` }],
        { spam: true },
      );
      await setMailboxState(
        getDb(),
        allowed,
        userId,
        [{ kind: "received", id: `trash-${tag}` }],
        { trashed: true },
      );
    }

    const [name, result] = await emailQueryOverHttp(apiKey, userId, {
      filter: {
        inMailboxOtherThan: [
          sys(MINE, "junk"),
          sys(MINE, "trash"),
          "unknown-mailbox-id",
        ],
      },
    });

    expect(name).toBe("Email/query");
    expect([...result.ids].sort()).toEqual(
      [
        rid("plain-mine"),
        rid("plain-theirs"),
        rid("spam-theirs"),
        rid("trash-theirs"),
      ].sort(),
    );
  });

  it("flattens AND — including a nested one — and reads $seen the way the client means it", async () => {
    const { userId, apiKey } = await createTestUser({ id: "filters-and" });
    await addIdentity(MINE);
    await createTestPerson({ id: PERSON, email: "sender@example.com" });
    await createTestEmail({
      id: "and-seen-hello",
      personId: PERSON,
      recipient: MINE,
      subject: "Hello aerc",
      bodyText: "seen hello",
      isRead: 1,
      messageId: "<and-seen-hello@example.com>",
    });
    await createTestEmail({
      id: "and-unseen-hello",
      personId: PERSON,
      recipient: MINE,
      subject: "Hello there",
      bodyText: "unseen hello",
      isRead: 0,
      messageId: "<and-unseen-hello@example.com>",
    });
    await createTestEmail({
      id: "and-seen-other",
      personId: PERSON,
      recipient: MINE,
      subject: "Other",
      bodyText: "seen other",
      isRead: 1,
      messageId: "<and-seen-other@example.com>",
    });

    const inbox = sys(MINE, "inbox");
    const helloIds = [rid("and-unseen-hello"), rid("and-seen-hello")].sort();
    const seenIds = [rid("and-seen-hello"), rid("and-seen-other")].sort();
    const responses = await jmapJson(apiKey, [
      [
        "Email/query",
        {
          accountId: acct(userId),
          filter: { inMailbox: inbox, subject: "Hello" },
        },
        "flat",
      ],
      [
        "Email/query",
        {
          accountId: acct(userId),
          filter: {
            operator: "AND",
            conditions: [{ inMailbox: inbox, subject: "Hello" }],
          },
        },
        "one",
      ],
      [
        "Email/query",
        {
          accountId: acct(userId),
          filter: {
            operator: "AND",
            conditions: [{ inMailbox: inbox }, { hasKeyword: "$seen" }],
          },
        },
        "seen",
      ],
      [
        "Email/query",
        {
          accountId: acct(userId),
          filter: {
            operator: "AND",
            conditions: [
              { operator: "AND", conditions: [{ inMailbox: inbox }] },
              { subject: "Hello" },
            ],
          },
        },
        "nested",
      ],
    ]);

    for (const response of responses) expect(response[0]).toBe("Email/query");
    expect([...responses[0][1].ids].sort()).toEqual(helloIds);
    // One condition naming two properties is that condition, not a new shape.
    expect(responses[1][1].ids).toEqual(responses[0][1].ids);
    expect([...responses[2][1].ids].sort()).toEqual(seenIds);
    expect(responses[2][1].ids).not.toContain(rid("and-unseen-hello"));
    expect([...responses[3][1].ids].sort()).toEqual(helloIds);
  });

  it("answers unsupportedFilter for anything that is not one condition", async () => {
    const { userId, apiKey } = await createTestUser({ id: "filters-refused" });
    await addIdentity(MINE);
    const cases: Record<string, unknown>[] = [
      {
        operator: "OR",
        conditions: [{ from: "a@x.test" }, { from: "b@x.test" }],
      },
      {
        operator: "AND",
        conditions: [{ hasKeyword: "$seen" }, { hasKeyword: "$flagged" }],
      },
      { subject: "a", body: "b" },
      { operator: "NOT", conditions: [{ subject: "x" }] },
    ];

    const responses = await jmapJson(
      apiKey,
      cases.map((filter, index) => [
        "Email/query",
        { accountId: acct(userId), filter },
        `c${index}`,
      ]),
    );

    expect(responses).toEqual(
      cases.map((_, index) => [
        "error",
        { type: "unsupportedFilter" },
        `c${index}`,
      ]),
    );
  });

  it("caps an unbounded page at maxQueryResults and leaves `limit` out when the request asked for less", async () => {
    const { userId, apiKey } = await createTestUser({ id: "filters-ceiling" });
    await addIdentity(MINE);
    await createTestPerson({ id: PERSON, email: "sender@example.com" });
    const base = Math.floor(Date.now() / 1000) - 1000;
    const seeds: Seed[] = Array.from({ length: 300 }, (_, index) => ({
      id: `bulk-${String(index).padStart(3, "0")}`,
      receivedAt: base + index,
    }));
    await insertReceived(MINE, seeds);
    const filter = { inMailbox: sys(MINE, "inbox") };

    const responses = await jmapJson(apiKey, [
      ["Email/query", { accountId: acct(userId), filter }, "all"],
      ["Email/query", { accountId: acct(userId), filter, limit: 50 }, "fifty"],
      ["Email/query", { accountId: acct(userId), filter, limit: 0 }, "none"],
    ]);
    for (const response of responses) expect(response[0]).toBe("Email/query");
    const [all, fifty, none] = responses.map((response) => response[1]);

    expect([...all.ids].sort()).toEqual(
      seeds.map((seed) => rid(seed.id)).sort(),
    );
    // 300 fit under the ceiling, so the page is the whole result and the
    // response says how big a page it used.
    expect(all.limit).toBe(MAX_QUERY_RESULTS);
    expect(fifty.ids).toEqual(newestFirst(seeds).slice(0, 50));
    expect(fifty).not.toHaveProperty("limit");
    expect(none.ids).toEqual([]);
    expect(none).not.toHaveProperty("limit");
  });

  it("honours a small ceiling in emailQuery, and refuses to diff a result that does not fit it", async () => {
    const { userId } = await createTestUser({ id: "filters-direct" });
    await addIdentity(MINE);
    await createTestPerson({ id: PERSON, email: "sender@example.com" });
    const base = Math.floor(Date.now() / 1000) - 1000;
    const seeds: Seed[] = Array.from({ length: 6 }, (_, index) => ({
      id: `direct-${index + 1}`,
      receivedAt: base + index,
    }));
    await insertReceived(MINE, seeds);
    const allowed = await allowedFor(userId);
    const args = { filter: { inMailbox: sys(MINE, "inbox") } };

    const page = loose(
      await emailQuery(getDb(), allowed, userId, acct(userId), args, 5),
    );
    expect(page.ids).toEqual(newestFirst(seeds).slice(0, 5));
    expect(page.position).toBe(0);
    expect(page.limit).toBe(5);
    expect(page.canCalculateChanges).toBe(false);

    // One past the page the caller just saw is still addressable.
    const past = loose(
      await emailQuery(
        getDb(),
        allowed,
        userId,
        acct(userId),
        { ...args, position: 5 },
        5,
      ),
    );
    expect(past.ids).toEqual([rid("direct-1")]);

    expect(
      await emailQueryChanges(
        getDb(),
        allowed,
        userId,
        acct(userId),
        { ...args, sinceQueryState: page.queryState },
        5,
      ),
    ).toEqual({ type: "cannotCalculateChanges" });

    // One fewer message and the result fits one page, so it can be diffed.
    await getDb().delete(emails).where(eq(emails.id, "direct-6"));
    const fits = loose(
      await emailQuery(getDb(), allowed, userId, acct(userId), args, 5),
    );
    expect(fits.ids).toHaveLength(5);
    expect(fits.canCalculateChanges).toBe(true);

    const changes = loose(
      await emailQueryChanges(
        getDb(),
        allowed,
        userId,
        acct(userId),
        { ...args, sinceQueryState: fits.queryState },
        5,
      ),
    );
    expect(changes.oldQueryState).toBe(fits.queryState);
    expect(changes.removed).toEqual([]);
    expect(changes.added).toEqual([]);
  });
});
