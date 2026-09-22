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
  /** Omitted entirely when absent, so a Bcc-only send can be built. */
  to?: string;
  messageId: string;
  subject?: string;
  body?: string;
  cc?: string;
  bcc?: string;
  inReplyTo?: string;
  date?: string;
}) {
  return [
    `From: Support <${opts.from ?? "collector@acme.dev"}>`,
    ...(opts.to ? [`To: ${opts.to}`] : []),
    ...(opts.date ? [`Date: ${opts.date}`] : []),
    ...(opts.cc ? [`Cc: ${opts.cc}`] : []),
    ...(opts.bcc ? [`Bcc: ${opts.bcc}`] : []),
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
  cc?: string;
}) {
  return [
    `From: ${opts.from}`,
    `To: ${opts.deliveredTo}`,
    ...(opts.cc ? [`Cc: ${opts.cc}`] : []),
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
            date: "Tue, 15 Apr 2025 09:30:00 +0000",
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
    // The exact instant from the Date: header, not "some positive number".
    expect(rows[0].sentAt).toBe(1744709400); // 2025-04-15T09:30:00Z

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

  it("dates the row from the message, not from the sync", async () => {
    await seedAccount();
    await seedInbox();
    stubGmail({
      historyIds: ["m1"],
      messages: {
        m1: {
          labelIds: ["SENT"],
          raw: rawSent({
            to: "jane@example.com",
            messageId: "<s4@acme.dev>",
            // Well in the past: a backlog drained after an outage must not
            // file every mirrored reply at the moment it was pulled, or the
            // replies sort after the mail they answer.
            date: "Tue, 15 Apr 2025 09:30:00 +0000",
          }),
        },
      },
    });

    const before = Math.floor(Date.now() / 1000);
    await sync();

    const rows = await getDb().select().from(sentEmails);
    expect(rows).toHaveLength(1);
    expect(rows[0].sentAt).toBe(
      Math.floor(Date.parse("2025-04-15T09:30:00Z") / 1000),
    );
    expect(rows[0].sentAt).toBeLessThan(before);
    // The row itself still records when it landed here.
    expect(rows[0].createdAt).toBeGreaterThanOrEqual(before);
  });

  it("falls back to the sync time ONLY when the Date header is missing or junk", async () => {
    await seedAccount();
    await seedInbox();
    stubGmail({
      // The third message is the control: without it this test would pass
      // just as happily if the Date header were never parsed at all.
      historyIds: ["m1", "m2", "m3"],
      messages: {
        m1: {
          labelIds: ["SENT"],
          raw: rawSent({
            to: "jane@example.com",
            messageId: "<s5@acme.dev>",
          }),
        },
        m2: {
          labelIds: ["SENT"],
          raw: rawSent({
            to: "bob@example.com",
            messageId: "<s6@acme.dev>",
            date: "not a date at all",
          }),
        },
        m3: {
          labelIds: ["SENT"],
          raw: rawSent({
            to: "carol@example.com",
            messageId: "<s7@acme.dev>",
            date: "Wed, 01 Jan 2020 00:00:00 +0000",
          }),
        },
      },
    });

    const before = Math.floor(Date.now() / 1000);
    const res = await sync();
    expect(res.ingested).toBe(3);
    expect(res.failed).toBe(0);

    const byTo = new Map(
      (await getDb().select().from(sentEmails)).map((r) => [r.toAddress, r]),
    );
    expect(byTo.size).toBe(3);
    // No header, and unparseable: the sync time.
    expect(byTo.get("jane@example.com")!.sentAt).toBeGreaterThanOrEqual(before);
    expect(byTo.get("bob@example.com")!.sentAt).toBeGreaterThanOrEqual(before);
    // Parseable: that instant exactly, and nowhere near the sync time.
    expect(byTo.get("carol@example.com")!.sentAt).toBe(1577836800);
    expect(byTo.get("carol@example.com")!.sentAt).toBeLessThan(before);
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

describe("syncAccount — picking the counterparty off the header", () => {
  /**
   * Each case is the raw `To:` value and the address that must end up on the
   * row. The first is the regression: matching `<…>` across the WHOLE header
   * picks Bob — the last-written address — and files the reply on the wrong
   * customer's timeline.
   */
  const cases: Array<[label: string, to: string, expected: string | null]> = [
    [
      "a bare address followed by a bracketed one",
      'jane@example.com, "Bob" <bob@x.com>',
      "jane@example.com",
    ],
    ["a bare single address", "jane@example.com", "jane@example.com"],
    ["a single bracketed address", "<jane@example.com>", "jane@example.com"],
    [
      "a display name with a comma inside quotes",
      '"Smith, Jane" <jane@x.com>',
      "jane@x.com",
    ],
    [
      "leading whitespace before the display name",
      "   Jane Doe <jane@example.com>",
      "jane@example.com",
    ],
    [
      "two bracketed addresses",
      "Jane <jane@example.com>, Bob <bob@x.com>",
      "jane@example.com",
    ],
    // A display name may legally contain a whole address. The real recipient
    // is the bracketed one OUTSIDE the quotes.
    [
      "a bracketed address hidden inside the display name",
      '"Bob <bob@x.com>" <jane@example.com>',
      "jane@example.com",
    ],
    ["doubled quotes", '""Jane"" <jane@example.com>', "jane@example.com"],
    [
      "a quoted display name with no brackets",
      '"Jane" jane@example.com',
      "jane@example.com",
    ],
    [
      "a trailing backslash outside quotes",
      "Jane <jane@example.com>\\",
      "jane@example.com",
    ],
    // First-written wins, which is the whole contract of this function.
    [
      "two bracketed addresses in ONE entry",
      "Jane <jane@example.com> <bob@x.com>",
      "jane@example.com",
    ],
    ["mixed case", "Jane <JANE@Example.COM>", "jane@example.com"],
    [
      "a very long list",
      Array.from(
        { length: 200 },
        (_, i) => `User${i} <u${i}@example.com>`,
      ).join(", "),
      "u0@example.com",
    ],
  ];

  for (const [label, to, expected] of cases) {
    it(`takes the first recipient from ${label}`, async () => {
      await seedAccount();
      await seedInbox();
      stubGmail({
        historyIds: ["m1"],
        messages: {
          m1: {
            labelIds: ["SENT"],
            raw: rawSent({ to, messageId: "<c1@acme.dev>" }),
          },
        },
      });

      await sync();
      const rows = await getDb().select().from(sentEmails);
      expect(rows).toHaveLength(1);
      expect(rows[0].toAddress).toBe(expected);
    });
  }

  /**
   * Headers that must yield NOTHING. Every one of these once had, or could
   * have had, a plausible-looking answer — and a plausible-looking answer to
   * a malformed header is how a customer's reply ends up on someone else's
   * timeline. A skipped mirror costs one row; a wrong one costs trust.
   */
  const rejects: Array<[label: string, to: string]> = [
    // The round-3 regression: one stray quote suppresses every delimiter, so
    // a whole-header search would hand back Bob — the LAST address written.
    ["an unclosed quote", '"Jane jane@example.com, Bob <bob@x.com>'],
    ["an unclosed angle bracket", "Jane <jane@example.com"],
    // Isolates the unterminated-state guard specifically: everything before
    // the stray quote IS a valid address, so without the guard this header
    // quietly mirrors. Policy is to refuse a malformed list outright.
    ["an address followed by an unclosed quote", 'jane@example.com "Bob'],
    ["a comma inside the angle brackets", "<jane,x@example.com>"],
    ["a backslash at the very end of a quoted name", '"Jane\\'],
    ["empty angle brackets", "<>"],
    ["only whitespace", "   "],
    ["a leading empty entry", ",jane@example.com"],
    ["two at-signs", "<jane@@example.com>"],
    ["a dotless domain", "<jane@localhost>"],
    ["no at-sign at all", "Jane Doe"],
  ];

  for (const [label, to] of rejects) {
    it(`refuses to guess a counterparty from ${label}`, async () => {
      await seedAccount();
      await seedInbox();
      stubGmail({
        historyIds: ["m1"],
        messages: {
          m1: {
            labelIds: ["SENT"],
            raw: rawSent({ to, messageId: "<r1@acme.dev>" }),
          },
        },
      });

      const res = await sync();
      expect(res.ingested).toBe(0);
      expect(res.skipped).toBe(1);
      expect(res.failed).toBe(0);
      expect(await getDb().select().from(sentEmails)).toHaveLength(0);
    });
  }

  it("falls back to Cc, then to Bcc, when there is no To", async () => {
    await seedAccount();
    await seedInbox();
    stubGmail({
      historyIds: ["m1", "m2"],
      messages: {
        m1: {
          labelIds: ["SENT"],
          raw: rawSent({
            cc: "Bob <bob@example.com>",
            messageId: "<c2@acme.dev>",
          }),
        },
        m2: {
          labelIds: ["SENT"],
          // A blind-copied send: the Sent folder keeps the Bcc it went out
          // with, and that is the only counterparty there is.
          raw: rawSent({
            bcc: "Carol <carol@example.com>",
            messageId: "<c3@acme.dev>",
          }),
        },
      },
    });

    const res = await sync();
    expect(res.ingested).toBe(2);
    const addresses = (await getDb().select().from(sentEmails))
      .map((r) => r.toAddress)
      .sort();
    expect(addresses).toEqual(["bob@example.com", "carol@example.com"]);
  });

  it("skips a message with no address-shaped recipient anywhere", async () => {
    await seedAccount();
    await seedInbox();
    stubGmail({
      historyIds: ["m1"],
      messages: {
        m1: {
          labelIds: ["SENT"],
          raw: rawSent({ to: "undisclosed-recipients:;", messageId: "<c4@a>" }),
        },
      },
    });

    const res = await sync();
    expect(res.ingested).toBe(0);
    expect(res.skipped).toBe(1);
    expect(res.failed).toBe(0);
    expect(await getDb().select().from(sentEmails)).toHaveLength(0);
  });
});

describe("syncAccount — conversation grouping of a mirrored reply", () => {
  it("stamps the same conversation id as the inbound mail it answers", async () => {
    await seedAccount();
    await seedInbox();
    stubGmail({
      historyIds: ["in1", "out1"],
      messages: {
        in1: {
          raw: rawInbound({
            from: "jane@example.com",
            cc: "Bob <bob@example.com>",
            deliveredTo: "support@acme.dev",
            messageId: "<g1@example.com>",
          }),
        },
        out1: {
          labelIds: ["SENT"],
          raw: rawSent({
            to: "jane@example.com",
            cc: "Bob <bob@example.com>",
            messageId: "<s1@acme.dev>",
          }),
        },
      },
    });

    await sync();

    const [inbound] = await getDb().select().from(emails);
    const [mirrored] = await getDb().select().from(sentEmails);
    // Non-null first: a null on both sides would make the equality vacuous.
    expect(inbound.conversationId).not.toBeNull();
    expect(mirrored.conversationId).toBe(inbound.conversationId);
  });

  it("leaves it null for a 1-on-1 reply", async () => {
    await seedAccount();
    await seedInbox();
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

    await sync();
    const [row] = await getDb().select().from(sentEmails);
    expect(row.conversationId).toBeNull();
  });
});

describe("syncAccount — the internal-domain filter for grouping", () => {
  /** A Cloudflare-routed identity on a DIFFERENT domain to the Gmail one. */
  async function seedOtherDomainIdentity(email: string) {
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

  async function mirrorWithCc(cc: string) {
    stubGmail({
      historyIds: ["m1"],
      messages: {
        m1: {
          labelIds: ["SENT"],
          raw: rawSent({
            to: "jane@example.com",
            cc,
            messageId: "<s1@acme.dev>",
          }),
        },
      },
    });
    await sync();
    const [row] = await getDb().select().from(sentEmails);
    return row;
  }

  it("counts an outside Cc as a second participant", async () => {
    await seedAccount();
    await seedInbox();
    // Control for the two cases below: with a genuinely external Cc there
    // ARE two externals, so a conversation id must exist.
    const row = await mirrorWithCc("bob@example.com");
    expect(row.conversationId).not.toBeNull();
  });

  it("does not count a teammate on our own domain", async () => {
    await seedAccount();
    await seedInbox(); // support@acme.dev
    // acme.dev is ours, so teammate@acme.dev is internal: one external is
    // left, and a 1-on-1 thread has no conversation id. Were the internal
    // domains not loaded, this would come back non-null.
    const row = await mirrorWithCc("Teammate <teammate@acme.dev>");
    expect(row.conversationId).toBeNull();
  });

  it("counts every sender identity as ours, not just this account's", async () => {
    await seedAccount();
    await seedInbox(); // support@acme.dev, mapped to this Gmail account
    await seedOtherDomainIdentity("hello@other.dev"); // a Cloudflare inbox
    // other.dev is ours too. A loader that only looked at THIS account's
    // mappings would not know that, and would return a conversation id.
    const row = await mirrorWithCc("Colleague <colleague@other.dev>");
    expect(row.conversationId).toBeNull();
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
