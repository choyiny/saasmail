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

/** A message the mailbox SENT: we are the From, the customer is the To. */
function rawSent(opts: {
  from?: string;
  to: string;
  messageId: string;
  subject?: string;
  body?: string;
  cc?: string;
  inReplyTo?: string;
}) {
  return [
    `From: Support <${opts.from ?? "collector@acme.dev"}>`,
    `To: ${opts.to}`,
    ...(opts.cc ? [`Cc: ${opts.cc}`] : []),
    ...(opts.inReplyTo ? [`In-Reply-To: ${opts.inReplyTo}`] : []),
    `Message-ID: ${opts.messageId}`,
    `Subject: ${opts.subject ?? "Re: your question"}`,
    `Content-Type: text/plain; charset=utf-8`,
    ``,
    opts.body ?? "typed from a phone",
  ].join("\r\n");
}

/** An ordinary inbound message, for the no-regression check. */
function rawInbound(opts: {
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

/** Same shape as the engine's own harness: one stub serves every endpoint. */
function stubGmail(opts: {
  /** Message ids, each placed in its OWN history record (ids 9001, 9002, …). */
  historyIds?: string[];
  messages?: Record<string, { raw: string; labelIds?: string[] }>;
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
          historyId: "99999",
        });
      }
      if (url.includes("/users/me/history")) {
        const records = (opts.historyIds ?? []).map((id, i) => ({
          id: String(9001 + i),
          messageIds: [id],
        }));
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

async function seedAccount() {
  const now = Math.floor(Date.now() / 1000);
  await getDb()
    .insert(gmailAccounts)
    .values({
      id: "acct-1",
      emailAddress: "collector@acme.dev",
      refreshTokenEncrypted: await encryptSecret("rt-1", KEY),
      accessToken: null,
      expiresAt: null,
      historyId: "9000",
      connectedBy: "user-1",
      createdAt: now,
      updatedAt: now,
    });
}

async function seedInbox(email = "support@acme.dev") {
  const now = Math.floor(Date.now() / 1000);
  await getDb().insert(senderIdentities).values({
    email,
    displayName: email,
    source: "gmail",
    gmailAccountId: "acct-1",
    gmailGroupAddress: null,
    createdAt: now,
    updatedAt: now,
  });
}

async function seedPerson(email: string, id = "person-1") {
  const now = Math.floor(Date.now() / 1000);
  await getDb().insert(people).values({
    id,
    email,
    name: "Jane",
    lastEmailAt: now,
    unreadCount: 0,
    totalCount: 1,
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

async function sync() {
  return syncAccount(
    getDb(),
    await account(),
    env as unknown as CloudflareBindings,
    fakeCtx(),
    CFG,
  );
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

describe("syncAccount — mirroring the Sent folder", () => {
  it("mirrors a SENT message we did not send from saasmail", async () => {
    await seedAccount();
    await seedInbox();
    await seedPerson("jane@example.com");
    stubGmail({
      historyIds: ["m1"],
      messages: {
        m1: {
          labelIds: ["SENT"],
          raw: rawSent({
            to: "Jane <jane@example.com>",
            messageId: "<s1@acme.dev>",
            subject: "Re: your question",
            body: "answered from the train",
            inReplyTo: "<orig@example.com>",
          }),
        },
      },
    });

    const res = await sync();
    expect(res.ingested).toBe(1);
    expect(res.failed).toBe(0);

    const rows = await getDb().select().from(sentEmails);
    expect(rows).toHaveLength(1);
    expect(rows[0].toAddress).toBe("jane@example.com");
    expect(rows[0].subject).toBe("Re: your question");
    expect(rows[0].bodyText).toContain("answered from the train");
    expect(rows[0].personId).toBe("person-1");
    expect(rows[0].fromAddress).toBe("support@acme.dev");
    expect(rows[0].gmailMessageId).toBe("m1");
    expect(rows[0].gmailThreadId).toBe("t-m1");
    expect(rows[0].messageId).toBe("<s1@acme.dev>");
    expect(rows[0].inReplyTo).toBe("<orig@example.com>");
    expect(rows[0].sentAt).toBeGreaterThan(0);

    // A mirrored Sent message is not inbound mail.
    expect(await getDb().select().from(emails)).toHaveLength(0);
  });

  it("suppresses the echo of a reply saasmail itself sent through Gmail", async () => {
    await seedAccount();
    await seedInbox();
    await seedPerson("jane@example.com");

    // Task 4 wrote this row at send time, stamping Gmail's returned id.
    const now = Math.floor(Date.now() / 1000);
    await getDb().insert(sentEmails).values({
      id: "our-own-send",
      personId: "person-1",
      fromAddress: "support@acme.dev",
      toAddress: "jane@example.com",
      subject: "Re: your question",
      bodyHtml: "<p>sent by saasmail</p>",
      bodyText: "sent by saasmail",
      messageId: "<s1@acme.dev>",
      status: "sent",
      gmailMessageId: "m1",
      gmailThreadId: "t-m1",
      sentAt: now,
      createdAt: now,
    });

    stubGmail({
      historyIds: ["m1"],
      messages: {
        m1: {
          labelIds: ["SENT"],
          raw: rawSent({
            to: "jane@example.com",
            messageId: "<s1@acme.dev>",
          }),
        },
      },
    });

    const res = await sync();
    expect(res.ingested).toBe(0);
    expect(res.skipped).toBe(1);
    expect(res.failed).toBe(0);

    // The count is the assertion: without suppression every reply a user
    // sends would show up on the timeline twice.
    const rows = await getDb().select().from(sentEmails);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe("our-own-send");
  });

  it("is idempotent — replaying the same Sent message mirrors once", async () => {
    await seedAccount();
    await seedInbox();
    const opts = {
      historyIds: ["m1"],
      messages: {
        m1: {
          labelIds: ["SENT"],
          raw: rawSent({
            to: "jane@example.com",
            messageId: "<s1@acme.dev>",
          }),
        },
      },
    };

    stubGmail(opts);
    await sync();

    // Rewind the cursor so the same record is replayed.
    await getDb()
      .update(gmailAccounts)
      .set({ historyId: "9000" })
      .where(eq(gmailAccounts.id, "acct-1"));
    stubGmail(opts);
    const second = await sync();

    expect(second.ingested).toBe(0);
    expect(await getDb().select().from(sentEmails)).toHaveLength(1);
  });

  it("stores a row with no personId when the recipient is unknown", async () => {
    await seedAccount();
    await seedInbox();
    stubGmail({
      historyIds: ["m1"],
      messages: {
        m1: {
          labelIds: ["SENT"],
          raw: rawSent({
            to: "stranger@example.com",
            messageId: "<s2@acme.dev>",
          }),
        },
      },
    });

    const res = await sync();
    expect(res.ingested).toBe(1);
    expect(res.failed).toBe(0);

    const rows = await getDb().select().from(sentEmails);
    expect(rows).toHaveLength(1);
    expect(rows[0].toAddress).toBe("stranger@example.com");
    expect(rows[0].personId).toBeNull();
  });

  it("carries Cc recipients onto the mirrored row", async () => {
    await seedAccount();
    await seedInbox();
    stubGmail({
      historyIds: ["m1"],
      messages: {
        m1: {
          labelIds: ["SENT"],
          raw: rawSent({
            to: "jane@example.com",
            cc: "Bob <bob@example.com>",
            messageId: "<s3@acme.dev>",
          }),
        },
      },
    });

    await sync();
    const rows = await getDb().select().from(sentEmails);
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0].cc ?? "[]")).toEqual([
      { email: "bob@example.com", name: "Bob" },
    ]);
  });
});

describe("syncAccount — labels that stay skipped", () => {
  for (const label of ["DRAFT", "TRASH", "SPAM"]) {
    it(`still skips a message carrying ${label}`, async () => {
      await seedAccount();
      await seedInbox();
      stubGmail({
        historyIds: ["m1"],
        messages: {
          m1: {
            labelIds: [label],
            raw: rawSent({
              to: "jane@example.com",
              messageId: "<skip@acme.dev>",
            }),
          },
        },
      });

      const res = await sync();
      expect(res.ingested).toBe(0);
      expect(res.skipped).toBe(1);
      expect(await getDb().select().from(sentEmails)).toHaveLength(0);
      expect(await getDb().select().from(emails)).toHaveLength(0);
    });
  }

  it("skips a sent message that was later trashed", async () => {
    await seedAccount();
    await seedInbox();
    stubGmail({
      historyIds: ["m1"],
      messages: {
        m1: {
          labelIds: ["SENT", "TRASH"],
          raw: rawSent({
            to: "jane@example.com",
            messageId: "<trashed@acme.dev>",
          }),
        },
      },
    });

    const res = await sync();
    expect(res.skipped).toBe(1);
    expect(await getDb().select().from(sentEmails)).toHaveLength(0);
  });
});

describe("syncAccount — the inbound path is untouched", () => {
  it("still ingests a non-SENT message into emails", async () => {
    await seedAccount();
    await seedInbox();
    stubGmail({
      historyIds: ["m1"],
      messages: {
        m1: {
          raw: rawInbound({
            from: "jane@example.com",
            deliveredTo: "support@acme.dev",
            messageId: "<g1@example.com>",
          }),
        },
      },
    });

    const res = await sync();
    expect(res.ingested).toBe(1);

    const rows = await getDb().select().from(emails);
    expect(rows).toHaveLength(1);
    expect(rows[0].recipient).toBe("support@acme.dev");
    expect(rows[0].subject).toBe("Synced subject");
    expect(rows[0].gmailMessageId).toBe("m1");
    expect(rows[0].gmailThreadId).toBe("t-m1");
    expect((await account()).historyId).toBe("9100");

    // Inbound mail must never land in the sent mirror.
    expect(await getDb().select().from(sentEmails)).toHaveLength(0);
  });

  it("mirrors and ingests side by side in one run", async () => {
    await seedAccount();
    await seedInbox();
    stubGmail({
      historyIds: ["in1", "out1"],
      messages: {
        in1: {
          raw: rawInbound({
            from: "jane@example.com",
            deliveredTo: "support@acme.dev",
            messageId: "<g1@example.com>",
          }),
        },
        out1: {
          labelIds: ["SENT"],
          raw: rawSent({
            to: "jane@example.com",
            messageId: "<s1@acme.dev>",
          }),
        },
      },
    });

    const res = await sync();
    expect(res.ingested).toBe(2);
    expect(res.failed).toBe(0);
    expect(await getDb().select().from(emails)).toHaveLength(1);

    const sent = await getDb().select().from(sentEmails);
    expect(sent).toHaveLength(1);
    // The inbound message created the person; the mirror found them.
    const [person] = await getDb()
      .select()
      .from(people)
      .where(eq(people.email, "jane@example.com"));
    expect(sent[0].personId).toBe(person.id);
  });
});
