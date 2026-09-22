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
import { syncAccount } from "../lib/gmail/sync";
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
}) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const json = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), {
          status,
          headers: { "content-type": "application/json" },
        });

      if (url.includes("oauth2.googleapis.com/token")) {
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

async function seedAccount(historyId: string | null = "9000") {
  const now = Math.floor(Date.now() / 1000);
  await getDb()
    .insert(gmailAccounts)
    .values({
      id: "acct-1",
      emailAddress: "collector@acme.dev",
      refreshTokenEncrypted: await encryptSecret("rt-1", KEY),
      accessToken: null,
      expiresAt: null,
      historyId,
      connectedBy: "user-1",
      createdAt: now,
      updatedAt: now,
    });
}

async function seedInbox(email: string, gmailGroupAddress: string | null) {
  const now = Math.floor(Date.now() / 1000);
  await getDb().insert(senderIdentities).values({
    email,
    displayName: email,
    source: "gmail",
    gmailAccountId: "acct-1",
    gmailGroupAddress,
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
