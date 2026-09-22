import {
  describe,
  it,
  expect,
  beforeAll,
  beforeEach,
  vi,
  afterEach,
} from "vitest";
import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { gmailAccounts } from "../db/gmail-accounts.schema";
import { senderIdentities } from "../db/sender-identities.schema";
import { emails } from "../db/emails.schema";
import { encryptSecret } from "../lib/crypto";
import {
  syncAccount,
  syncAllGmailAccounts,
  MAX_MESSAGES_PER_RUN,
} from "../lib/gmail/sync";
import { getDb, applyMigrations, cleanDb } from "./helpers";

const KEY = "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=";
const CFG = { clientId: "cid", clientSecret: "csec", encryptionKey: KEY };

function fakeCtx(): ExecutionContext {
  const calls: Promise<unknown>[] = [];
  return {
    waitUntil: (p: Promise<unknown>) => {
      calls.push(p);
    },
    passThroughOnException: () => {},
    props: {},
  } as unknown as ExecutionContext;
}

function rawEmail(opts: {
  from: string;
  deliveredTo: string;
  messageId: string;
}) {
  return [
    `From: ${opts.from}`,
    `To: ${opts.deliveredTo}`,
    `Delivered-To: ${opts.deliveredTo}`,
    `Message-ID: ${opts.messageId}`,
    `Subject: Synced subject`,
    `Content-Type: text/plain; charset=utf-8`,
    ``,
    `body text`,
  ].join("\r\n");
}

function b64url(s: string) {
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Route stubbed fetch by URL so one stub serves token, history and messages. */
function stubGmail(opts: {
  /** Message ids, each placed in its OWN history record (ids 9001, 9002, …). */
  historyIds?: string[];
  /** Explicit history records, when a test cares about record boundaries. */
  records?: Array<{ id: string; messageIds: string[] }>;
  messages?: Record<string, { raw: string; labelIds?: string[] }>;
  historyStatus?: number;
  profileHistoryId?: string;
  /** Refresh token the token endpoint rejects, as a revoked grant would be. */
  revokedRefreshToken?: string;
  /** Return history_gone only for this cursor, leaving other accounts healthy. */
  historyGoneForStartId?: string;
  /** Records per history page; omitted means one page holds everything. */
  pageSize?: number;
  /**
   * Mailbox head per page index, for when it moves mid-pagination. Omitted
   * means every page reports the same head.
   */
  pageHistoryIds?: string[];
  /** Message ids whose fetch returns a 500, so processing them throws. */
  failMessageIds?: string[];
}) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const json = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), {
          status,
          headers: { "content-type": "application/json" },
        });

      if (url.includes("oauth2.googleapis.com/token")) {
        // Parse the form body rather than substring-matching it, so the test
        // does not break on encoding or parameter-order changes.
        const form = new URLSearchParams(String(init?.body ?? ""));
        if (
          opts.revokedRefreshToken &&
          form.get("refresh_token") === opts.revokedRefreshToken
        ) {
          return json(
            {
              error: "invalid_grant",
              error_description: "Token has been expired or revoked.",
            },
            400,
          );
        }
        return json({ access_token: "at-1", expires_in: 3599 });
      }
      if (url.includes("/users/me/profile")) {
        return json({
          emailAddress: "collector@acme.dev",
          historyId: opts.profileHistoryId ?? "99999",
        });
      }
      if (url.includes("/users/me/history")) {
        if (opts.historyStatus && opts.historyStatus !== 200) {
          return json({ error: { message: "gone" } }, opts.historyStatus);
        }
        const query = new URL(url).searchParams;
        const startId = query.get("startHistoryId");
        const pageToken = query.get("pageToken");
        if (
          opts.historyGoneForStartId &&
          startId === opts.historyGoneForStartId
        ) {
          return json({ error: { message: "gone" } }, 404);
        }
        const allRecords =
          opts.records ??
          (opts.historyIds ?? []).map((id, i) => ({
            id: String(9001 + i),
            messageIds: [id],
          }));
        // Gmail returns records strictly AFTER startHistoryId. Honouring that
        // here is what lets a test replay a truncated run and prove the
        // resume point skipped nothing.
        const from = Number(startId);
        const remaining = Number.isFinite(from)
          ? allRecords.filter((r) => Number(r.id) > from)
          : allRecords;

        // The mailbox head is by definition at or above every record it
        // contains; a page id below its own records is something Gmail could
        // never return, and fixtures that do it hide ordering bugs.
        const pageHistoryId = String(
          Math.max(
            9100,
            ...allRecords.map((r) => Number(r.id)).filter(Number.isFinite),
          ),
        );

        const size = opts.pageSize ?? Math.max(remaining.length, 1);
        const offset = pageToken ? Number(pageToken.replace("p", "")) : 0;
        const slice = remaining.slice(offset, offset + size);
        const more = offset + size < remaining.length;

        // Gmail reports the head as it stands per request, so it can move
        // between pages when mail arrives mid-pagination.
        const pageIndex = Math.floor(offset / size);
        const head =
          opts.pageHistoryIds?.[pageIndex] ??
          opts.pageHistoryIds?.[opts.pageHistoryIds.length - 1] ??
          pageHistoryId;

        return json({
          history: slice.map((r) => ({
            id: r.id,
            messagesAdded: r.messageIds.map((id) => ({ message: { id } })),
          })),
          ...(more ? { nextPageToken: `p${offset + size}` } : {}),
          historyId: head,
        });
      }
      if (url.includes("/users/me/messages/")) {
        const id = decodeURIComponent(url.split("/messages/")[1].split("?")[0]);
        if (opts.failMessageIds?.includes(id)) {
          return json({ error: { message: "boom" } }, 500);
        }
        const msg = opts.messages?.[id];
        if (!msg) return json({ error: { message: "nope" } }, 404);
        return json({
          id,
          threadId: `t-${id}`,
          labelIds: msg.labelIds ?? ["INBOX"],
          raw: b64url(msg.raw),
        });
      }
      return json({}, 200);
    }),
  );
}

async function seedAccount(
  historyId: string | null = "9000",
  opts: { id?: string; emailAddress?: string; refreshToken?: string } = {},
) {
  const now = Math.floor(Date.now() / 1000);
  await getDb()
    .insert(gmailAccounts)
    .values({
      id: opts.id ?? "acct-1",
      emailAddress: opts.emailAddress ?? "collector@acme.dev",
      refreshTokenEncrypted: await encryptSecret(
        opts.refreshToken ?? "rt-1",
        KEY,
      ),
      accessToken: null,
      expiresAt: null,
      historyId,
      connectedBy: "user-1",
      createdAt: now,
      updatedAt: now,
    });
}

async function seedInbox(
  email: string,
  gmailGroupAddress: string | null,
  gmailAccountId = "acct-1",
) {
  const now = Math.floor(Date.now() / 1000);
  await getDb().insert(senderIdentities).values({
    email,
    displayName: email,
    source: "gmail",
    gmailAccountId,
    gmailGroupAddress,
    createdAt: now,
    updatedAt: now,
  });
}

/**
 * An ordinary Cloudflare-routed inbox: no Gmail account, and — crucially — a
 * null `gmailGroupAddress`, exactly like a personal Gmail mapping.
 */
async function seedCloudflareInbox(email: string) {
  const now = Math.floor(Date.now() / 1000);
  await getDb().insert(senderIdentities).values({
    email,
    displayName: email,
    source: "cloudflare",
    gmailAccountId: null,
    gmailGroupAddress: null,
    createdAt: now,
    updatedAt: now,
  });
}

async function account() {
  const [row] = await getDb()
    .select()
    .from(gmailAccounts)
    .where(eq(gmailAccounts.id, "acct-1"));
  return row;
}

beforeAll(async () => {
  await applyMigrations();
});

beforeEach(async () => {
  await cleanDb();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("syncAccount — happy path", () => {
  it("ingests a new message onto the mapped inbox", async () => {
    await seedAccount();
    await seedInbox("support@acme.dev", null);
    stubGmail({
      historyIds: ["m1"],
      messages: {
        m1: {
          raw: rawEmail({
            from: "jane@example.com",
            deliveredTo: "support@acme.dev",
            messageId: "<g1@example.com>",
          }),
        },
      },
    });

    const res = await syncAccount(
      getDb(),
      await account(),
      env as unknown as CloudflareBindings,
      fakeCtx(),
      CFG,
    );

    expect(res.ingested).toBe(1);

    const rows = await getDb().select().from(emails);
    expect(rows).toHaveLength(1);
    expect(rows[0].recipient).toBe("support@acme.dev");
    expect(rows[0].gmailMessageId).toBe("m1");
    expect(rows[0].gmailThreadId).toBe("t-m1");
    // Nothing was left behind, so the cursor goes to the mailbox's current
    // position rather than to the last record's id.
    expect((await account()).historyId).toBe("9100");
  });

  it("advances the cursor and stamps lastSyncedAt", async () => {
    await seedAccount();
    await seedInbox("support@acme.dev", null);
    stubGmail({ historyIds: [] });

    await syncAccount(
      getDb(),
      await account(),
      env as unknown as CloudflareBindings,
      fakeCtx(),
      CFG,
    );

    const row = await account();
    expect(row.historyId).toBe("9100");
    expect(row.lastSyncedAt).toBeGreaterThan(0);
  });

  it("is idempotent — replaying the same history page inserts once", async () => {
    await seedAccount();
    await seedInbox("support@acme.dev", null);
    const opts = {
      historyIds: ["m1"],
      messages: {
        m1: {
          raw: rawEmail({
            from: "jane@example.com",
            deliveredTo: "support@acme.dev",
            messageId: "<g1@example.com>",
          }),
        },
      },
    };
    stubGmail(opts);
    await syncAccount(
      getDb(),
      await account(),
      env as unknown as CloudflareBindings,
      fakeCtx(),
      CFG,
    );
    stubGmail(opts);
    await syncAccount(
      getDb(),
      await account(),
      env as unknown as CloudflareBindings,
      fakeCtx(),
      CFG,
    );

    expect(await getDb().select().from(emails)).toHaveLength(1);
  });

  it("ignores inboxes that belong to no Gmail account", async () => {
    await seedAccount();
    await seedInbox("support@acme.dev", null);
    // A plain Cloudflare inbox also carries a null gmailGroupAddress. If the
    // mappings query were not scoped to this account, this row would look
    // like a SECOND personal mailbox; resolvePersonalInbox refuses to choose
    // between two, so it would return null and sync would silently stop for
    // every account on the instance.
    await seedCloudflareInbox("hello@acme.dev");
    // Guard against this test passing vacuously: if the decoy row were not
    // actually inserted, the scoping it exercises would never be under test.
    expect(await getDb().select().from(senderIdentities)).toHaveLength(2);
    stubGmail({
      historyIds: ["m1"],
      messages: {
        m1: {
          raw: rawEmail({
            from: "jane@example.com",
            deliveredTo: "support@acme.dev",
            messageId: "<c1@example.com>",
          }),
        },
      },
    });

    const res = await syncAccount(
      getDb(),
      await account(),
      env as unknown as CloudflareBindings,
      fakeCtx(),
      CFG,
    );

    expect(res.ingested).toBe(1);
    const rows = await getDb().select().from(emails);
    expect(rows).toHaveLength(1);
    expect(rows[0].recipient).toBe("support@acme.dev");
  });
});

describe("syncAccount — skipping", () => {
  it("skips a message carrying the SENT label", async () => {
    await seedAccount();
    await seedInbox("support@acme.dev", null);
    stubGmail({
      historyIds: ["m1"],
      messages: {
        m1: {
          labelIds: ["SENT"],
          raw: rawEmail({
            from: "collector@acme.dev",
            deliveredTo: "support@acme.dev",
            messageId: "<s1@example.com>",
          }),
        },
      },
    });

    const res = await syncAccount(
      getDb(),
      await account(),
      env as unknown as CloudflareBindings,
      fakeCtx(),
      CFG,
    );
    expect(res.ingested).toBe(0);
    expect(res.skipped).toBe(1);
    expect(await getDb().select().from(emails)).toHaveLength(0);
  });

  it("tolerates a message deleted between the history page and the fetch", async () => {
    await seedAccount();
    await seedInbox("support@acme.dev", null);
    stubGmail({ historyIds: ["gone"], messages: {} });

    const res = await syncAccount(
      getDb(),
      await account(),
      env as unknown as CloudflareBindings,
      fakeCtx(),
      CFG,
    );
    expect(res.ingested).toBe(0);
    expect(res.skipped).toBe(1);
  });
});

describe("syncAccount — the message cap and the resume cursor", () => {
  /** `n` messages, each with a distinct Message-ID so none is deduplicated. */
  function bulkMessages(ids: string[]) {
    const messages: Record<string, { raw: string }> = {};
    for (const id of ids) {
      messages[id] = {
        raw: rawEmail({
          from: "jane@example.com",
          deliveredTo: "support@acme.dev",
          messageId: `<${id}@example.com>`,
        }),
      };
    }
    return messages;
  }

  it("stops on a record boundary and resumes from the last whole record", async () => {
    await seedAccount();
    await seedInbox("support@acme.dev", null);

    // One message per record, more records than the cap allows.
    const total = MAX_MESSAGES_PER_RUN + 10;
    const ids = Array.from({ length: total }, (_, i) => `m${i + 1}`);
    const records = ids.map((id, i) => ({
      id: String(10001 + i),
      messageIds: [id],
    }));
    stubGmail({ records, messages: bulkMessages(ids) });

    const res = await syncAccount(
      getDb(),
      await account(),
      env as unknown as CloudflareBindings,
      fakeCtx(),
      CFG,
    );

    expect(res.ingested).toBe(MAX_MESSAGES_PER_RUN);
    expect(await getDb().select().from(emails)).toHaveLength(
      MAX_MESSAGES_PER_RUN,
    );

    // The cursor is the LAST FULLY PROCESSED record's id. Anything else loses
    // mail: the page-level historyId would skip the 10 unprocessed records,
    // and the original cursor would stall forever.
    const cursor = (await account()).historyId;
    expect(cursor).toBe(String(10001 + MAX_MESSAGES_PER_RUN - 1));
    expect(cursor).not.toBe("9100");
    expect(cursor).not.toBe("9000");
  });

  it("drains the whole backlog across runs, skipping nothing", async () => {
    await seedAccount();
    await seedInbox("support@acme.dev", null);

    // The end-to-end proof that the resume cursor is correct: a backlog
    // larger than the cap must arrive complete after two runs, with no
    // message lost at the boundary between them.
    const total = MAX_MESSAGES_PER_RUN + 10;
    const ids = Array.from({ length: total }, (_, i) => `m${i + 1}`);
    stubGmail({
      records: ids.map((id, i) => ({
        id: String(10001 + i),
        messageIds: [id],
      })),
      messages: bulkMessages(ids),
    });

    const first = await syncAccount(
      getDb(),
      await account(),
      env as unknown as CloudflareBindings,
      fakeCtx(),
      CFG,
    );
    const second = await syncAccount(
      getDb(),
      await account(),
      env as unknown as CloudflareBindings,
      fakeCtx(),
      CFG,
    );

    expect(first.ingested).toBe(MAX_MESSAGES_PER_RUN);
    expect(second.ingested).toBe(10);

    const rows = await getDb().select().from(emails);
    expect(rows).toHaveLength(total);
    // Every single message arrived exactly once — no gap at the resume point.
    expect(rows.map((r) => r.gmailMessageId).sort()).toEqual([...ids].sort());
    // Second run consumed the remainder, so the cursor reaches the mailbox
    // head — which sits at the highest record id, 10001 + 59.
    expect((await account()).historyId).toBe("10060");
  });

  it("follows nextPageToken and processes every page's records", async () => {
    await seedAccount();
    await seedInbox("support@acme.dev", null);

    // Six messages spread over four records, delivered two records per page,
    // so the run must follow nextPageToken twice and group records within
    // each page independently.
    const records = [
      { id: "10001", messageIds: ["p1", "p2"] },
      { id: "10002", messageIds: ["p3"] },
      { id: "10003", messageIds: ["p4", "p5"] },
      { id: "10004", messageIds: ["p6"] },
    ];
    const ids = records.flatMap((r) => r.messageIds);
    stubGmail({ records, pageSize: 2, messages: bulkMessages(ids) });
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;

    const res = await syncAccount(
      getDb(),
      await account(),
      env as unknown as CloudflareBindings,
      fakeCtx(),
      CFG,
    );

    expect(res.ingested).toBe(6);
    const rows = await getDb().select().from(emails);
    // Nothing skipped at a page boundary, nothing ingested twice.
    expect(rows.map((r) => r.gmailMessageId).sort()).toEqual([...ids].sort());
    expect((await account()).historyId).toBe("10004");

    // Prove the pagination path actually ran rather than one page happening
    // to carry everything.
    const historyCalls = fetchMock.mock.calls.filter((c) =>
      String(c[0]).includes("/users/me/history"),
    );
    expect(historyCalls.length).toBe(2);
    expect(String(historyCalls[1][0])).toContain("pageToken=p2");
  });

  it("leaves the cursor at the FIRST page's historyId, not the last", async () => {
    await seedAccount();
    await seedInbox("support@acme.dev", null);

    // Mail arrives while we paginate, so page two reports a head far above
    // anything either page showed us. Trusting it would skip every record
    // between 10500 and 99999 that we were never given.
    const records = [
      { id: "10001", messageIds: ["q1"] },
      { id: "10002", messageIds: ["q2"] },
      { id: "10003", messageIds: ["q3"] },
      { id: "10004", messageIds: ["q4"] },
    ];
    const ids = records.flatMap((r) => r.messageIds);
    stubGmail({
      records,
      pageSize: 2,
      pageHistoryIds: ["10500", "99999"],
      messages: bulkMessages(ids),
    });

    const res = await syncAccount(
      getDb(),
      await account(),
      env as unknown as CloudflareBindings,
      fakeCtx(),
      CFG,
    );

    expect(res.ingested).toBe(4);
    const cursor = (await account()).historyId;
    expect(cursor).toBe("10500");
    expect(cursor).not.toBe("99999");
  });

  it("never splits a record, even when that means overshooting the cap", async () => {
    await seedAccount();
    await seedInbox("support@acme.dev", null);

    // Record A fits; record B alone would take the run past the cap. B must
    // be deferred whole rather than half-processed.
    const aIds = Array.from(
      { length: MAX_MESSAGES_PER_RUN - 2 },
      (_, i) => `a${i}`,
    );
    const bIds = ["b0", "b1", "b2", "b3"];
    stubGmail({
      records: [
        { id: "20001", messageIds: aIds },
        { id: "20002", messageIds: bIds },
      ],
      messages: bulkMessages([...aIds, ...bIds]),
    });

    const res = await syncAccount(
      getDb(),
      await account(),
      env as unknown as CloudflareBindings,
      fakeCtx(),
      CFG,
    );

    expect(res.ingested).toBe(aIds.length);
    // Not one message of record B leaked through.
    const rows = await getDb().select().from(emails);
    expect(rows.map((r) => r.gmailMessageId).sort()).toEqual([...aIds].sort());
    expect((await account()).historyId).toBe("20001");
  });

  it("processes an over-sized single record whole rather than stalling", async () => {
    await seedAccount();
    await seedInbox("support@acme.dev", null);

    // One record bigger than the cap. Deferring it would leave the cursor
    // unable to move past it on any future run — the stall this design
    // exists to remove — so it is processed in full, slightly over budget.
    const ids = Array.from(
      { length: MAX_MESSAGES_PER_RUN + 5 },
      (_, i) => `big${i}`,
    );
    stubGmail({
      records: [{ id: "30001", messageIds: ids }],
      messages: bulkMessages(ids),
    });

    const res = await syncAccount(
      getDb(),
      await account(),
      env as unknown as CloudflareBindings,
      fakeCtx(),
      CFG,
    );

    expect(res.ingested).toBe(ids.length);
    expect(res.ingested).toBeGreaterThan(MAX_MESSAGES_PER_RUN);
    // The whole page was consumed, so the cursor reaches the mailbox head.
    expect((await account()).historyId).toBe("30001");
  });
});

describe("syncAccount — an unusable inbox mapping stalls", () => {
  const oneMessage = {
    historyIds: ["m1"],
    messages: {
      m1: {
        raw: rawEmail({
          from: "jane@example.com",
          deliveredTo: "support@acme.dev",
          messageId: "<n1@example.com>",
        }),
      },
    },
  };

  it("consumes no history when there is no personal mapping", async () => {
    await seedAccount();
    // Only a GROUP mapping, so there is no personal mailbox to route to.
    await seedInbox("support@acme.dev", "team@acme.dev");
    stubGmail(oneMessage);

    const res = await syncAccount(
      getDb(),
      await account(),
      env as unknown as CloudflareBindings,
      fakeCtx(),
      CFG,
    );

    expect(res.ingested).toBe(0);
    expect(await getDb().select().from(emails)).toHaveLength(0);

    const row = await account();
    // The cursor must NOT move. Advancing it would consume the history naming
    // this message and lose it permanently, over a fixable misconfiguration.
    expect(row.historyId).toBe("9000");
    expect(row.lastError).toBe("no_personal_inbox");
  });

  it("consumes no history when two inboxes claim the same account", async () => {
    await seedAccount();
    // Reachable today: the admin PATCH does not enforce one inbox per Gmail
    // account, and resolvePersonalInbox refuses to pick between them.
    await seedInbox("support@acme.dev", null);
    await seedInbox("sales@acme.dev", null);
    stubGmail(oneMessage);

    const res = await syncAccount(
      getDb(),
      await account(),
      env as unknown as CloudflareBindings,
      fakeCtx(),
      CFG,
    );

    expect(res.ingested).toBe(0);
    expect(await getDb().select().from(emails)).toHaveLength(0);

    const row = await account();
    expect(row.historyId).toBe("9000");
    // Distinguished from the none case: the operator must remove a mapping,
    // not add one.
    expect(row.lastError).toBe("ambiguous_inbox_mapping");
  });

  it("does not seed a cursor for an unconfigured account", async () => {
    await seedAccount(null);
    await seedInbox("support@acme.dev", "team@acme.dev");
    stubGmail({ profileHistoryId: "55555" });

    await syncAccount(
      getDb(),
      await account(),
      env as unknown as CloudflareBindings,
      fakeCtx(),
      CFG,
    );

    const row = await account();
    // Seeding would silently set the no-backfill watermark on an account that
    // cannot receive mail yet, so mail arriving before the fix is lost.
    expect(row.historyId).toBeNull();
    expect(row.lastError).toBe("no_personal_inbox");
  });
});

describe("syncAccount — a failing message", () => {
  function bulkMessages(ids: string[]) {
    const messages: Record<string, { raw: string }> = {};
    for (const id of ids) {
      messages[id] = {
        raw: rawEmail({
          from: "jane@example.com",
          deliveredTo: "support@acme.dev",
          messageId: `<${id}@example.com>`,
        }),
      };
    }
    return messages;
  }

  it("keeps completed work, stops at the failure, and marks the account", async () => {
    await seedAccount();
    await seedInbox("support@acme.dev", null);
    stubGmail({
      records: [
        { id: "10001", messageIds: ["ok1"] },
        { id: "10002", messageIds: ["bad"] },
        { id: "10003", messageIds: ["later"] },
      ],
      messages: bulkMessages(["ok1", "bad", "later"]),
      failMessageIds: ["bad"],
    });

    const res = await syncAccount(
      getDb(),
      await account(),
      env as unknown as CloudflareBindings,
      fakeCtx(),
      CFG,
    );

    expect(res.ingested).toBe(1);
    expect(res.failed).toBe(1);

    // Work finished before the failure is kept, not re-fetched next tick.
    const rows = await getDb().select().from(emails);
    expect(rows.map((r) => r.gmailMessageId)).toEqual(["ok1"]);

    const row = await account();
    // The cursor stops at the last record completed BEFORE the failure: far
    // enough not to redo `ok1`, not so far as to skip `bad` or `later`.
    expect(row.historyId).toBe("10001");
    // An operator can act on this: the id names the message to look at.
    expect(row.lastError).toBe("message_failed:bad");
  });

  it("does not skip ahead past the failed record", async () => {
    await seedAccount();
    await seedInbox("support@acme.dev", null);
    const opts = {
      records: [
        { id: "10001", messageIds: ["ok1"] },
        { id: "10002", messageIds: ["bad"] },
        { id: "10003", messageIds: ["later"] },
      ],
      messages: bulkMessages(["ok1", "bad", "later"]),
      failMessageIds: ["bad"],
    };
    stubGmail(opts);
    await syncAccount(
      getDb(),
      await account(),
      env as unknown as CloudflareBindings,
      fakeCtx(),
      CFG,
    );

    // The poison message clears; the retry must pick up `bad` AND `later`,
    // proving the stall never became a silent gap.
    stubGmail({ ...opts, failMessageIds: [] });
    const res = await syncAccount(
      getDb(),
      await account(),
      env as unknown as CloudflareBindings,
      fakeCtx(),
      CFG,
    );

    expect(res.ingested).toBe(2);
    const rows = await getDb().select().from(emails);
    expect(rows.map((r) => r.gmailMessageId).sort()).toEqual([
      "bad",
      "later",
      "ok1",
    ]);
    const row = await account();
    expect(row.historyId).toBe("10003");
    // Recovered, so the marker is gone.
    expect(row.lastError).toBeNull();
  });
});

describe("syncAccount — failure handling", () => {
  it("re-seeds the cursor when history has expired", async () => {
    await seedAccount("1");
    await seedInbox("support@acme.dev", null);
    stubGmail({ historyStatus: 404, profileHistoryId: "77777" });

    const res = await syncAccount(
      getDb(),
      await account(),
      env as unknown as CloudflareBindings,
      fakeCtx(),
      CFG,
    );

    expect(res.reseeded).toBe(true);
    const row = await account();
    expect(row.historyId).toBe("77777");
    // Re-seeding keeps sync alive but skips whatever arrived in the gap. That
    // is mail the operator will never see, so the account is marked rather
    // than quietly carrying on as if nothing happened.
    expect(row.lastError).toBe("history_gap");
    expect(row.lastGapAt).toBeGreaterThan(0);
    expect(row.lastGapAt).toBeLessThanOrEqual(Math.floor(Date.now() / 1000));
  });

  it("keeps the gap on record after a later successful sync", async () => {
    await seedAccount("1");
    await seedInbox("support@acme.dev", null);
    // Re-seed to 9000 rather than an arbitrary high value, so the follow-up
    // run's record (9001) actually sits after the new cursor.
    stubGmail({ historyGoneForStartId: "1", profileHistoryId: "9000" });

    await syncAccount(
      getDb(),
      await account(),
      env as unknown as CloudflareBindings,
      fakeCtx(),
      CFG,
    );
    const gapAt = (await account()).lastGapAt;
    expect(gapAt).toBeGreaterThan(0);

    // A healthy run from the re-seeded cursor. It clears lastError, which is
    // exactly why lastError alone could not carry this signal.
    stubGmail({
      historyIds: ["m1"],
      messages: {
        m1: {
          raw: rawEmail({
            from: "jane@example.com",
            deliveredTo: "support@acme.dev",
            messageId: "<after-gap@example.com>",
          }),
        },
      },
    });
    const res = await syncAccount(
      getDb(),
      await account(),
      env as unknown as CloudflareBindings,
      fakeCtx(),
      CFG,
    );
    expect(res.ingested).toBe(1);

    const row = await account();
    expect(row.lastError).toBeNull();
    // The gap happened. A later healthy run does not un-happen it, so the
    // record survives until an operator reconnects the account.
    expect(row.lastGapAt).toBe(gapAt);
  });

  it("leaves no gap marker on a first seed, which loses nothing", async () => {
    await seedAccount(null);
    await seedInbox("support@acme.dev", null);
    stubGmail({ profileHistoryId: "55555" });

    await syncAccount(
      getDb(),
      await account(),
      env as unknown as CloudflareBindings,
      fakeCtx(),
      CFG,
    );

    const row = await account();
    expect(row.historyId).toBe("55555");
    expect(row.lastError).toBeNull();
    // No mail was missed, so there is no gap to record.
    expect(row.lastGapAt).toBeNull();
  });

  it("seeds from the profile when the account has no cursor yet", async () => {
    await seedAccount(null);
    await seedInbox("support@acme.dev", null);
    stubGmail({ profileHistoryId: "55555" });

    await syncAccount(
      getDb(),
      await account(),
      env as unknown as CloudflareBindings,
      fakeCtx(),
      CFG,
    );
    expect((await account()).historyId).toBe("55555");
  });
});

describe("syncAllGmailAccounts", () => {
  it("does nothing when the integration is unconfigured", async () => {
    await seedAccount();
    await seedInbox("support@acme.dev", null);
    stubGmail({
      historyIds: ["m1"],
      messages: {
        m1: {
          raw: rawEmail({
            from: "jane@example.com",
            deliveredTo: "support@acme.dev",
            messageId: "<u1@example.com>",
          }),
        },
      },
    });
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;

    // miniflare's env is mutable inside a test isolate; restore in `finally`
    // so the rest of the suite still sees a configured instance.
    const mutableEnv = env as unknown as Record<string, string | undefined>;
    const saved = mutableEnv.GOOGLE_OAUTH_CLIENT_SECRET;
    delete mutableEnv.GOOGLE_OAUTH_CLIENT_SECRET;
    try {
      await syncAllGmailAccounts(
        getDb(),
        env as unknown as CloudflareBindings,
        fakeCtx(),
      );
    } finally {
      mutableEnv.GOOGLE_OAUTH_CLIENT_SECRET = saved;
    }

    // Not merely "no mail ingested" but "never reached the network": an
    // instance that never configured Gmail must not talk to Google, nor log
    // an error, on every 15-minute cron tick.
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await getDb().select().from(emails)).toHaveLength(0);
  });

  it("keeps syncing other accounts when one has a revoked grant", async () => {
    await seedAccount("9000", {
      id: "acct-1",
      emailAddress: "revoked@acme.dev",
      refreshToken: "rt-revoked",
    });
    await seedInbox("support@acme.dev", null, "acct-1");
    await seedAccount("9000", {
      id: "acct-2",
      emailAddress: "healthy@acme.dev",
      refreshToken: "rt-good",
    });
    await seedInbox("support2@acme.dev", null, "acct-2");

    stubGmail({
      revokedRefreshToken: "rt-revoked",
      historyIds: ["m1"],
      messages: {
        m1: {
          raw: rawEmail({
            from: "jane@example.com",
            deliveredTo: "support2@acme.dev",
            messageId: "<iso1@example.com>",
          }),
        },
      },
    });

    // Must not reject: one dead mailbox cannot fail the whole cron tick.
    await expect(
      syncAllGmailAccounts(
        getDb(),
        env as unknown as CloudflareBindings,
        fakeCtx(),
      ),
    ).resolves.toBeUndefined();

    // The healthy account still ingested, and still advanced its cursor.
    const rows = await getDb().select().from(emails);
    expect(rows).toHaveLength(1);
    expect(rows[0].recipient).toBe("support2@acme.dev");

    const all = await getDb().select().from(gmailAccounts);
    const revoked = all.find((r) => r.id === "acct-1")!;
    const healthy = all.find((r) => r.id === "acct-2")!;
    expect(healthy.historyId).toBe("9100");
    // getAccessToken records the reason so the UI can offer "Reconnect",
    // and the broken account's cursor is left where it was.
    expect(revoked.lastError).toBe("invalid_grant");
    expect(revoked.historyId).toBe("9000");
  });

  it("keeps syncing other accounts when one has to re-seed its cursor", async () => {
    // An expired cursor takes a different path from a revoked grant: it
    // returns normally rather than throwing, so Promise.allSettled never
    // sees a rejection and the isolation is otherwise unproven.
    await seedAccount("1", { id: "acct-1", emailAddress: "stale@acme.dev" });
    await seedInbox("support@acme.dev", null, "acct-1");
    await seedAccount("9000", {
      id: "acct-2",
      emailAddress: "healthy@acme.dev",
    });
    await seedInbox("support2@acme.dev", null, "acct-2");

    stubGmail({
      historyGoneForStartId: "1",
      profileHistoryId: "77777",
      historyIds: ["m1"],
      messages: {
        m1: {
          raw: rawEmail({
            from: "jane@example.com",
            deliveredTo: "support2@acme.dev",
            messageId: "<reseed1@example.com>",
          }),
        },
      },
    });

    // `syncAllGmailAccounts` logs its own distinct line when a fulfilled
    // result reports `reseeded: true`, on top of the `console.warn` that
    // `seedCursor` already logs from inside `syncAccount` — a re-seed is
    // otherwise durably recorded only on `gmail_accounts.lastGapAt`, never
    // in cron output.
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await expect(
        syncAllGmailAccounts(
          getDb(),
          env as unknown as CloudflareBindings,
          fakeCtx(),
        ),
      ).resolves.toBeUndefined();

      expect(
        warnSpy.mock.calls.some((call) =>
          call.some(
            (arg) => typeof arg === "string" && arg.includes("stale@acme.dev"),
          ),
        ),
      ).toBe(true);
    } finally {
      warnSpy.mockRestore();
    }

    const all = await getDb().select().from(gmailAccounts);
    const stale = all.find((r) => r.id === "acct-1")!;
    const healthy = all.find((r) => r.id === "acct-2")!;
    // The stale account re-seeded from its profile rather than crashing.
    expect(stale.historyId).toBe("77777");
    // The healthy account was entirely unaffected.
    expect(healthy.historyId).toBe("9100");
    const rows = await getDb().select().from(emails);
    expect(rows).toHaveLength(1);
    expect(rows[0].recipient).toBe("support2@acme.dev");
  });

  it("logs a distinct line naming the account when a message fails to ingest", async () => {
    // A message that fails inside `syncAccount` is caught there, counted in
    // `failed`, and the promise RESOLVES — so `Promise.allSettled` reports
    // this account as fulfilled. Without the `result.value.failed` branch in
    // `syncAllGmailAccounts`, nothing here would ever be visible at the cron
    // layer, only on `gmail_accounts.lastError`.
    await seedAccount("9000", {
      id: "acct-1",
      emailAddress: "poison@acme.dev",
    });
    await seedInbox("support@acme.dev", null, "acct-1");
    stubGmail({
      historyIds: ["bad"],
      messages: {
        bad: {
          raw: rawEmail({
            from: "jane@example.com",
            deliveredTo: "support@acme.dev",
            messageId: "<bad1@example.com>",
          }),
        },
      },
      failMessageIds: ["bad"],
    });

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(
        syncAllGmailAccounts(
          getDb(),
          env as unknown as CloudflareBindings,
          fakeCtx(),
        ),
      ).resolves.toBeUndefined();

      // Asserts on the account address appearing in the logged output
      // (not an exact string) — a rejection isolation test elsewhere in
      // this file already pins the exact wording of the per-message log
      // `syncAccount` emits; this checks the SEPARATE summary line that
      // `syncAllGmailAccounts` itself now emits for a fulfilled-but-failed
      // result.
      expect(
        errorSpy.mock.calls.some((call) =>
          call.some(
            (arg) =>
              typeof arg === "string" &&
              arg.includes("poison@acme.dev") &&
              /failed/i.test(arg) &&
              arg.includes("1"),
          ),
        ),
      ).toBe(true);
    } finally {
      errorSpy.mockRestore();
    }

    const row = (
      await getDb()
        .select()
        .from(gmailAccounts)
        .where(eq(gmailAccounts.id, "acct-1"))
    )[0];
    expect(row.lastError).toBe("message_failed:bad");
  });
});
