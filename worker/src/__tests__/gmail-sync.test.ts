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
        const startId = new URL(url).searchParams.get("startHistoryId");
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
        const records = Number.isFinite(from)
          ? allRecords.filter((r) => Number(r.id) > from)
          : allRecords;
        return json({
          history: records.map((r) => ({
            id: r.id,
            messagesAdded: r.messageIds.map((id) => ({ message: { id } })),
          })),
          historyId: "9100",
        });
      }
      if (url.includes("/users/me/messages/")) {
        const id = decodeURIComponent(url.split("/messages/")[1].split("?")[0]);
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

  it("skips a message that resolves to no configured inbox", async () => {
    await seedAccount();
    // Only a GROUP mapping, so there is no personal mailbox to route to.
    // `resolvePersonalInbox` returns null and the message is skipped rather
    // than guessed at. (The headers below are inert — this slice inspects
    // none of them, because List-ID and Delivered-To are sender-forgeable.)
    await seedInbox("support@acme.dev", "team@acme.dev");
    stubGmail({
      historyIds: ["m1"],
      messages: {
        m1: {
          raw: rawEmail({
            from: "jane@example.com",
            deliveredTo: "nobody@acme.dev",
            messageId: "<n1@example.com>",
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
    expect((await account()).historyId).toBe("9100");
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
    expect((await account()).historyId).toBe("9100");
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
    expect((await account()).historyId).toBe("77777");
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

    await expect(
      syncAllGmailAccounts(
        getDb(),
        env as unknown as CloudflareBindings,
        fakeCtx(),
      ),
    ).resolves.toBeUndefined();

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
});
