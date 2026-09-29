import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { users } from "../db/auth.schema";
import { createDb } from "../db/client";
import { emails } from "../db/emails.schema";
import { mailboxes } from "../db/mailboxes.schema";
import { messageMailboxes } from "../db/message-mailboxes.schema";
import { senderIdentities } from "../db/sender-identities.schema";
import { CORE_CAPABILITY, MAIL_CAPABILITY } from "../jmap/constants";
import { executeJmapCalls } from "../jmap/http";
import { formatJmapState, parseJmapState } from "../jmap/state";
import { THREAD_CHANGES_QUERY_BUDGET } from "../jmap/thread-changes";
import { resolveAllowedInboxes } from "../lib/inbox-permissions";
import {
  applyMigrations,
  authFetch,
  cleanDb,
  createTestEmail,
  createTestPerson,
  createTestUser,
  getDb,
} from "./helpers";
import { acct, mbx, rid, sys } from "./jmap-ids";

const MINE = "mine@saasmail.test";

async function addIdentity(email: string) {
  const now = Math.floor(Date.now() / 1000);
  await getDb()
    .insert(senderIdentities)
    .values({ email, displayName: "Inbox", createdAt: now, updatedAt: now });
}

type MethodResponse = [string, Record<string, any>, string];

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

async function call(apiKey: string, name: string, args: unknown) {
  return (await jmapJson(apiKey, [[name, args, "c"]]))[0];
}

let counter = 0;
async function received(
  opts: { id?: string; conversationId?: string; subject?: string } = {},
) {
  counter += 1;
  const id = opts.id ?? `qc-${String(counter).padStart(3, "0")}`;
  await createTestEmail({
    id,
    personId: "qc-person",
    recipient: MINE,
    subject: opts.subject ?? `Subject ${id}`,
    messageId: `${id}@example.com`,
    conversationId: opts.conversationId ?? `conv-${id}`,
  });
  return rid(id);
}

/** RFC 8620 §5.6: drop `removed`, then splice `added` in index order. */
function applyQueryChanges(
  cached: string[],
  changes: { removed: string[]; added: { id: string; index: number }[] },
): string[] {
  const removed = new Set(changes.removed);
  const list = cached.filter((id) => !removed.has(id));
  for (const { id, index } of [...changes.added].sort(
    (left, right) => left.index - right.index,
  )) {
    list.splice(index, 0, id);
  }
  return list;
}

/**
 * A D1 binding that runs `hook` once, right before (or right after) the first
 * statement whose SQL matches `pattern` executes.
 */
function hookedD1(
  pattern: RegExp,
  hook: () => Promise<void>,
  when: "before" | "after" = "before",
): D1Database {
  const real = env.DB;
  let fired = false;
  const wrap = (statement: any): any =>
    new Proxy(statement, {
      get(target, prop) {
        const value = target[prop];
        if (prop === "bind") {
          return (...args: unknown[]) => wrap(value.apply(target, args));
        }
        if (["all", "raw", "first", "run"].includes(prop as string)) {
          return async (...args: unknown[]) => {
            const first = !fired;
            fired = true;
            if (first && when === "before") await hook();
            const result = await value.apply(target, args);
            if (first && when === "after") await hook();
            return result;
          };
        }
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  return new Proxy(real, {
    get(target, prop) {
      if (prop === "prepare") {
        return (query: string) => {
          const statement = target.prepare(query);
          return !fired && pattern.test(query) ? wrap(statement) : statement;
        };
      }
      const value = (target as any)[prop];
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

describe("JMAP Email/queryChanges", () => {
  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDb();
    await createTestPerson({ id: "qc-person", email: "qc@example.com" });
    await addIdentity(MINE);
  });

  const inbox = () => ({ inMailbox: sys(MINE, "inbox") });

  it("adds a new Inbox Email at index 0 and does not remove it", async () => {
    const { userId, apiKey } = await createTestUser({ id: "qc-new" });
    const first = await received();
    const [, query] = await call(apiKey, "Email/query", {
      accountId: acct(userId),
      filter: inbox(),
    });
    expect(query.ids).toEqual([first]);
    expect(query.canCalculateChanges).toBe(true);

    const second = await received();
    const [name, changes] = await call(apiKey, "Email/queryChanges", {
      accountId: acct(userId),
      filter: inbox(),
      sinceQueryState: query.queryState,
      calculateTotal: true,
    });
    expect(name).toBe("Email/queryChanges");
    expect(changes).toEqual({
      accountId: acct(userId),
      oldQueryState: query.queryState,
      newQueryState: expect.any(String),
      total: 2,
      removed: [],
      added: [{ id: second, index: 0 }],
    });
    const [, get] = await call(apiKey, "Email/get", {
      accountId: acct(userId),
      ids: [],
    });
    expect(changes.newQueryState).toBe(get.state);
  });

  it("removes an Email marked seen from a notKeyword $seen query", async () => {
    const { userId, apiKey } = await createTestUser({ id: "qc-seen" });
    const older = await received();
    const newer = await received();
    const filter = { ...inbox(), notKeyword: "$seen" };
    const [, query] = await call(apiKey, "Email/query", {
      accountId: acct(userId),
      filter,
    });
    expect(query.ids).toEqual([newer, older]);

    const [setName] = await call(apiKey, "Email/set", {
      accountId: acct(userId),
      update: { [older]: { "keywords/$seen": true } },
    });
    expect(setName).toBe("Email/set");

    const [, changes] = await call(apiKey, "Email/queryChanges", {
      accountId: acct(userId),
      filter,
      sinceQueryState: query.queryState,
    });
    expect(changes.removed).toEqual([older]);
    expect(changes.added).toEqual([]);
  });

  it("reconciles a cached Email/query list into exactly the new one", async () => {
    const { userId, apiKey } = await createTestUser({ id: "qc-reconcile" });
    for (let index = 1; index <= 6; index += 1) {
      await received({ id: `rc-${index}` });
    }
    const filter = { ...inbox(), notKeyword: "$seen" };
    const [, before] = await call(apiKey, "Email/query", {
      accountId: acct(userId),
      filter,
    });
    expect(before.ids).toHaveLength(6);

    // New mail, a read one, a trashed one, a deleted one, an edited one.
    await received({ id: "rc-7" });
    await received({ id: "rc-8" });
    const [, set] = await call(apiKey, "Email/set", {
      accountId: acct(userId),
      update: {
        [rid("rc-2")]: { "keywords/$seen": true },
        [rid("rc-3")]: { mailboxIds: { [sys(MINE, "trash")]: true } },
      },
    });
    expect(Object.keys(set.updated ?? {})).toHaveLength(2);
    await getDb().delete(emails).where(eq(emails.id, "rc-4"));
    await getDb()
      .update(emails)
      .set({ subject: "edited" })
      .where(eq(emails.id, "rc-5"));

    const [, changes] = await call(apiKey, "Email/queryChanges", {
      accountId: acct(userId),
      filter,
      sinceQueryState: before.queryState,
    });
    const [, after] = await call(apiKey, "Email/query", {
      accountId: acct(userId),
      filter,
    });
    expect(after.ids).not.toEqual(before.ids);
    expect(applyQueryChanges(before.ids, changes as any)).toEqual(after.ids);
    expect(changes.newQueryState).toBe(after.queryState);
  });

  it("answers tooManyChanges one below removed + added and succeeds at the sum", async () => {
    const { userId, apiKey } = await createTestUser({ id: "qc-max" });
    const existing = await received();
    await received();
    const [, query] = await call(apiKey, "Email/query", {
      accountId: acct(userId),
      filter: inbox(),
    });
    await received();
    await call(apiKey, "Email/set", {
      accountId: acct(userId),
      update: { [existing]: { "keywords/$flagged": true } },
    });

    const args = {
      accountId: acct(userId),
      filter: inbox(),
      sinceQueryState: query.queryState,
    };
    const [, full] = await call(apiKey, "Email/queryChanges", args);
    const sum = full.removed.length + full.added.length;
    expect(full.removed).toEqual([existing]);
    expect(sum).toBe(3);

    expect(
      await call(apiKey, "Email/queryChanges", {
        ...args,
        maxChanges: sum - 1,
      }),
    ).toEqual(["error", { type: "tooManyChanges" }, "c"]);
    const [name, exact] = await call(apiKey, "Email/queryChanges", {
      ...args,
      maxChanges: sum,
    });
    expect(name).toBe("Email/queryChanges");
    expect(exact).toEqual(full);
  });

  it("answers cannotCalculateChanges for a bad, foreign or too old state", async () => {
    const { userId, apiKey } = await createTestUser({ id: "qc-states" });
    const other = await createTestUser({
      id: "qc-other",
      email: "other@example.com",
    });
    await received();
    const [, mine] = await call(apiKey, "Email/query", {
      accountId: acct(userId),
      filter: inbox(),
    });
    const [, theirs] = await call(other.apiKey, "Email/query", {
      accountId: acct(other.userId),
      filter: inbox(),
    });
    const parsed = parseJmapState(mine.queryState)!;
    const tooOld = formatJmapState(
      parsed.seq,
      parsed.issuedAt - 40 * 24 * 60 * 60,
      parsed.fp,
    );

    for (const sinceQueryState of [
      "not-a-state",
      undefined,
      theirs.queryState,
      tooOld,
    ]) {
      expect(
        await call(apiKey, "Email/queryChanges", {
          accountId: acct(userId),
          filter: inbox(),
          sinceQueryState,
        }),
      ).toEqual(["error", { type: "cannotCalculateChanges" }, "c"]);
    }
  });

  it("validates filter, sort and collapseThreads exactly like Email/query", async () => {
    const { userId, apiKey } = await createTestUser({ id: "qc-validate" });
    const [, query] = await call(apiKey, "Email/query", {
      accountId: acct(userId),
    });
    const cases: Record<string, unknown>[] = [
      { collapseThreads: true },
      { calculateTotal: "yes" },
      { sort: [{ property: "receivedAt", isAscending: true }] },
      { sort: [{ property: "subject" }] },
      { filter: { unknownProperty: "x" } },
      { filter: { subject: 7 } },
      { filter: { inMailboxOtherThan: "not-a-list" } },
      { filter: { subject: "a", body: "b" } },
      {
        filter: {
          operator: "OR",
          conditions: [{ from: "a@example.com" }, { from: "b@example.com" }],
        },
      },
      { filter: { hasKeyword: "$custom" } },
      { filter: { after: "yesterday" } },
    ];
    for (const extra of cases) {
      const base = { accountId: acct(userId), ...extra };
      const fromQuery = await call(apiKey, "Email/query", base);
      const fromChanges = await call(apiKey, "Email/queryChanges", {
        ...base,
        sinceQueryState: query.queryState,
      });
      expect(fromQuery[0], JSON.stringify(extra)).toBe("error");
      expect(fromChanges, JSON.stringify(extra)).toEqual(fromQuery);
    }
  });

  it("reads the state first: a write landing before the results read is reported by the next call", async () => {
    const { userId, apiKey } = await createTestUser({ id: "qc-order" });
    await received();
    const [, query] = await call(apiKey, "Email/query", {
      accountId: acct(userId),
      filter: inbox(),
    });

    let injected = "";
    const hooked = hookedD1(
      /SELECT kind, id, occurred_at, jmap_email_id FROM/,
      async () => {
        injected = await received();
      },
    );
    const db = createDb({ DB: hooked });
    const [user] = await getDb()
      .select()
      .from(users)
      .where(eq(users.id, userId));
    const allowed = await resolveAllowedInboxes(getDb(), user);
    const [first] = await executeJmapCalls(
      db,
      allowed,
      user,
      [CORE_CAPABILITY, MAIL_CAPABILITY],
      [
        [
          "Email/queryChanges",
          {
            accountId: acct(userId),
            filter: inbox(),
            sinceQueryState: query.queryState,
          },
          "c",
        ],
      ],
      { env: env as unknown as CloudflareBindings, createdIds: new Map() },
    );
    expect(injected).not.toBe("");
    expect(first[0]).toBe("Email/queryChanges");
    const firstChanges = first[1] as Record<string, any>;
    // The write happened after this call's state and change-log reads.
    expect(firstChanges.added).toEqual([]);

    const [, next] = await call(apiKey, "Email/queryChanges", {
      accountId: acct(userId),
      filter: inbox(),
      sinceQueryState: firstChanges.newQueryState,
    });
    expect(next.added).toEqual([{ id: injected, index: 0 }]);
  });

  /**
   * A mailbox, and mail filed in it, appearing right after the call resolved
   * its filter's mailboxes: the state it returns must predate that write.
   */
  async function lateMailboxWrite() {
    const now = Math.floor(Date.now() / 1000);
    await getDb().insert(mailboxes).values({
      id: "box-late",
      inbox: MINE,
      name: "Late",
      createdAt: now,
      updatedAt: now,
    });
    const id = await received({ id: "late-1" });
    await getDb().insert(messageMailboxes).values({
      messageKind: "received",
      messageId: "late-1",
      mailboxId: "box-late",
      addedAt: now,
    });
    return id;
  }

  async function runHooked(userId: string, hooked: D1Database, call: unknown) {
    const [user] = await getDb()
      .select()
      .from(users)
      .where(eq(users.id, userId));
    const allowed = await resolveAllowedInboxes(getDb(), user);
    const [response] = await executeJmapCalls(
      createDb({ DB: hooked }),
      allowed,
      user,
      [CORE_CAPABILITY, MAIL_CAPABILITY],
      [call as [string, Record<string, unknown>, string]],
      { env: env as unknown as CloudflareBindings, createdIds: new Map() },
    );
    return response as [string, Record<string, any>, string];
  }

  it("Email/queryChanges reads the state before resolving mailboxes: a mailbox and its mail created in between come in the next call", async () => {
    const { userId, apiKey } = await createTestUser({ id: "qc-late-box" });
    const filter = { inMailbox: mbx("box-late") };
    const [, query] = await call(apiKey, "Email/query", {
      accountId: acct(userId),
      filter,
    });
    expect(query.ids).toEqual([]);

    let late = "";
    const [name, first] = await runHooked(
      userId,
      hookedD1(
        /from "mailboxes"/,
        async () => {
          late = await lateMailboxWrite();
        },
        "after",
      ),
      [
        "Email/queryChanges",
        { accountId: acct(userId), filter, sinceQueryState: query.queryState },
        "c",
      ],
    );
    expect(late).not.toBe("");
    expect(name).toBe("Email/queryChanges");
    expect(first.added).toEqual([]);

    const [, next] = await call(apiKey, "Email/queryChanges", {
      accountId: acct(userId),
      filter,
      sinceQueryState: first.newQueryState,
    });
    expect(next.added).toEqual([{ id: late, index: 0 }]);
  });

  it("Email/query reads its queryState before resolving mailboxes, so the next queryChanges reports what landed in between", async () => {
    const { userId, apiKey } = await createTestUser({ id: "q-late-box" });
    const filter = { inMailbox: mbx("box-late") };
    let late = "";
    const [name, query] = await runHooked(
      userId,
      hookedD1(
        /from "mailboxes"/,
        async () => {
          late = await lateMailboxWrite();
        },
        "after",
      ),
      ["Email/query", { accountId: acct(userId), filter }, "q"],
    );
    expect(late).not.toBe("");
    expect(name).toBe("Email/query");
    expect(query.ids).toEqual([]);

    const [, next] = await call(apiKey, "Email/queryChanges", {
      accountId: acct(userId),
      filter,
      sinceQueryState: query.queryState,
    });
    expect(next.added).toEqual([{ id: late, index: 0 }]);
  });
});

describe("JMAP Thread/changes", () => {
  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDb();
    await createTestPerson({ id: "qc-person", email: "qc@example.com" });
    await addIdentity(MINE);
  });

  async function state(apiKey: string, userId: string) {
    const [, get] = await call(apiKey, "Thread/get", {
      accountId: acct(userId),
      ids: [],
    });
    return get.state as string;
  }

  async function threadOf(apiKey: string, userId: string, emailId: string) {
    const [, get] = await call(apiKey, "Email/get", {
      accountId: acct(userId),
      ids: [emailId],
      properties: ["threadId"],
    });
    return get.list[0].threadId as string;
  }

  it("reports a new Email in a new thread as a created thread", async () => {
    const { userId, apiKey } = await createTestUser({ id: "tc-created" });
    await received({ conversationId: "conv-old" });
    const sinceState = await state(apiKey, userId);
    const fresh = await received({ conversationId: "conv-new" });

    const [name, changes] = await call(apiKey, "Thread/changes", {
      accountId: acct(userId),
      sinceState,
    });
    expect(name).toBe("Thread/changes");
    expect(changes).toEqual({
      accountId: acct(userId),
      oldState: sinceState,
      newState: await state(apiKey, userId),
      hasMoreChanges: false,
      created: [await threadOf(apiKey, userId, fresh)],
      updated: [],
      destroyed: [],
    });
  });

  it("reports a reply joining an existing thread as an updated thread", async () => {
    const { userId, apiKey } = await createTestUser({ id: "tc-updated" });
    const original = await received({ conversationId: "conv-shared" });
    const sinceState = await state(apiKey, userId);
    const reply = await received({ conversationId: "conv-shared" });
    const threadId = await threadOf(apiKey, userId, original);
    expect(await threadOf(apiKey, userId, reply)).toBe(threadId);

    const [, changes] = await call(apiKey, "Thread/changes", {
      accountId: acct(userId),
      sinceState,
    });
    expect(changes.created).toEqual([]);
    expect(changes.updated).toEqual([threadId]);
    expect(changes.destroyed).toEqual([]);
  });

  it("succeeds with a destroyed thread in no array (the change log keeps no thread key)", async () => {
    const { userId, apiKey } = await createTestUser({ id: "tc-destroyed" });
    const only = await received({ id: "tc-only", conversationId: "conv-gone" });
    const threadId = await threadOf(apiKey, userId, only);
    const sinceState = await state(apiKey, userId);
    await getDb().delete(emails).where(eq(emails.id, "tc-only"));

    const [name, changes] = await call(apiKey, "Thread/changes", {
      accountId: acct(userId),
      sinceState,
    });
    expect(name).toBe("Thread/changes");
    expect(changes).toMatchObject({
      created: [],
      updated: [],
      destroyed: [],
    });
    expect(JSON.stringify(changes)).not.toContain(threadId);
  });

  it("answers cannotCalculateChanges for a bad state", async () => {
    const { userId, apiKey } = await createTestUser({ id: "tc-bad" });
    expect(
      await call(apiKey, "Thread/changes", {
        accountId: acct(userId),
        sinceState: "j4-nope",
      }),
    ).toEqual(["error", { type: "cannotCalculateChanges" }, "c"]);
  });

  async function countedThreadChanges(userId: string, sinceState: string) {
    let count = 0;
    const counted = new Proxy(env.DB, {
      get(target, prop) {
        const value = (target as any)[prop];
        if (typeof value !== "function") return value;
        if (prop === "prepare" || prop === "exec") {
          return (...args: unknown[]) => {
            count += 1;
            return value.apply(target, args);
          };
        }
        return value.bind(target);
      },
    });
    const [user] = await getDb()
      .select()
      .from(users)
      .where(eq(users.id, userId));
    const allowed = await resolveAllowedInboxes(getDb(), user);
    const [response] = await executeJmapCalls(
      createDb({ DB: counted }),
      allowed,
      user,
      [CORE_CAPABILITY, MAIL_CAPABILITY],
      [["Thread/changes", { accountId: acct(userId), sinceState }, "c"]],
      { env: env as unknown as CloudflareBindings, createdIds: new Map() },
    );
    return { response, count };
  }

  it("600 new Emails in one thread: one created thread within the 30-query budget", async () => {
    const { userId, apiKey } = await createTestUser({ id: "tc-bulk" });
    const sinceState = await state(apiKey, userId);
    const now = Math.floor(Date.now() / 1000);
    const rows = Array.from({ length: 600 }, (_, index) => ({
      id: `bulk-${String(index).padStart(3, "0")}`,
      personId: "qc-person",
      recipient: MINE,
      subject: "Bulk",
      bodyText: "bulk",
      messageId: `bulk-${index}@example.com`,
      conversationId: "conv-bulk",
      receivedAt: now,
      createdAt: now,
    }));
    for (let start = 0; start < rows.length; start += 10) {
      await getDb()
        .insert(emails)
        .values(rows.slice(start, start + 10));
    }

    const { response, count } = await countedThreadChanges(userId, sinceState);
    expect(response[0]).toBe("Thread/changes");
    expect(count).toBeLessThanOrEqual(THREAD_CHANGES_QUERY_BUDGET);
    const threadId = await threadOf(apiKey, userId, rid("bulk-000"));
    expect(response[1]).toMatchObject({
      created: [threadId],
      updated: [],
      destroyed: [],
    });
  });

  it("answers cannotCalculateChanges rather than exceed the query budget", async () => {
    const { userId, apiKey } = await createTestUser({ id: "tc-over" });
    const sinceState = await state(apiKey, userId);
    const now = Math.floor(Date.now() / 1000);
    // 2,800 changed Emails in 2,800 threads need more than 30 lookups
    // (maxChanges allows only 256 threads anyway, but the ids come first).
    const rows = Array.from({ length: 2800 }, (_, index) => ({
      id: `many-${String(index).padStart(4, "0")}`,
      personId: "qc-person",
      recipient: MINE,
      subject: "Many",
      bodyText: "many",
      messageId: `many-${index}@example.com`,
      conversationId: `conv-many-${index}`,
      receivedAt: now,
      createdAt: now,
    }));
    for (let start = 0; start < rows.length; start += 10) {
      await getDb()
        .insert(emails)
        .values(rows.slice(start, start + 10));
    }

    const { response, count } = await countedThreadChanges(userId, sinceState);
    expect(response).toEqual([
      "error",
      { type: "cannotCalculateChanges" },
      "c",
    ]);
    expect(count).toBeLessThanOrEqual(THREAD_CHANGES_QUERY_BUDGET);
  }, 60_000);
});
