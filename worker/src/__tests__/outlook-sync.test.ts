import {
  describe,
  it,
  expect,
  beforeAll,
  beforeEach,
  afterEach,
  vi,
} from "vitest";
import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { outlookAccounts } from "../db/outlook-accounts.schema";
import { gmailAccounts } from "../db/gmail-accounts.schema";
import { senderIdentities } from "../db/sender-identities.schema";
import { emails } from "../db/emails.schema";
import { sentEmails } from "../db/sent-emails.schema";
import { decryptSecret, encryptSecret } from "../lib/crypto";
import {
  runOutlookBackfillChunk,
  syncOutlookAccount,
} from "../lib/outlook/sync";
import { getOutlookAccessToken } from "../lib/outlook/token";
import { ensureBackfillJobs } from "../lib/gmail/backfill-job";
import { saveProviderConfig } from "../lib/oauth-providers";
import { MAX_MESSAGES_PER_RUN } from "../lib/gmail/sync";
import { getDb, applyMigrations, cleanDb } from "./helpers";
import { armLiveSteps } from "./mailbox-ingest-fixture";

const KEY = "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=";
const CFG = {
  clientId: "ms-client",
  clientSecret: "ms-secret",
  encryptionKey: KEY,
  tenant: null,
};
const MAILBOX = "jane@contoso.com";
const SYNC_FROM = 1_760_000_000;

beforeAll(async () => {
  await applyMigrations();
});

beforeEach(async () => {
  await cleanDb();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function fakeCtx(): ExecutionContext {
  return {
    waitUntil: () => {},
    passThroughOnException: () => {},
    props: {},
  } as unknown as ExecutionContext;
}

function mime(opts: {
  from: string;
  to: string;
  messageId: string;
  subject?: string;
}) {
  return [
    `From: ${opts.from}`,
    `To: ${opts.to}`,
    `Message-ID: ${opts.messageId}`,
    `Date: Tue, 14 Oct 2025 10:00:00 +0000`,
    `Subject: ${opts.subject ?? "Hello from Outlook"}`,
    `Content-Type: text/plain; charset=utf-8`,
    ``,
    `body text`,
  ].join("\r\n");
}

type Item = {
  id: string;
  removed?: boolean;
  isDraft?: boolean;
  receivedDateTime?: string;
  parentFolderId?: string;
};

/**
 * A fake Microsoft Graph. Delta rounds are given as pages per folder; a
 * `deltaLink` follows the last page. `@odata.nextLink`s are opaque URLs
 * carrying the page index.
 */
function stubGraph(opts: {
  inbox?: Item[][];
  sent?: Item[][];
  /** The listing the one-year import walks, as pages. */
  list?: Item[][];
  mimes?: Record<string, string>;
  /** Delta URLs answered with 410 Gone. */
  expiredLinks?: string[];
  failMime?: string[];
  /** What the token endpoint returns as the new refresh token. */
  rotatedRefreshToken?: string;
  requests?: string[];
}) {
  const fn = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    opts.requests?.push(url);
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });

    if (new URL(url).hostname === "login.microsoftonline.com") {
      return json({
        access_token: "at-new",
        expires_in: 3600,
        ...(opts.rotatedRefreshToken
          ? { refresh_token: opts.rotatedRefreshToken }
          : {}),
      });
    }
    if (opts.expiredLinks?.includes(url)) {
      return json({ error: { code: "SyncStateNotFound" } }, 410);
    }
    const u = new URL(url);
    const folderMatch = u.pathname.match(/mailFolders\/(\w+)\/messages\/delta/);
    if (folderMatch) {
      const pages = (folderMatch[1] === "inbox" ? opts.inbox : opts.sent) ?? [
        [],
      ];
      const page = Number(u.searchParams.get("page") ?? "0");
      if (u.searchParams.get("$deltatoken")) {
        return json({
          value: [],
          "@odata.deltaLink": `${u.origin}${u.pathname}?$deltatoken=again`,
        });
      }
      const items = pages[page] ?? [];
      const more = page + 1 < pages.length;
      return json({
        value: items.map((i) =>
          i.removed
            ? { id: i.id, "@removed": { reason: "deleted" } }
            : {
                id: i.id,
                isDraft: i.isDraft ?? false,
                receivedDateTime: i.receivedDateTime ?? "2025-10-14T10:00:00Z",
              },
        ),
        ...(more
          ? {
              "@odata.nextLink": `${u.origin}${u.pathname}?page=${page + 1}`,
            }
          : {
              "@odata.deltaLink": `${u.origin}${u.pathname}?$deltatoken=t1`,
            }),
      });
    }
    const folderGet = u.pathname.match(/\/me\/mailFolders\/(\w+)$/);
    if (folderGet) return json({ id: `folder-${folderGet[1]}` });
    if (u.pathname.endsWith("/me/messages")) {
      const page = Number(u.searchParams.get("page") ?? "0");
      const pages = opts.list ?? [[]];
      const more = page + 1 < pages.length;
      return json({
        value: (pages[page] ?? []).map((i) => ({
          id: i.id,
          isDraft: i.isDraft ?? false,
          parentFolderId: i.parentFolderId ?? "folder-inbox",
          receivedDateTime: i.receivedDateTime ?? "2025-06-01T00:00:00Z",
        })),
        ...(more
          ? { "@odata.nextLink": `${u.origin}${u.pathname}?page=${page + 1}` }
          : {}),
      });
    }
    const mimeMatch = u.pathname.match(/\/me\/messages\/(.+)\/\$value$/);
    if (mimeMatch) {
      const id = decodeURIComponent(mimeMatch[1]);
      if (opts.failMime?.includes(id)) return json({ error: {} }, 500);
      const body = opts.mimes?.[id];
      if (!body) return json({ error: {} }, 404);
      return new Response(body, { status: 200 });
    }
    throw new Error(`unexpected fetch in test: ${url}`);
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

async function seedAccount(
  over: Partial<typeof outlookAccounts.$inferInsert> = {},
) {
  const now = Math.floor(Date.now() / 1000);
  await getDb()
    .insert(outlookAccounts)
    .values({
      id: "ol-1",
      emailAddress: MAILBOX,
      refreshTokenEncrypted: await encryptSecret("rt-1", KEY),
      accessToken: "cached-at",
      expiresAt: now + 3600,
      syncFrom: SYNC_FROM,
      connectedBy: "user-1",
      createdAt: now,
      updatedAt: now,
      ...over,
    });
}

async function seedInbox(email = MAILBOX, accountId = "ol-1") {
  const now = Math.floor(Date.now() / 1000);
  await getDb().insert(senderIdentities).values({
    email,
    displayName: email,
    source: "outlook",
    outlookAccountId: accountId,
    createdAt: now,
    updatedAt: now,
  });
}

async function account() {
  const [row] = await getDb()
    .select()
    .from(outlookAccounts)
    .where(eq(outlookAccounts.id, "ol-1"));
  return row;
}

async function run(
  e: CloudflareBindings = env as unknown as CloudflareBindings,
) {
  return syncOutlookAccount(getDb(), await account(), e, fakeCtx(), CFG);
}

/** The test env without the import Workflow, or with a stand-in for it. */
function envWith(binding: unknown): CloudflareBindings {
  return {
    ...(env as unknown as CloudflareBindings),
    GMAIL_BACKFILL: binding,
  } as unknown as CloudflareBindings;
}

const inbound = (id: string, from = "customer@example.com") =>
  mime({ from, to: MAILBOX, messageId: `<${id}@example.com>` });

describe("Outlook live sync", () => {
  beforeEach(async () => {
    await seedAccount();
    await seedInbox();
  });

  it("starts from the connection time and files new Inbox mail", async () => {
    const requests: string[] = [];
    stubGraph({
      inbox: [[{ id: "m1" }]],
      mimes: { m1: inbound("m1") },
      requests,
    });

    const res = await run();

    expect(res.ingested).toBe(1);
    const first = new URL(
      requests.find((r) => r.includes("/mailFolders/inbox/messages/delta"))!,
    );
    expect(first.searchParams.get("$filter")).toBe(
      "receivedDateTime ge 2025-10-09T08:53:20Z",
    );
    const rows = await getDb().select().from(emails);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      recipient: MAILBOX,
      outlookMessageId: "m1",
      isRead: 0,
    });
    const row = await account();
    expect(row.inboxCursor).toMatch(/\$deltatoken=t1$/);
    expect(row.lastSyncedAt).not.toBeNull();
    expect(row.lastError).toBeNull();
  });

  it("resumes from the saved delta link and never files a message twice", async () => {
    stubGraph({ inbox: [[{ id: "m1" }]], mimes: { m1: inbound("m1") } });
    await run();
    // Graph offers the same message again (a read-state change does this).
    await getDb()
      .update(outlookAccounts)
      .set({ inboxCursor: null, inboxCursorOffset: 0 });
    await run();
    expect(await getDb().select().from(emails)).toHaveLength(1);
  });

  it("skips drafts and removals, and mirrors Sent Items as sent mail", async () => {
    stubGraph({
      inbox: [
        [
          { id: "gone", removed: true },
          { id: "draft", isDraft: true },
        ],
      ],
      sent: [[{ id: "s1" }]],
      mimes: {
        s1: mime({
          from: MAILBOX,
          to: "customer@example.com",
          messageId: "<s1@contoso.com>",
        }),
      },
    });

    const res = await run();

    expect(res.mirrored).toBe(1);
    expect(await getDb().select().from(emails)).toHaveLength(0);
    const sent = await getDb().select().from(sentEmails);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      fromAddress: MAILBOX,
      toAddress: "customer@example.com",
      outlookMessageId: "s1",
    });
  });

  it("does not mirror a reply saasmail sent itself, matched by Message-ID", async () => {
    const now = Math.floor(Date.now() / 1000);
    await getDb().insert(sentEmails).values({
      id: "ours",
      fromAddress: MAILBOX,
      toAddress: "customer@example.com",
      subject: "Re: hi",
      messageId: "<ours@contoso.com>",
      status: "sent",
      sentAt: now,
      createdAt: now,
    });
    stubGraph({
      sent: [[{ id: "s-ours" }]],
      mimes: {
        "s-ours": mime({
          from: MAILBOX,
          to: "customer@example.com",
          messageId: "<ours@contoso.com>",
        }),
      },
    });

    await run();

    expect(await getDb().select().from(sentEmails)).toHaveLength(1);
  });

  it("re-reads from the last sync when Graph has expired the delta link — no gap", async () => {
    const expired =
      "https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?$deltatoken=old";
    await getDb()
      .update(outlookAccounts)
      .set({ inboxCursor: expired, lastSyncedAt: 1_760_100_000 });
    const requests: string[] = [];
    stubGraph({
      expiredLinks: [expired],
      inbox: [[{ id: "m1" }]],
      mimes: { m1: inbound("m1") },
      requests,
    });

    const res = await run();

    expect(res.ingested).toBe(1);
    const reseed = requests
      .map((r) => new URL(r))
      .find((u) => u.searchParams.get("$filter"));
    // Five minutes before the last sync, so nothing in between is missed.
    expect(reseed!.searchParams.get("$filter")).toBe(
      "receivedDateTime ge 2025-10-10T12:35:00Z",
    );
    expect((await account()).lastGapAt).toBeNull();
  });

  it("stops at its budget mid-page and resumes at the same message", async () => {
    const ids = Array.from(
      { length: MAX_MESSAGES_PER_RUN + 3 },
      (_, i) => `m${i}`,
    );
    stubGraph({
      inbox: [ids.map((id) => ({ id }))],
      mimes: Object.fromEntries(ids.map((id) => [id, inbound(id)])),
    });

    const first = await run();
    expect(first.ingested).toBe(MAX_MESSAGES_PER_RUN);
    expect((await account()).inboxCursorOffset).toBe(MAX_MESSAGES_PER_RUN);

    const second = await run();
    expect(second.ingested).toBe(3);
    expect(await getDb().select().from(emails)).toHaveLength(ids.length);
  });

  it("stalls at a message that fails, keeping its place", async () => {
    stubGraph({
      inbox: [[{ id: "m1" }, { id: "bad" }, { id: "m2" }]],
      mimes: { m1: inbound("m1"), m2: inbound("m2") },
      failMime: ["bad"],
    });

    const res = await run();

    expect(res.failed).toBe(1);
    const row = await account();
    expect(row.lastError).toBe("message_failed:bad");
    expect(row.inboxCursorOffset).toBe(1);
    expect(await getDb().select().from(emails)).toHaveLength(1);
  });

  it("reads nothing until an inbox is mapped", async () => {
    await getDb().delete(senderIdentities);
    const requests: string[] = [];
    stubGraph({ inbox: [[{ id: "m1" }]], requests });

    await run();

    expect(
      requests.filter((r) => new URL(r).hostname === "graph.microsoft.com"),
    ).toHaveLength(0);
    expect((await account()).lastError).toBe("no_personal_inbox");
  });
});

describe("Outlook tokens", () => {
  it("stores the refresh token Microsoft rotates in", async () => {
    await seedAccount({ accessToken: null, expiresAt: null });
    stubGraph({ rotatedRefreshToken: "rt-2" });

    const token = await getOutlookAccessToken(getDb(), "ol-1", CFG);

    expect(token).toBe("at-new");
    const row = await account();
    expect(await decryptSecret(row.refreshTokenEncrypted, KEY)).toBe("rt-2");
  });
});

describe("Outlook one-year import", () => {
  const JOB = "outlook-backfill-ol-1-1";

  beforeEach(async () => {
    await seedAccount({ backfillJobId: JOB });
    await seedInbox();
  });

  function chunk(budget = 50, jobId = JOB) {
    return runOutlookBackfillChunk(
      getDb(),
      env as unknown as CloudflareBindings,
      fakeCtx(),
      CFG,
      "ol-1",
      jobId,
      budget,
    );
  }

  it("imports only the Inbox and Sent Items, quietly, newest first", async () => {
    const requests: string[] = [];
    stubGraph({
      list: [
        [
          { id: "in1", receivedDateTime: "2025-09-01T00:00:00Z" },
          {
            id: "sent1",
            parentFolderId: "folder-sentitems",
            receivedDateTime: "2025-08-01T00:00:00Z",
          },
          { id: "junk1", parentFolderId: "folder-junkemail" },
        ],
        [
          {
            id: "archived1",
            parentFolderId: "folder-archive",
            receivedDateTime: "2025-03-01T00:00:00Z",
          },
        ],
      ],
      mimes: {
        in1: inbound("in1"),
        archived1: inbound("archived1"),
        sent1: mime({
          from: MAILBOX,
          to: "customer@example.com",
          messageId: "<sent1@contoso.com>",
        }),
      },
      requests,
    });

    const res = await chunk();

    expect(res).toEqual({ status: "done", handled: 4 });
    const inbox = await getDb().select().from(emails);
    expect(inbox.map((r) => r.outlookMessageId)).toEqual(["in1"]);
    expect(inbox.every((r) => r.isRead === 1)).toBe(true);
    expect(await getDb().select().from(sentEmails)).toHaveLength(1);
    expect(requests.some((r) => r.includes("junk1/$value"))).toBe(false);
    // Archive is a folder like any other outside the Inbox: never fetched.
    expect(requests.some((r) => r.includes("archived1/$value"))).toBe(false);

    const listing = new URL(
      requests.find((r) => new URL(r).pathname.endsWith("/me/messages"))!,
    );
    expect(listing.searchParams.get("$orderby")).toBe("receivedDateTime desc");

    const row = await account();
    expect(row.backfillCompletedAt).not.toBeNull();
    expect(row.backfillCount).toBe(4);
    expect(row.backfillReached).toBe(Date.UTC(2025, 2, 1) / 1000);
  });

  it("resumes mid-page from the saved link and offset", async () => {
    const ids = ["a", "b", "c"];
    stubGraph({
      list: [ids.map((id) => ({ id }))],
      mimes: Object.fromEntries(ids.map((id) => [id, inbound(id)])),
    });

    expect(await chunk(2)).toEqual({ status: "continue", handled: 2 });
    expect((await account()).backfillOffset).toBe(2);
    expect(await chunk(2)).toEqual({ status: "done", handled: 1 });
    expect(await getDb().select().from(emails)).toHaveLength(3);
  });

  it("does nothing as a job that no longer owns the mailbox", async () => {
    const requests: string[] = [];
    stubGraph({ list: [[{ id: "a" }]], requests });
    expect(await chunk(50, "someone-else")).toMatchObject({
      status: "stopped",
      reason: "superseded",
    });
    expect(requests).toHaveLength(0);
  });
});

describe("one import at a time, across Gmail and Outlook", () => {
  function fakeWorkflow(statuses: Record<string, string> = {}) {
    const created: Array<{ id: string; params: unknown }> = [];
    const binding = {
      create: async (o: { id: string; params: unknown }) => {
        created.push(o);
        statuses[o.id] = "queued";
        return { id: o.id };
      },
      get: async (id: string) => {
        if (!(id in statuses)) throw new Error("instance.not_found");
        return { status: async () => ({ status: statuses[id] }) };
      },
    };
    return { created, binding };
  }

  beforeEach(async () => {
    await saveProviderConfig(
      getDb(),
      env,
      "microsoft",
      { clientId: "ms-client", clientSecret: "ms-secret" },
      null,
    );
    await seedAccount();
    await seedInbox();
  });

  it("starts an Outlook import with its provider when nothing else is importing", async () => {
    const { created, binding } = fakeWorkflow();
    await ensureBackfillJobs(getDb(), envWith(binding));
    expect(created).toHaveLength(1);
    expect(created[0].params).toEqual({
      accountId: "ol-1",
      provider: "microsoft",
    });
    expect(created[0].id).toMatch(/^outlook-backfill-ol-1-\d+$/);
    expect((await account()).backfillJobId).toBe(created[0].id);
  });

  it("waits while a Gmail import holds the turn", async () => {
    const now = Math.floor(Date.now() / 1000);
    await getDb()
      .insert(gmailAccounts)
      .values({
        id: "g-1",
        emailAddress: "ops@acme.dev",
        refreshTokenEncrypted: await encryptSecret("rt", KEY),
        historyId: "1",
        backfillJobId: "gmail-backfill-g-1-1",
        createdAt: now - 100,
        updatedAt: now,
      });
    const { created, binding } = fakeWorkflow({
      "gmail-backfill-g-1-1": "running",
    });

    await ensureBackfillJobs(getDb(), envWith(binding));

    expect(created).toHaveLength(0);
    expect((await account()).backfillJobId).toBeNull();
  });
});

describe("Outlook sync and the fork's ingestion steps", () => {
  const SENDER = "customer@example.com";
  const JOB = "outlook-backfill-ol-1-1";

  beforeEach(async () => {
    await seedAccount({ backfillJobId: JOB });
    await seedInbox();
  });

  it("a live message is stored once, with its Outlook id, and runs the live steps", async () => {
    stubGraph({
      inbox: [[{ id: "live1" }]],
      mimes: { live1: inbound("live1") },
    });
    const armed = await armLiveSteps({ inbox: MAILBOX, sender: SENDER });
    try {
      await syncOutlookAccount(
        getDb(),
        await account(),
        env as unknown as CloudflareBindings,
        armed.ctx,
        CFG,
      );
      const seen = await armed.observe();

      expect(seen.stored).toHaveLength(1);
      expect(seen.stored[0].rawR2Key).toBeTruthy();
      expect(seen.stored[0].outlookMessageId).toBe("live1");
      // The Outlook id is in the insert: its creation and the rule's archive,
      // no follow-up update of the row.
      expect(seen.emailChanges).toEqual([
        { object_id: `received:${seen.stored[0].id}`, op: "c" },
        { object_id: `received:${seen.stored[0].id}`, op: "u" },
      ]);
      expect(seen.webhookCalls).toBe(1);
      expect(seen.ruleMatches).toBe(1);
      expect(seen.suggestedReplies).toBe(1);
      expect(seen.pushes).toBeGreaterThan(0);
      expect(seen.snoozed).toBe(false);
      expect(seen.sequenceStatus).toBe("cancelled");
    } finally {
      armed.restore();
    }
  });

  it("a historical message is stored read, at its own time, and runs none of them", async () => {
    stubGraph({
      list: [[{ id: "old1", receivedDateTime: "2025-09-01T00:00:00Z" }]],
      mimes: { old1: inbound("old1") },
    });
    const armed = await armLiveSteps({ inbox: MAILBOX, sender: SENDER });
    try {
      await runOutlookBackfillChunk(
        getDb(),
        env as unknown as CloudflareBindings,
        armed.ctx,
        CFG,
        "ol-1",
        JOB,
        50,
      );
      const seen = await armed.observe();

      expect(seen.stored).toHaveLength(1);
      expect(seen.stored[0]).toMatchObject({
        outlookMessageId: "old1",
        isRead: 1,
        spamProbability: null,
      });
      // Its own time (Graph's receivedDateTime), not the import's.
      expect(seen.stored[0].receivedAt).toBe(Date.UTC(2025, 8, 1) / 1000);
      expect(seen.spamTraining).toBe(0);
      expect(seen.ruleMatches).toBe(0);
      expect(seen.suggestedReplies).toBe(0);
      expect(seen.snoozed).toBe(true);
      expect(seen.audit).toEqual([]);
      expect(seen.pushes).toBe(0);
      expect(seen.webhookCalls).toBe(0);
      // Push, webhook and forward all start in the background: none did.
      expect(seen.backgroundTasks).toBe(0);
      expect(seen.sequenceStatus).toBe("active");
    } finally {
      armed.restore();
    }
  });
});
