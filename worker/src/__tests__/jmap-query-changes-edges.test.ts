// Email/queryChanges, Thread/changes, the new filters and the page ceiling
// against their references: a cached Email/query list patched with
// Email/queryChanges must equal the new Email/query list (RFC 8620 §5.6) after
// random mixes of received, web-sent, JMAP-sent (aliased D… ids) and draft
// changes; inMailbox / inMailboxOtherThan must agree with Email/get's
// mailboxIds; Thread/changes must name every thread Email/changes implies.
import { eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { emails } from "../db/emails.schema";
import { users } from "../db/auth.schema";
import { emailQuery } from "../jmap/emails";
import { resolveAllowedInboxes } from "../lib/inbox-permissions";
import {
  applyMigrations,
  authFetch,
  cleanDb,
  createTestPerson,
  createTestSentEmail,
  getDb,
} from "./helpers";
import { acct, idn, mbx, rid, sys } from "./jmap-ids";
import {
  INBOX,
  OK,
  draftCreate,
  jmapCall,
  recordingSender,
  seedAccount,
} from "./jmap-submission-fixtures";
import { CORE_CAPABILITY, MAIL_CAPABILITY } from "../jmap/constants";

const PERSON = "qce-person";
type Responses = [string, Record<string, any>, string][];

const box = (
  role: "inbox" | "drafts" | "sent" | "archive" | "junk" | "trash",
) => sys(INBOX, role);
const FOLDER = () => mbx("f1");
/** RFC 8621 §7.5.1's example patch: Drafts -> Sent, drop $draft. */
const FILE_INTO_SENT = () => ({
  [`mailboxIds/${box("drafts")}`]: null,
  [`mailboxIds/${box("sent")}`]: true,
  "keywords/$draft": null,
});

async function call(userId: string, name: string, args: Record<string, any>) {
  const [response] = (await jmapCall(
    userId,
    [[name, { accountId: acct(userId), ...args }, "c"]],
    { sender: recordingSender(OK).sender },
  )) as Responses;
  return response;
}

async function query(userId: string, args: Record<string, any>) {
  const [name, result] = await call(userId, "Email/query", args);
  if (name !== "Email/query") {
    throw new Error(`Email/query failed: ${JSON.stringify(result)}`);
  }
  return result;
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

/** A small deterministic PRNG, so a failing seed can be replayed. */
function mulberry32(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

let clock = Math.floor(Date.now() / 1000) - 100_000;
let serial = 0;

async function insertReceived(opts: {
  subject?: string;
  body?: string;
  conversationId?: string;
}) {
  serial += 1;
  clock += 7;
  const id = `qce-r-${String(serial).padStart(4, "0")}`;
  await getDb()
    .insert(emails)
    .values({
      id,
      personId: PERSON,
      recipient: INBOX,
      subject: opts.subject ?? `Received ${id}`,
      bodyHtml: "<p>x</p>",
      bodyText: opts.body ?? `plain text ${id}`,
      rawHeaders: "{}",
      messageId: `${id}@example.com`,
      isRead: 0,
      conversationId: opts.conversationId ?? `conv-${id}`,
      receivedAt: clock,
      createdAt: clock,
    });
  return id;
}

async function insertWebSent(body: string) {
  serial += 1;
  clock += 7;
  const id = `qce-s-${String(serial).padStart(4, "0")}`;
  await createTestSentEmail({
    id,
    fromAddress: INBOX,
    toAddress: "someone@example.com",
    subject: `Sent ${id}`,
    bodyText: body,
    sentAt: clock,
  });
  return id;
}

async function createDraft(userId: string, text: string, subject?: string) {
  const [, result] = await call(userId, "Email/set", {
    create: {
      d: draftCreate({
        subject: subject ?? `Draft ${serial}`,
        bodyValues: { t: { value: text } },
      }),
    },
  });
  serial += 1;
  const created = result.created?.d;
  if (!created)
    throw new Error(`draft create failed: ${JSON.stringify(result)}`);
  return created.id as string;
}

async function sendDraft(userId: string, draftId: string) {
  const responses = (await jmapCall(
    userId,
    [
      [
        "EmailSubmission/set",
        {
          accountId: acct(userId),
          create: { k1: { identityId: idn(INBOX), emailId: draftId } },
          onSuccessUpdateEmail: { "#k1": FILE_INTO_SENT() },
        },
        "s",
      ],
    ],
    { sender: recordingSender(OK).sender },
  )) as Responses;
  return responses;
}

const FILTERS: Record<string, Record<string, unknown>> = {
  all: {},
  inbox: { inMailbox: box("inbox") },
  sent: { inMailbox: box("sent") },
  drafts: { inMailbox: box("drafts") },
  trash: { inMailbox: box("trash") },
  folder: { inMailbox: FOLDER() },
  unreadInbox: { inMailbox: box("inbox"), notKeyword: "$seen" },
  flagged: { hasKeyword: "$flagged" },
  notJunkOrTrash: { inMailboxOtherThan: [box("junk"), box("trash")] },
  // aerc's search shape: AND[{inMailboxOtherThan}, {body}].
  bodyOutsideTrashAndFolder: {
    operator: "AND",
    conditions: [
      { inMailboxOtherThan: [box("trash"), FOLDER()] },
      { body: "kiwi" },
    ],
  },
  subject: { subject: "kiwi" },
};

describe("Email/queryChanges against Email/query (randomised)", () => {
  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDb();
    await createTestPerson({ id: PERSON, email: "qce@example.com" });
  });

  for (const seed of [11, 29, 47, 83]) {
    it(`reconciles every filter after a random mix of changes (seed ${seed})`, async () => {
      const random = mulberry32(seed);
      const pick = <T>(items: T[]): T | undefined =>
        items.length === 0
          ? undefined
          : items[Math.floor(random() * items.length)];
      const word = () => (random() < 0.4 ? "a kiwi smoothie" : "plain words");
      const { authorId: userId } = await seedAccount();

      const receivedRows: string[] = [];
      for (let index = 0; index < 5; index += 1) {
        receivedRows.push(
          await insertReceived({
            body: word(),
            subject: random() < 0.3 ? "kiwi news" : undefined,
          }),
        );
      }
      await insertWebSent(word());
      const draftIds: string[] = [];
      draftIds.push(await createDraft(userId, word()));
      draftIds.push(await createDraft(userId, word(), "kiwi draft"));

      const before: Record<string, any> = {};
      for (const [key, filter] of Object.entries(FILTERS)) {
        before[key] = await query(userId, { filter });
        expect(before[key].canCalculateChanges, key).toBe(true);
      }
      const [, threadsBefore] = await call(userId, "Thread/get", { ids: [] });

      const log: string[] = [];
      for (let step = 0; step < 14; step += 1) {
        const everything = (await query(userId, { filter: {} }))
          .ids as string[];
        const op = Math.floor(random() * 10);
        const target = pick(everything);
        if (op === 0) {
          receivedRows.push(await insertReceived({ body: word() }));
          log.push("received");
        } else if (op === 1 && target) {
          await call(userId, "Email/set", {
            update: { [target]: { "keywords/$seen": random() < 0.5 } },
          });
          log.push(`seen ${target}`);
        } else if (op === 2 && target) {
          await call(userId, "Email/set", {
            update: { [target]: { "keywords/$flagged": random() < 0.5 } },
          });
          log.push(`flag ${target}`);
        } else if (op === 3 && target) {
          // One system mailbox plus any custom folders; a target that does
          // not fit the Email's kind is refused, which is fine.
          const system = pick([
            "inbox",
            "archive",
            "junk",
            "trash",
            "sent",
            "drafts",
          ] as const)!;
          const into: Record<string, boolean> = { [box(system)]: true };
          if (random() < 0.4) into[FOLDER()] = true;
          await call(userId, "Email/set", {
            update: { [target]: { mailboxIds: into } },
          });
          log.push(`move ${target} -> ${Object.keys(into).join("+")}`);
        } else if (op === 4 && receivedRows.length > 0) {
          const row = receivedRows.splice(
            Math.floor(random() * receivedRows.length),
            1,
          )[0];
          await getDb().delete(emails).where(eq(emails.id, row));
          log.push(`delete ${row}`);
        } else if (op === 5) {
          draftIds.push(await createDraft(userId, word()));
          log.push("draft");
        } else if (op === 6 && draftIds.length > 0) {
          const draft = pick(draftIds)!;
          await call(userId, "Email/set", { destroy: [draft] });
          log.push(`destroy ${draft}`);
        } else if (op === 7 && draftIds.length > 0) {
          const draft = pick(draftIds)!;
          await sendDraft(userId, draft);
          log.push(`send ${draft}`);
        } else if (op === 8) {
          await insertWebSent(word());
          log.push("web sent");
        } else {
          // Created and destroyed inside the window: in neither array.
          const row = await insertReceived({ body: "kiwi fleeting" });
          await getDb().delete(emails).where(eq(emails.id, row));
          log.push(`fleeting ${row}`);
        }
      }

      // Always: one received row deleted, one created and destroyed inside
      // the window.
      const doomed = receivedRows.shift();
      if (doomed) {
        await getDb().delete(emails).where(eq(emails.id, doomed));
        log.push(`delete ${doomed}`);
      }
      const fleetingRow = await insertReceived({ body: "kiwi fleeting" });
      await getDb().delete(emails).where(eq(emails.id, fleetingRow));
      log.push(`fleeting ${fleetingRow}`);

      for (const [key, filter] of Object.entries(FILTERS)) {
        const context = `${key} after ${log.join("; ")}`;
        const [name, changes] = await call(userId, "Email/queryChanges", {
          filter,
          sinceQueryState: before[key].queryState,
          calculateTotal: true,
        });
        expect(name, context).toBe("Email/queryChanges");
        const after = await query(userId, { filter, calculateTotal: true });

        expect(
          applyQueryChanges(before[key].ids, changes as any),
          context,
        ).toEqual(after.ids);
        expect(changes.total, context).toBe(after.total);
        expect(changes.newQueryState, context).toBe(after.queryState);
        // Each added id sits exactly where Email/query puts it: the same id
        // form (a sent-from-draft Email keeps its D… id in both).
        for (const { id, index } of changes.added) {
          expect(after.ids[index], context).toBe(id);
        }
        for (const id of changes.removed) {
          expect(id, context).toMatch(/^[RrSsDd]/);
        }
        for (const line of log.filter((entry) =>
          entry.startsWith("fleeting"),
        )) {
          const fleeting = rid(line.split(" ")[1]);
          expect(changes.removed, context).not.toContain(fleeting);
          expect(
            changes.added.map((entry: { id: string }) => entry.id),
            context,
          ).not.toContain(fleeting);
        }
      }

      // Thread/changes names the thread of every Email Email/changes says
      // was created or updated and still exists.
      const [, emailChanges] = await call(userId, "Email/changes", {
        sinceState: threadsBefore.state,
      });
      expect(emailChanges.hasMoreChanges).toBe(false);
      const changed = [...emailChanges.created, ...emailChanges.updated];
      const [, got] = await call(userId, "Email/get", {
        ids: changed,
        properties: ["threadId"],
      });
      const expectedThreads = new Set(
        got.list.map((email: { threadId: string }) => email.threadId),
      );
      const [threadName, threads] = await call(userId, "Thread/changes", {
        sinceState: threadsBefore.state,
      });
      expect(threadName, log.join("; ")).toBe("Thread/changes");
      expect(
        new Set([...threads.created, ...threads.updated]),
        log.join("; "),
      ).toEqual(expectedThreads);
      expect(threads.destroyed).toEqual([]);
    }, 60_000);
  }
});

describe("Email/queryChanges and Thread/changes edges", () => {
  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDb();
    await createTestPerson({ id: PERSON, email: "qce@example.com" });
  });

  it("a draft sent over JMAP moves from Drafts to Sent under the same D… id in both queries' changes", async () => {
    const { authorId: userId } = await seedAccount();
    const draft = await createDraft(userId, "hello");
    expect(draft).toMatch(/^[Dd]/);
    const drafts = await query(userId, {
      filter: { inMailbox: box("drafts") },
    });
    const sent = await query(userId, { filter: { inMailbox: box("sent") } });
    expect(drafts.ids).toEqual([draft]);
    expect(sent.ids).toEqual([]);

    const responses = await sendDraft(userId, draft);
    expect(responses.map(([name]) => name)).toEqual([
      "EmailSubmission/set",
      "Email/set",
    ]);

    const [, draftChanges] = await call(userId, "Email/queryChanges", {
      filter: { inMailbox: box("drafts") },
      sinceQueryState: drafts.queryState,
    });
    expect(draftChanges.removed).toEqual([draft]);
    expect(draftChanges.added).toEqual([]);
    const [, sentChanges] = await call(userId, "Email/queryChanges", {
      filter: { inMailbox: box("sent") },
      sinceQueryState: sent.queryState,
    });
    expect(sentChanges.added).toEqual([{ id: draft, index: 0 }]);
    expect(
      (await query(userId, { filter: { inMailbox: box("sent") } })).ids,
    ).toEqual([draft]);
  });

  it("an Email re-keyed into another thread: Thread/changes succeeds and names the new thread", async () => {
    const { authorId: userId } = await seedAccount();
    const first = await insertReceived({ conversationId: "conv-a" });
    const second = await insertReceived({ conversationId: "conv-a" });
    const [, before] = await call(userId, "Email/get", {
      ids: [rid(first), rid(second)],
      properties: ["threadId"],
    });
    expect(before.list[0].threadId).toBe(before.list[1].threadId);
    const sinceState = before.state as string;

    await getDb()
      .update(emails)
      .set({ conversationId: "conv-b" })
      .where(eq(emails.id, second));
    const [, after] = await call(userId, "Email/get", {
      ids: [rid(second)],
      properties: ["threadId"],
    });
    const newThread = after.list[0].threadId as string;
    expect(newThread).not.toBe(before.list[0].threadId);

    const [name, changes] = await call(userId, "Thread/changes", {
      sinceState,
    });
    expect(name).toBe("Thread/changes");
    expect([...changes.created, ...changes.updated]).toContain(newThread);
  });

  it("Thread/changes answers cannotCalculateChanges one below the changed-thread count, and succeeds at it", async () => {
    const { authorId: userId } = await seedAccount();
    await insertReceived({});
    const [, get] = await call(userId, "Thread/get", { ids: [] });
    for (let index = 0; index < 3; index += 1) await insertReceived({});

    expect(
      await call(userId, "Thread/changes", {
        sinceState: get.state,
        maxChanges: 2,
      }),
    ).toEqual(["error", { type: "cannotCalculateChanges" }, "c"]);
    const [name, changes] = await call(userId, "Thread/changes", {
      sinceState: get.state,
      maxChanges: 3,
    });
    expect(name).toBe("Thread/changes");
    expect(changes.created).toHaveLength(3);
    expect(
      await call(userId, "Thread/changes", {
        sinceState: get.state,
        maxChanges: 0,
      }),
    ).toEqual([
      "error",
      { type: "invalidArguments", properties: ["maxChanges"] },
      "c",
    ]);
  });

  it("Email/queryChanges validates maxChanges and upToId", async () => {
    const { authorId: userId } = await seedAccount();
    const { queryState } = await query(userId, { filter: {} });
    for (const [extra, property] of [
      [{ maxChanges: 0 }, "maxChanges"],
      [{ maxChanges: -1 }, "maxChanges"],
      [{ maxChanges: 1.5 }, "maxChanges"],
      [{ maxChanges: "5" }, "maxChanges"],
      [{ upToId: 7 }, "upToId"],
    ] as const) {
      expect(
        await call(userId, "Email/queryChanges", {
          sinceQueryState: queryState,
          ...extra,
        }),
        JSON.stringify(extra),
      ).toEqual([
        "error",
        { type: "invalidArguments", properties: [property] },
        "c",
      ]);
    }
    const [name] = await call(userId, "Email/queryChanges", {
      sinceQueryState: queryState,
      upToId: "Rsomething",
      maxChanges: null,
    });
    expect(name).toBe("Email/queryChanges");
  });
});

describe("filters against Email/get and literal matching", () => {
  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDb();
    await createTestPerson({ id: PERSON, email: "qce@example.com" });
  });

  it("inMailbox and inMailboxOtherThan agree with Email/get mailboxIds for every mailbox, custom folder included", async () => {
    const { authorId: userId } = await seedAccount();
    // A mix: plain, read, flagged, archived, junk, trashed, Inbox + f1,
    // web-sent, JMAP-sent in Sent + f1, drafts in Drafts, Drafts + f1 and
    // Trash. (Received mail in Trash + f1 is left out: Email/get lists f1 for
    // it but inMailbox f1 does not, on main too.)
    const r = [];
    for (let index = 0; index < 7; index += 1)
      r.push(rid(await insertReceived({})));
    await insertWebSent("web");
    const sentDraft = await createDraft(userId, "to send");
    await sendDraft(userId, sentDraft);
    const d1 = await createDraft(userId, "stays");
    const d2 = await createDraft(userId, "filed");
    const d3 = await createDraft(userId, "binned");
    const [, set] = await call(userId, "Email/set", {
      update: {
        [r[1]]: { "keywords/$seen": true },
        [r[2]]: { mailboxIds: { [box("archive")]: true } },
        [r[3]]: { mailboxIds: { [box("junk")]: true } },
        [r[4]]: { mailboxIds: { [box("trash")]: true } },
        // One system mailbox plus any custom folders.
        [r[5]]: { mailboxIds: { [box("inbox")]: true, [FOLDER()]: true } },
        [r[6]]: { "keywords/$flagged": true },
        [sentDraft]: { mailboxIds: { [box("sent")]: true, [FOLDER()]: true } },
        [d2]: { mailboxIds: { [box("drafts")]: true, [FOLDER()]: true } },
        [d3]: { mailboxIds: { [box("trash")]: true } },
      },
    });
    expect(set.notUpdated ?? {}).toEqual({});
    expect(d1).toBeTruthy();

    const [, mailboxes] = await call(userId, "Mailbox/get", {
      ids: null,
      properties: ["id", "totalEmails", "unreadEmails"],
    });
    const mailboxIds = mailboxes.list.map((m: { id: string }) => m.id);
    expect(mailboxIds).toContain(FOLDER());

    const membership = new Map<string, string[]>();
    const all = new Set<string>();
    for (const id of mailboxIds) {
      const ids = (await query(userId, { filter: { inMailbox: id } })).ids;
      membership.set(id, ids);
      for (const emailId of ids) all.add(emailId);
    }
    const [, got] = await call(userId, "Email/get", {
      ids: [...all],
      properties: ["mailboxIds"],
    });
    const byId = new Map<string, Record<string, boolean>>(
      got.list.map((e: { id: string; mailboxIds: Record<string, boolean> }) => [
        e.id,
        e.mailboxIds,
      ]),
    );
    expect(new Set((await query(userId, { filter: {} })).ids)).toEqual(all);

    for (const mailbox of mailboxes.list as {
      id: string;
      totalEmails: number;
    }[]) {
      const inIt = [...all].filter((id) => byId.get(id)?.[mailbox.id]).sort();
      expect([...membership.get(mailbox.id)!].sort(), mailbox.id).toEqual(inIt);
      expect(mailbox.totalEmails, mailbox.id).toBe(inIt.length);
      const others = (
        await query(userId, { filter: { inMailboxOtherThan: [mailbox.id] } })
      ).ids;
      expect([...others].sort(), mailbox.id).toEqual(
        [...all].filter((id) => !byId.get(id)?.[mailbox.id]).sort(),
      );
      // Combined with inMailbox: excluding the same mailbox leaves nothing.
      expect(
        (
          await query(userId, {
            filter: { inMailbox: mailbox.id, inMailboxOtherThan: [mailbox.id] },
          })
        ).ids,
        mailbox.id,
      ).toEqual([]);
    }

    // Two at once: in Sent but not in f1; anywhere but Trash and f1.
    const sentNotFolder = (
      await query(userId, {
        filter: { inMailbox: box("sent"), inMailboxOtherThan: [FOLDER()] },
      })
    ).ids;
    expect([...sentNotFolder].sort()).toEqual(
      [...all]
        .filter(
          (id) => byId.get(id)?.[box("sent")] && !byId.get(id)?.[FOLDER()],
        )
        .sort(),
    );
    const neither = (
      await query(userId, {
        filter: { inMailboxOtherThan: [box("trash"), FOLDER()] },
      })
    ).ids;
    expect([...neither].sort()).toEqual(
      [...all]
        .filter(
          (id) => !byId.get(id)?.[box("trash")] && !byId.get(id)?.[FOLDER()],
        )
        .sort(),
    );

    // Main's counts for this mix, by hand: Inbox holds r0 r1 r5 r6 (r1
    // read); Sent the web-sent row and the JMAP-sent Email, never unread
    // (#63); Drafts d1 and d2.
    const counts = Object.fromEntries(
      mailboxes.list.map(
        (m: { id: string; totalEmails: number; unreadEmails: number }) => [
          m.id,
          [m.totalEmails, m.unreadEmails],
        ],
      ),
    );
    expect(counts[box("inbox")]).toEqual([4, 3]);
    expect(counts[box("sent")]).toEqual([2, 0]);
    expect(counts[box("archive")]).toEqual([1, 1]);
    expect(counts[box("junk")]).toEqual([1, 1]);
    expect(counts[box("drafts")][0]).toBe(2);
  });

  it("`body` treats %, _ and \\ as literal characters in received, sent and draft mail", async () => {
    const { authorId: userId } = await seedAccount();
    const cases = [
      { term: "50%", hit: "discount 50% today", miss: "discount 500 today" },
      { term: "a_b", hit: "file a_b.txt", miss: "file axb.txt" },
      { term: "C:\\tmp", hit: "path C:\\tmp here", miss: "path C:tmp here" },
    ];
    const expected: Record<string, string[]> = {};
    for (const { term, hit, miss } of cases) {
      const hits = [
        rid(await insertReceived({ body: hit })),
        (await import("./jmap-ids")).sid(await insertWebSent(hit)),
        await createDraft(userId, hit),
      ];
      await insertReceived({ body: miss });
      await insertWebSent(miss);
      await createDraft(userId, miss);
      expected[term] = hits.sort();
    }
    for (const { term } of cases) {
      const ids = (await query(userId, { filter: { body: term } })).ids;
      expect([...ids].sort(), term).toEqual(expected[term]);
    }
  });

  it("answers unsupportedFilter for text and subject together, flat or through AND", async () => {
    const { authorId: userId } = await seedAccount();
    for (const filter of [
      { text: "a", subject: "b" },
      { text: "a", body: "b" },
      { operator: "AND", conditions: [{ text: "a" }, { subject: "b" }] },
      {
        operator: "AND",
        conditions: [
          { inMailbox: box("inbox") },
          { operator: "AND", conditions: [{ body: "a" }, { subject: "b" }] },
        ],
      },
    ]) {
      expect(
        await call(userId, "Email/query", { filter }),
        JSON.stringify(filter),
      ).toEqual(["error", { type: "unsupportedFilter" }, "c"]);
    }
  });
});

describe("the page ceiling", () => {
  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDb();
    await createTestPerson({ id: PERSON, email: "qce@example.com" });
  });

  async function direct(
    userId: string,
    args: Record<string, unknown>,
    ceiling: number,
  ) {
    const db = getDb();
    const [user] = await db.select().from(users).where(eq(users.id, userId));
    const allowed = await resolveAllowedInboxes(db, user);
    return (await emailQuery(
      db,
      allowed,
      userId,
      acct(userId),
      args,
      ceiling,
    )) as Record<string, any>;
  }

  it("negative positions count from the end, and canCalculateChanges follows the total", async () => {
    const { authorId: userId } = await seedAccount();
    const ids: string[] = [];
    for (let index = 0; index < 8; index += 1)
      ids.unshift(rid(await insertReceived({})));
    const filter = { inMailbox: box("inbox") };

    const tail = await direct(userId, { filter, position: -3 }, 5);
    expect(tail.position).toBe(5);
    expect(tail.ids).toEqual(ids.slice(5));
    expect(tail.canCalculateChanges).toBe(false);

    const window = await direct(userId, { filter, position: -7, limit: 2 }, 5);
    expect(window.position).toBe(1);
    expect(window.ids).toEqual(ids.slice(1, 3));
    expect(window).not.toHaveProperty("limit");

    const beyond = await direct(userId, { filter, position: -50 }, 5);
    expect(beyond.position).toBe(0);
    expect(beyond.ids).toEqual(ids.slice(0, 5));
    expect(beyond.limit).toBe(5);

    const fits = await direct(userId, { filter, position: -3 }, 10);
    expect(fits.ids).toEqual(ids.slice(5));
    expect(fits.canCalculateChanges).toBe(true);

    // A page that starts past 0 without a total cannot know the whole fits.
    const later = await direct(userId, { filter, position: 2 }, 10);
    expect(later.ids).toEqual(ids.slice(2));
    expect(later.canCalculateChanges).toBe(false);

    const exact = await direct(userId, { filter, limit: 8 }, 8);
    expect(exact.ids).toEqual(ids);
    expect(exact).not.toHaveProperty("limit");
    expect(exact.canCalculateChanges).toBe(true);
  });

  it("over HTTP, a limit above 10,000 (or null) is answered with limit 10000; exactly 10,000 is not echoed", async () => {
    const { authorId: userId, authorApiKey: apiKey } = await seedAccount();
    await insertReceived({});
    const response = await authFetch("/jmap/api", {
      method: "POST",
      apiKey,
      body: JSON.stringify({
        using: [CORE_CAPABILITY, MAIL_CAPABILITY],
        methodCalls: [
          ["Email/query", { accountId: acct(userId), limit: 20_000 }, "big"],
          ["Email/query", { accountId: acct(userId), limit: null }, "null"],
          ["Email/query", { accountId: acct(userId), limit: 10_000 }, "exact"],
          ["Email/query", { accountId: acct(userId), limit: -1 }, "neg"],
        ],
      }),
    });
    const body = (await response.json()) as { methodResponses: Responses };
    const [big, nul, exact, neg] = body.methodResponses;
    expect(big[1].limit).toBe(10_000);
    expect(big[1].ids).toHaveLength(1);
    expect(nul[1].limit).toBe(10_000);
    expect(exact[0]).toBe("Email/query");
    expect(exact[1]).not.toHaveProperty("limit");
    expect(neg).toEqual([
      "error",
      { type: "invalidArguments", properties: ["position", "limit"] },
      "neg",
    ]);
  });
});
