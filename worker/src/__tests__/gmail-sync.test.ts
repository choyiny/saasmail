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
import { syncAccount, syncAllGmailAccounts } from "../lib/gmail/sync";
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
  historyIds?: string[];
  messages?: Record<string, { raw: string; labelIds?: string[] }>;
  historyStatus?: number;
  profileHistoryId?: string;
  /** Refresh token the token endpoint rejects, as a revoked grant would be. */
  revokedRefreshToken?: string;
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
        if (
          opts.revokedRefreshToken &&
          String(init?.body ?? "").includes(
            `refresh_token=${opts.revokedRefreshToken}`,
          )
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
        return json({
          history: (opts.historyIds ?? []).map((id) => ({
            messagesAdded: [{ message: { id } }],
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
});
