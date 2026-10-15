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
import { sentEmails } from "../db/sent-emails.schema";
import { people } from "../db/people.schema";
import { encryptSecret } from "../lib/crypto";
import {
  syncAccount,
  syncAllGmailAccounts,
  runBackfillChunk,
  MAX_MESSAGES_PER_RUN,
} from "../lib/gmail/sync";
import {
  ensureBackfillJobs,
  runBackfillJob,
  CHUNK_SIZE,
  CHUNKS_PER_JOB,
} from "../lib/gmail/backfill-job";
import { BACKFILL_WINDOW_SECONDS } from "../lib/gmail/backfill";
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
  messages?: Record<
    string,
    { raw: string; labelIds?: string[]; internalDate?: string }
  >;
  /** What `messages.list` (the backfill) returns, newest first. */
  listIds?: string[];
  /** Every `messages.list` query string, for asserting the window. */
  listQueries?: string[];
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
      if (new URL(url).pathname.endsWith("/users/me/messages")) {
        const query = new URL(url).searchParams;
        opts.listQueries?.push(query.get("q") ?? "");
        const size = Number(query.get("maxResults") ?? "100");
        const offset = Number(query.get("pageToken") ?? "0");
        const ids = opts.listIds ?? [];
        const more = offset + size < ids.length;
        return json({
          messages: ids.slice(offset, offset + size).map((id) => ({ id })),
          ...(more ? { nextPageToken: String(offset + size) } : {}),
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
          ...(msg.internalDate ? { internalDate: msg.internalDate } : {}),
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

  it("ignores a mapping whose source is not gmail, even when it names this account", async () => {
    // The send path already refuses this row — `resolveGmailAccountId` checks
    // `source !== "gmail"`. The sync used to route on `gmail_account_id`
    // alone, so the same row received through Google while replies from it
    // left through the configured provider, under a Workspace address, with
    // the UI showing "Cloudflare".
    await seedAccount();
    const now = Math.floor(Date.now() / 1000);
    await getDb().insert(senderIdentities).values({
      email: "support@acme.dev",
      displayName: "Support",
      source: "cloudflare",
      gmailAccountId: "acct-1",
      gmailGroupAddress: null,
      createdAt: now,
      updatedAt: now,
    });
    stubGmail({
      historyIds: ["m1"],
      messages: {
        m1: {
          raw: rawEmail({
            from: "jane@example.com",
            deliveredTo: "support@acme.dev",
            messageId: "<src1@example.com>",
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
    expect(await getDb().select().from(emails)).toHaveLength(0);
    // No usable destination, so the cursor is held rather than consumed —
    // the same stall-rather-than-drop rule as any other bad mapping.
    const row = await account();
    expect(row.historyId).toBe("9000");
    expect(row.lastError).toBe("no_personal_inbox");
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

describe("syncAccount — one message, two connected mailboxes", () => {
  /** The second mailbox's row, which `account()` (hard-coded to acct-1) can't give us. */
  async function accountB() {
    const [row] = await getDb()
      .select()
      .from(gmailAccounts)
      .where(eq(gmailAccounts.id, "acct-2"));
    return row;
  }

  it("delivers the same Message-ID to both inboxes", async () => {
    await seedAccount();
    await seedAccount("9000", {
      id: "acct-2",
      emailAddress: "collector-b@acme.dev",
    });
    await seedInbox("support@acme.dev", null, "acct-1");
    await seedInbox("sales@acme.dev", null, "acct-2");
    // One message, both inboxes on the To: line — so both mailboxes collect
    // it and both copies carry the same Message-ID.
    const opts = {
      historyIds: ["m1"],
      messages: {
        m1: {
          raw: rawEmail({
            from: "jane@example.com",
            deliveredTo: "support@acme.dev",
            messageId: "<shared-1@example.com>",
          }),
        },
      },
    };

    stubGmail(opts);
    const a = await syncAccount(
      getDb(),
      await account(),
      env as unknown as CloudflareBindings,
      fakeCtx(),
      CFG,
    );
    stubGmail(opts);
    const b = await syncAccount(
      getDb(),
      await accountB(),
      env as unknown as CloudflareBindings,
      fakeCtx(),
      CFG,
    );

    expect(a.ingested).toBe(1);
    // The defect this pins: B's copy hit a GLOBAL Message-ID dedupe, was
    // dropped, was counted as `ingested: 1` anyway, and B's cursor advanced
    // past it — so sales@ could never receive it by any later route.
    expect(b.ingested).toBe(1);
    expect(b.skipped).toBe(0);

    const rows = await getDb().select().from(emails);
    expect(rows.map((r) => r.recipient).sort()).toEqual([
      "sales@acme.dev",
      "support@acme.dev",
    ]);
    // Both rows are real deliveries of the same Gmail message, each stamped
    // by the run that created it.
    expect(rows.every((r) => r.gmailMessageId === "m1")).toBe(true);
    expect(rows.every((r) => r.messageId === "<shared-1@example.com>")).toBe(
      true,
    );
  });

  it("counts the same message offered to the SAME inbox twice as skipped, not ingested", async () => {
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
    const first = await syncAccount(
      getDb(),
      await account(),
      env as unknown as CloudflareBindings,
      fakeCtx(),
      CFG,
    );
    // Rewind the cursor so the same history record is genuinely replayed —
    // an overlapping cron tick reads the pre-advance value, which is exactly
    // this. Without the rewind the second run sees an empty page and the
    // dedupe is never reached.
    await getDb()
      .update(gmailAccounts)
      .set({ historyId: "9000" })
      .where(eq(gmailAccounts.id, "acct-1"));
    stubGmail(opts);
    const second = await syncAccount(
      getDb(),
      await account(),
      env as unknown as CloudflareBindings,
      fakeCtx(),
      CFG,
    );

    expect(first.ingested).toBe(1);
    expect(second.ingested).toBe(0);
    expect(second.skipped).toBe(1);
    expect(await getDb().select().from(emails)).toHaveLength(1);
  });

  it("does not stamp Gmail ids onto a row a different source already delivered", async () => {
    await seedAccount();
    await seedInbox("support@acme.dev", null);
    // A Cloudflare-delivered row on a DIFFERENT inbox, carrying a Message-ID
    // the sender also put on the Gmail copy. The write-back used to find it
    // by `message_id` alone — `gmail_message_id IS NULL` is true for exactly
    // this row, so the guard that claimed to protect it did not.
    const now = Math.floor(Date.now() / 1000);
    await getDb().insert(emails).values({
      id: "pre-existing",
      personId: "p-1",
      recipient: "hello@acme.dev",
      subject: "delivered by cloudflare",
      messageId: "<forged@example.com>",
      receivedAt: now,
      createdAt: now,
    });
    stubGmail({
      historyIds: ["m1"],
      messages: {
        m1: {
          raw: rawEmail({
            from: "attacker@example.com",
            deliveredTo: "support@acme.dev",
            messageId: "<forged@example.com>",
          }),
        },
      },
    });

    await syncAccount(
      getDb(),
      await account(),
      env as unknown as CloudflareBindings,
      fakeCtx(),
      CFG,
    );

    const [preExisting] = await getDb()
      .select()
      .from(emails)
      .where(eq(emails.id, "pre-existing"));
    expect(preExisting.gmailMessageId).toBeNull();
    expect(preExisting.gmailThreadId).toBeNull();
    // The Gmail copy is its own row on its own inbox, and it is the one
    // that carries the ids.
    const [synced] = await getDb()
      .select()
      .from(emails)
      .where(eq(emails.recipient, "support@acme.dev"));
    expect(synced.gmailMessageId).toBe("m1");
    expect(synced.gmailThreadId).toBe("t-m1");
  });
});

describe("syncAccount — skipping", () => {
  it("mirrors a SENT message onto the timeline, never into emails", async () => {
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
    expect(res.mirrored).toBe(1);
    // Not an ingest: nothing ARRIVED, we mirrored our own outgoing mail.
    expect(res.ingested).toBe(0);
    expect(res.skipped).toBe(0);
    // The boundary this test has always guarded, and still does: mail the
    // mailbox SENT must never be ingested as if it had arrived.
    expect(await getDb().select().from(emails)).toHaveLength(0);
    // It is mirrored into `sent_emails` instead — see gmail-sync-sent.test.ts
    // for the full contract.
    const sent = await getDb().select().from(sentEmails);
    expect(sent).toHaveLength(1);
    expect(sent[0].gmailMessageId).toBe("m1");
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

  /**
   * A rejecting sync used to be logged and nothing else: `lastError` stayed
   * null and `lastSyncedAt` kept its old value, so a mailbox failing every
   * 15 minutes for a week rendered in the admin UI as "Synced 7 days ago"
   * with no Reconnect offered. `lastError` is the only field that page reads
   * for trouble, so it is the only place this can be said.
   */
  describe("records a rejecting sync on the account", () => {
    /** Seed one mapped account with a sync already behind it. */
    async function seedSyncedAccount(lastSyncedAt: number) {
      await seedAccount("9000", {
        id: "acct-1",
        emailAddress: "collector@acme.dev",
      });
      await seedInbox("support@acme.dev", null, "acct-1");
      await getDb()
        .update(gmailAccounts)
        .set({ lastSyncedAt })
        .where(eq(gmailAccounts.id, "acct-1"));
    }

    it("writes the Gmail status code and moves neither the cursor nor lastSyncedAt", async () => {
      const syncedAt = Math.floor(Date.now() / 1000) - 86400;
      await seedSyncedAccount(syncedAt);
      // A 5xx from history.list is not `history_gone`, so `syncAccount`
      // rethrows it and the whole account rejects.
      stubGmail({ historyStatus: 500 });

      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        await expect(
          syncAllGmailAccounts(
            getDb(),
            env as unknown as CloudflareBindings,
            fakeCtx(),
          ),
        ).resolves.toBeUndefined();
      } finally {
        errorSpy.mockRestore();
      }

      const row = await account();
      expect(row.lastError).toBe("sync_failed:http_500");
      // Nothing synced, so nothing may claim it did — and the cursor has to
      // stay put or the next run skips whatever this one never read.
      expect(row.lastSyncedAt).toBe(syncedAt);
      expect(row.historyId).toBe("9000");
    });

    it("distinguishes a rate limit from a server error", async () => {
      await seedSyncedAccount(Math.floor(Date.now() / 1000) - 3600);
      stubGmail({ historyStatus: 429 });

      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        await syncAllGmailAccounts(
          getDb(),
          env as unknown as CloudflareBindings,
          fakeCtx(),
        );
      } finally {
        errorSpy.mockRestore();
      }

      // Gmail's own classification, so the operator can tell "try again" from
      // "something is broken" — and so the UI can withhold Reconnect, which
      // fixes neither.
      expect((await account()).lastError).toBe("sync_failed:rate_limited");
    });

    it("reduces an unclassified failure to a code, never its message", async () => {
      await seedSyncedAccount(Math.floor(Date.now() / 1000) - 3600);
      stubGmail({});
      // Fail the history call with the shape this rule exists for: a D1
      // error, whose message carries the parameters bound to the query — on
      // this path the access token and the sealed refresh token. `lastError`
      // is returned by GET /api/admin/gmail and rendered in the admin UI, so
      // copying a message into it would publish them.
      const inner = globalThis.fetch;
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
          if (String(input).includes("/users/me/history")) {
            throw new Error(
              `D1_ERROR: no such column: foo at offset 0: SQLITE_ERROR (params: ["at-1","rt-1"])`,
            );
          }
          return inner(input, init);
        }),
      );

      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        await syncAllGmailAccounts(
          getDb(),
          env as unknown as CloudflareBindings,
          fakeCtx(),
        );
      } finally {
        errorSpy.mockRestore();
      }

      const { lastError } = await account();
      expect(lastError).toBe("sync_failed:unknown");
      expect(lastError).not.toContain("at-1");
      expect(lastError).not.toContain("rt-1");
    });

    it("logs the failure's message but never the error object", async () => {
      await seedSyncedAccount(Math.floor(Date.now() / 1000) - 3600);
      stubGmail({ historyStatus: 500 });

      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        await syncAllGmailAccounts(
          getDb(),
          env as unknown as CloudflareBindings,
          fakeCtx(),
        );
        const call = errorSpy.mock.calls.find(
          (args) =>
            typeof args[0] === "string" &&
            args[0].includes("Gmail sync failed for collector@acme.dev"),
        );
        expect(call).toBeDefined();
        // One string argument. Passing the Error itself is what leaks: a D1
        // error's serialised form carries the query parameters bound to it.
        expect(call).toHaveLength(1);
        expect(call![0]).toContain("500");
      } finally {
        errorSpy.mockRestore();
      }
    });
  });
});

/** A received message with an explicit To: line, for alias routing. */
function addressed(opts: {
  from: string;
  to: string;
  messageId: string;
  cc?: string;
}) {
  return [
    `From: ${opts.from}`,
    `To: ${opts.to}`,
    ...(opts.cc ? [`Cc: ${opts.cc}`] : []),
    `Delivered-To: choyin@acme.dev`,
    `Message-ID: ${opts.messageId}`,
    `Subject: Alias subject`,
    `Content-Type: text/plain; charset=utf-8`,
    ``,
    `body text`,
  ].join("\r\n");
}

async function markBackfillDone() {
  await getDb()
    .update(gmailAccounts)
    .set({ backfillCompletedAt: 1 })
    .where(eq(gmailAccounts.id, "acct-1"));
}

async function run(ctx: ExecutionContext = fakeCtx()) {
  return syncAccount(
    getDb(),
    await account(),
    env as unknown as CloudflareBindings,
    ctx,
    CFG,
  );
}

async function inboxOf(messageId: string) {
  const rows = await getDb()
    .select({ recipient: emails.recipient })
    .from(emails)
    .where(eq(emails.messageId, messageId));
  return rows.map((r) => r.recipient).sort();
}

describe("syncAccount — several inboxes on one Google mailbox", () => {
  beforeEach(async () => {
    await seedAccount("9000", { emailAddress: "choyin@acme.dev" });
    await markBackfillDone();
  });

  it("routes alias mail to the alias's inbox and the rest to the account's own", async () => {
    await seedInbox("hello@acme.dev", null);
    await seedInbox("choyin@acme.dev", null);
    stubGmail({
      historyIds: ["m1", "m2", "m3", "m4"],
      messages: {
        m1: {
          raw: addressed({
            from: "jane@example.com",
            to: "Hello <hello@acme.dev>",
            messageId: "<a1@example.com>",
          }),
        },
        m2: {
          raw: addressed({
            from: "jane@example.com",
            to: "choyin@acme.dev",
            messageId: "<a2@example.com>",
          }),
        },
        m3: {
          // Bcc'd, or a list: names neither inbox.
          raw: addressed({
            from: "news@lists.dev",
            to: "subscribers@lists.dev",
            messageId: "<a3@example.com>",
          }),
        },
        m4: {
          raw: addressed({
            from: "jane@example.com",
            to: "hello@acme.dev",
            cc: "choyin@acme.dev",
            messageId: "<a4@example.com>",
          }),
        },
      },
    });

    const res = await run();

    expect(res.failed).toBe(0);
    expect(await inboxOf("<a1@example.com>")).toEqual(["hello@acme.dev"]);
    expect(await inboxOf("<a2@example.com>")).toEqual(["choyin@acme.dev"]);
    expect(await inboxOf("<a3@example.com>")).toEqual(["choyin@acme.dev"]);
    // Named on both lines: one delivery per inbox.
    expect(await inboxOf("<a4@example.com>")).toEqual([
      "choyin@acme.dev",
      "hello@acme.dev",
    ]);
    const row = await account();
    expect(row.lastError).toBeNull();
    expect(row.historyId).toBe("9100");
  });

  it("files a reply sent from an alias under the alias's inbox", async () => {
    await seedInbox("hello@acme.dev", null);
    await seedInbox("choyin@acme.dev", null);
    stubGmail({
      historyIds: ["s1"],
      messages: {
        s1: {
          labelIds: ["SENT"],
          raw: [
            `From: Hello <hello@acme.dev>`,
            `To: jane@example.com`,
            `Message-ID: <s1@acme.dev>`,
            `Subject: Re: hi`,
            `Content-Type: text/plain; charset=utf-8`,
            ``,
            `reply`,
          ].join("\r\n"),
        },
      },
    });

    await run();

    const sent = await getDb().select().from(sentEmails);
    expect(sent).toHaveLength(1);
    expect(sent[0].fromAddress).toBe("hello@acme.dev");
  });

  it("skips mail that names no alias when only aliases are mapped, without stalling", async () => {
    await seedInbox("hello@acme.dev", null);
    await seedInbox("sales@acme.dev", null);
    stubGmail({
      historyIds: ["m1"],
      messages: {
        m1: {
          raw: addressed({
            from: "jane@example.com",
            to: "choyin@acme.dev",
            messageId: "<p1@example.com>",
          }),
        },
      },
    });

    const res = await run();

    expect(res.skipped).toBe(1);
    expect(await getDb().select().from(emails)).toHaveLength(0);
    const row = await account();
    expect(row.lastError).toBeNull();
    expect(row.historyId).toBe("9100");
  });
});

describe("the one-year import job", () => {
  const JOB = "job-1";

  function spyCtx() {
    const waitUntil = vi.fn();
    const ctx = {
      waitUntil,
      passThroughOnException: () => {},
      props: {},
    } as unknown as ExecutionContext;
    return { ctx, waitUntil };
  }

  function oldMessages(ids: string[], internalDate = "1700000000000") {
    const messages: Record<string, { raw: string; internalDate: string }> = {};
    for (const id of ids) {
      messages[id] = {
        internalDate,
        raw: addressed({
          from: `${id}@example.com`,
          to: "choyin@acme.dev",
          messageId: `<${id}@example.com>`,
        }),
      };
    }
    return messages;
  }

  /** One step of the job: up to `budget` messages, as job `jobId`. */
  function chunk(
    budget = MAX_MESSAGES_PER_RUN,
    ctx: ExecutionContext = fakeCtx(),
    jobId = JOB,
  ) {
    return runBackfillChunk(
      getDb(),
      env as unknown as CloudflareBindings,
      ctx,
      CFG,
      "acct-1",
      jobId,
      budget,
    );
  }

  /** A stand-in for the Workflow binding: records creates, answers status. */
  function fakeWorkflow(statuses: Record<string, string> = {}) {
    const created: Array<{ id: string; params: unknown }> = [];
    const binding = {
      create: async (opts: { id: string; params: unknown }) => {
        created.push(opts);
        statuses[opts.id] = "queued";
        return { id: opts.id };
      },
      get: async (id: string) => {
        if (!(id in statuses)) throw new Error("instance.not_found");
        return { status: async () => ({ status: statuses[id] }) };
      },
    };
    return { created, binding };
  }

  function envWith(binding: unknown): CloudflareBindings {
    return {
      ...(env as unknown as CloudflareBindings),
      GMAIL_BACKFILL: binding,
    } as unknown as CloudflareBindings;
  }

  function envWithout(): CloudflareBindings {
    return envWith(undefined);
  }

  async function ownJob(jobId: string | null = JOB) {
    await getDb()
      .update(gmailAccounts)
      .set({ backfillJobId: jobId })
      .where(eq(gmailAccounts.id, "acct-1"));
  }

  beforeEach(async () => {
    await seedAccount("9000", { emailAddress: "choyin@acme.dev" });
    await seedInbox("choyin@acme.dev", null);
    await ownJob();
  });

  it("imports the window quietly: read, at its own time, with no live side effects", async () => {
    const listQueries: string[] = [];
    stubGmail({
      listIds: ["b1", "b2"],
      listQueries,
      messages: oldMessages(["b1", "b2"]),
    });
    const { ctx, waitUntil } = spyCtx();
    const before = Math.floor(Date.now() / 1000);

    const res = await chunk(MAX_MESSAGES_PER_RUN, ctx);

    expect(res).toEqual({ status: "done", handled: 2 });
    const rows = await getDb().select().from(emails);
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.isRead).toBe(1);
      // Gmail's internalDate, not the import time.
      expect(row.receivedAt).toBe(1_700_000_000);
      expect(row.recipient).toBe("choyin@acme.dev");
    }
    // No push fan-out, webhook or forward was scheduled.
    expect(waitUntil).not.toHaveBeenCalled();
    const person = await getDb()
      .select()
      .from(people)
      .where(eq(people.email, "b1@example.com"));
    expect(person[0].unreadCount).toBe(0);

    // A pinned one-year window.
    const match = listQueries[0].match(/^after:(\d+) before:(\d+)$/);
    expect(match).not.toBeNull();
    const [after, until] = [Number(match![1]), Number(match![2])];
    expect(until - after).toBe(BACKFILL_WINDOW_SECONDS);
    expect(until).toBeGreaterThanOrEqual(before);

    const row = await account();
    expect(row.backfillCompletedAt).not.toBeNull();
    expect(row.backfillCount).toBe(2);
    expect(row.lastError).toBeNull();
  });

  it("keeps a pinned window narrower than a year (the one-year migration)", async () => {
    // A mailbox that had already imported three months is moved onto the
    // older nine: the window ends where the old one began.
    await getDb()
      .update(gmailAccounts)
      .set({ backfillUntil: 1_692_000_000, backfillSince: 1_670_000_000 });
    const listQueries: string[] = [];
    stubGmail({
      listIds: ["b1"],
      listQueries,
      messages: oldMessages(["b1"]),
    });

    await chunk();

    expect(listQueries[0]).toBe("after:1670000000 before:1692000000");
    const row = await account();
    expect(row.backfillSince).toBe(1_670_000_000);
    expect(row.backfillUntil).toBe(1_692_000_000);
    expect(row.backfillCompletedAt).not.toBeNull();
  });

  it("resumes chunk after chunk over the same window and skips nothing", async () => {
    const ids = Array.from({ length: 130 }, (_, i) => `b${i}`);
    const listQueries: string[] = [];
    stubGmail({ listIds: ids, listQueries, messages: oldMessages(ids) });

    expect(await chunk(50)).toEqual({ status: "continue", handled: 50 });
    expect(await chunk(50)).toEqual({ status: "continue", handled: 50 });
    expect(await chunk(50)).toEqual({ status: "done", handled: 30 });

    const row = await account();
    expect(row.backfillCompletedAt).not.toBeNull();
    expect(row.backfillCount).toBe(130);
    expect(await getDb().select().from(emails)).toHaveLength(130);
    // Every chunk asked for the SAME window.
    expect(new Set(listQueries).size).toBe(1);
  });

  it("does not import a message twice when live sync already has it", async () => {
    stubGmail({
      historyIds: ["x1"],
      listIds: ["x1"],
      messages: oldMessages(["x1"]),
    });

    await run();
    await chunk();

    const rows = await getDb().select().from(emails);
    expect(rows).toHaveLength(1);
    // The live copy won: it is unread.
    expect(rows[0].isRead).toBe(0);
  });

  it("does nothing once the import has finished", async () => {
    await markBackfillDone();
    const listQueries: string[] = [];
    stubGmail({ listIds: ["b1"], listQueries, messages: oldMessages(["b1"]) });

    expect(await chunk()).toEqual({
      status: "stopped",
      handled: 0,
      reason: "complete",
    });
    expect(listQueries).toHaveLength(0);
  });

  it("does nothing as a job that no longer owns the account", async () => {
    const listQueries: string[] = [];
    stubGmail({ listIds: ["b1"], listQueries, messages: oldMessages(["b1"]) });

    expect(await chunk(50, fakeCtx(), "an-older-job")).toEqual({
      status: "stopped",
      handled: 0,
      reason: "superseded",
    });
    expect(listQueries).toHaveLength(0);
  });

  it("stops at a failing message, keeping its place for the next job", async () => {
    stubGmail({
      listIds: ["b1", "bad", "b2"],
      messages: oldMessages(["b1", "b2"]),
      failMessageIds: ["bad"],
    });

    expect(await chunk()).toEqual({
      status: "stopped",
      handled: 1,
      reason: "failed",
    });
    const row = await account();
    expect(row.lastError).toBe("message_failed:bad");
    expect(row.backfillCompletedAt).toBeNull();
    expect(row.backfillOffset).toBe(1);
    expect(await getDb().select().from(emails)).toHaveLength(1);
  });

  it("waits for an inbox to be mapped before importing", async () => {
    await getDb().delete(senderIdentities);
    const listQueries: string[] = [];
    stubGmail({ listIds: ["b1"], listQueries, messages: oldMessages(["b1"]) });

    expect((await chunk()).status).toBe("stopped");
    expect(listQueries).toHaveLength(0);
    expect((await account()).lastError).toBe("no_personal_inbox");
  });

  describe("the cron sync", () => {
    it("leaves the import to the job when the Workflow is bound", async () => {
      const listQueries: string[] = [];
      stubGmail({
        listIds: ["b1"],
        listQueries,
        messages: oldMessages(["b1"]),
      });
      const res = await syncAccount(
        getDb(),
        await account(),
        envWith(fakeWorkflow().binding),
        fakeCtx(),
        CFG,
      );
      expect(res.backfilled).toBe(0);
      expect(listQueries).toHaveLength(0);
    });

    it("imports inline, after live mail, on a config without the Workflow", async () => {
      const live = Array.from(
        { length: MAX_MESSAGES_PER_RUN - 10 },
        (_, i) => `l${i}`,
      );
      stubGmail({
        historyIds: live,
        listIds: ["b1", "b2", "b3"],
        messages: { ...oldMessages(live), ...oldMessages(["b1", "b2", "b3"]) },
      });

      const res = await syncAccount(
        getDb(),
        await account(),
        envWithout(),
        fakeCtx(),
        CFG,
      );

      expect(res.ingested).toBe(live.length);
      expect(res.backfilled).toBe(3);
    });
  });

  describe("ensureBackfillJobs", () => {
    it("starts a job for a mailbox with none and records it as the owner", async () => {
      await ownJob(null);
      const { created, binding } = fakeWorkflow();

      await ensureBackfillJobs(getDb(), envWith(binding));

      expect(created).toHaveLength(1);
      expect(created[0].params).toEqual({ accountId: "acct-1" });
      expect((await account()).backfillJobId).toBe(created[0].id);
    });

    it("leaves a live job alone", async () => {
      const { created, binding } = fakeWorkflow({ [JOB]: "running" });
      await ensureBackfillJobs(getDb(), envWith(binding));
      expect(created).toHaveLength(0);
      expect((await account()).backfillJobId).toBe(JOB);
    });

    it("replaces a job that ended without finishing, or that never existed", async () => {
      for (const statuses of [
        { [JOB]: "errored" },
        { [JOB]: "complete" },
        {},
      ]) {
        await ownJob();
        const { created, binding } = fakeWorkflow(statuses);
        await ensureBackfillJobs(getDb(), envWith(binding));
        expect(created).toHaveLength(1);
        expect((await account()).backfillJobId).toBe(created[0].id);
      }
    });

    it("skips finished imports and unmapped mailboxes", async () => {
      await ownJob(null);
      await getDb()
        .update(gmailAccounts)
        .set({ lastError: "no_personal_inbox" });
      const { created, binding } = fakeWorkflow();
      await ensureBackfillJobs(getDb(), envWith(binding));
      expect(created).toHaveLength(0);

      await getDb().update(gmailAccounts).set({ lastError: null });
      await markBackfillDone();
      await ensureBackfillJobs(getDb(), envWith(binding));
      expect(created).toHaveLength(0);
    });

    it("is a no-op without the Workflow binding", async () => {
      await ownJob(null);
      await ensureBackfillJobs(getDb(), envWithout());
      expect((await account()).backfillJobId).toBeNull();
    });
  });

  describe("runBackfillJob", () => {
    /** Runs every step inline, recording the step names. */
    function fakeStep() {
      const names: string[] = [];
      const step = {
        do: async (
          name: string,
          cfgOrFn: unknown,
          fn?: () => Promise<unknown>,
        ) => {
          names.push(name);
          return (fn ?? (cfgOrFn as () => Promise<unknown>))();
        },
        sleep: async () => {},
      };
      return { names, step };
    }

    function runJob(binding: unknown) {
      const { names, step } = fakeStep();
      const result = runBackfillJob(
        envWith(binding),
        fakeCtx(),
        step as never,
        "acct-1",
        JOB,
      );
      return { names, result };
    }

    it("pages until the window is exhausted, then ends", async () => {
      const ids = Array.from({ length: CHUNK_SIZE * 2 + 5 }, (_, i) => `b${i}`);
      stubGmail({ listIds: ids, messages: oldMessages(ids) });
      const { created, binding } = fakeWorkflow();

      const { names, result } = runJob(binding);

      expect(await result).toEqual({ status: "done", handled: 5 });
      expect(names).toEqual(["chunk 0", "chunk 1", "chunk 2"]);
      expect(created).toHaveLength(0);
      expect(await getDb().select().from(emails)).toHaveLength(ids.length);
    });

    it("hands the account to a successor after its last chunk", async () => {
      const ids = Array.from(
        { length: CHUNK_SIZE * CHUNKS_PER_JOB + 1 },
        (_, i) => `b${i}`,
      );
      stubGmail({ listIds: ids, messages: oldMessages(ids) });
      const { created, binding } = fakeWorkflow();

      const { names, result } = runJob(binding);
      const out = (await result) as { status: string; successor: string };

      expect(out.status).toBe("handed_off");
      expect(names.at(-1)).toBe("hand off");
      expect(created).toHaveLength(1);
      expect(out.successor).toBe(created[0].id);
      expect((await account()).backfillJobId).toBe(created[0].id);
      expect((await account()).backfillCompletedAt).toBeNull();
    });

    it("stops at once when a reconnect has taken the account away", async () => {
      await ownJob(null);
      const listQueries: string[] = [];
      stubGmail({
        listIds: ["b1"],
        listQueries,
        messages: oldMessages(["b1"]),
      });
      const { created, binding } = fakeWorkflow();

      const { names, result } = runJob(binding);

      expect(await result).toMatchObject({ reason: "superseded" });
      expect(names).toEqual(["chunk 0"]);
      expect(listQueries).toHaveLength(0);
      expect(created).toHaveLength(0);
    });
  });
});
