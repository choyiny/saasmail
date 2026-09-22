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
import { sequences } from "../db/sequences.schema";
import { sequenceEnrollments } from "../db/sequence-enrollments.schema";
import { sequenceEmails } from "../db/sequence-emails.schema";
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
  /**
   * Omitted entirely when absent, so a Bcc-only send can be built. An array
   * writes one `To:` header per element, which is how a message carrying
   * DUPLICATE recipient headers is built.
   */
  to?: string | string[];
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
    ...(opts.to
      ? (Array.isArray(opts.to) ? opts.to : [opts.to]).map((v) => `To: ${v}`)
      : []),
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
  // UTF-8 first: `btoa` is latin1-only and would replace any non-ASCII byte
  // with U+FFFD, which would quietly turn a unicode-recipient fixture into a
  // test of mojibake instead of a test of the parser. Identical output for
  // the ASCII fixtures.
  const bytes = new TextEncoder().encode(s);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
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
  it("cancels the recipient's active sequences, like every other contact path", async () => {
    // A rep answering a lead from their phone is contact. Inbound mail
    // cancels sequences (email-handler.ts) and so does every saasmail send;
    // without this the customer keeps getting automated nudges about a
    // question a human already answered.
    await seedAccount();
    await seedInbox();
    await seedPerson("jane@example.com");

    const db = getDb();
    const now = Math.floor(Date.now() / 1000);
    await db.insert(sequences).values({
      id: "seq-1",
      name: "Nurture",
      steps: JSON.stringify([
        { order: 1, templateSlug: "welcome", delayHours: 0 },
      ]),
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(sequenceEnrollments).values({
      id: "enr-1",
      sequenceId: "seq-1",
      personId: "person-1",
      status: "active",
      variables: "{}",
      fromAddress: "support@acme.dev",
      enrolledAt: now,
    });
    await db.insert(sequenceEmails).values({
      id: "se-1",
      enrollmentId: "enr-1",
      stepOrder: 1,
      templateSlug: "welcome",
      scheduledAt: now + 3600,
      status: "pending",
    });

    stubGmail({
      historyIds: ["m1"],
      messages: {
        m1: {
          labelIds: ["SENT"],
          raw: rawSent({
            to: "Jane <jane@example.com>",
            messageId: "<s-cancel@acme.dev>",
          }),
        },
      },
    });

    const res = await sync();
    expect(res.failed).toBe(0);

    const [enrollment] = await db
      .select()
      .from(sequenceEnrollments)
      .where(eq(sequenceEnrollments.id, "enr-1"));
    expect(enrollment.status).toBe("cancelled");
    // The queued step is cancelled too — an enrollment marked cancelled with
    // a live scheduled email would still send the nudge.
    const [step] = await db
      .select()
      .from(sequenceEmails)
      .where(eq(sequenceEmails.id, "se-1"));
    expect(step.status).toBe("cancelled");
  });

  it("leaves sequences alone when the Sent message's recipient is unknown", async () => {
    // `sent_emails.person_id` is nullable on mirrored rows: mail to an
    // address we have never heard from resolves no person. The cancellation
    // must be conditional on that, not blow up or cancel someone else's.
    await seedAccount();
    await seedInbox();
    await seedPerson("jane@example.com");

    const db = getDb();
    const now = Math.floor(Date.now() / 1000);
    await db.insert(sequences).values({
      id: "seq-2",
      name: "Nurture",
      steps: JSON.stringify([
        { order: 1, templateSlug: "welcome", delayHours: 0 },
      ]),
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(sequenceEnrollments).values({
      id: "enr-2",
      sequenceId: "seq-2",
      personId: "person-1",
      status: "active",
      variables: "{}",
      fromAddress: "support@acme.dev",
      enrolledAt: now,
    });

    stubGmail({
      historyIds: ["m1"],
      messages: {
        m1: {
          labelIds: ["SENT"],
          raw: rawSent({
            to: "stranger@example.com",
            messageId: "<s-stranger@acme.dev>",
          }),
        },
      },
    });

    const res = await sync();
    expect(res.failed).toBe(0);

    const [enrollment] = await db
      .select()
      .from(sequenceEnrollments)
      .where(eq(sequenceEnrollments.id, "enr-2"));
    expect(enrollment.status).toBe("active");
  });

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

  it("carries the members of a Cc: group onto the mirrored row", async () => {
    await seedAccount();
    await seedInbox();
    stubGmail({
      historyIds: ["m1"],
      messages: {
        m1: {
          labelIds: ["SENT"],
          // An RFC 5322 group. postal-mime reports it as `{name, group:[…]}`
          // with no `.address` at all, so a roster built by reading `.address`
          // off each entry drops every member silently — the Cc column comes
          // back empty for a message that copied two people.
          raw: rawSent({
            to: "jane@example.com",
            cc: "Team: Alice <alice@x.com>, Bob <bob@y.com>;",
            messageId: "<s4@acme.dev>",
          }),
        },
      },
    });

    await sync();
    const rows = await getDb().select().from(sentEmails);
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0].cc ?? "[]")).toEqual([
      { email: "alice@x.com", name: "Alice" },
      { email: "bob@y.com", name: "Bob" },
    ]);
  });
});

describe("syncAccount — picking the counterparty off the header", () => {
  /**
   * Each case is the raw `To:` value and the address that must end up on the
   * row: the FIRST-WRITTEN recipient, every time.
   *
   * "First written" is not "first the parser handed back". postal-mime drops
   * entries it cannot make sense of, so its element 0 is the first SURVIVING
   * recipient — a different person from the first written one exactly when
   * the first written one is malformed. The rejects table below is where that
   * difference is pinned; this table is the other half: everything the header
   * says clearly enough that we can name its first recipient.
   */
  const cases: Array<[label: string, to: string | string[], expected: string]> =
    [
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
      // is the bracketed one OUTSIDE the quotes — and because the quotes are
      // balanced, the masking step blanks them out and the `@` inside them is
      // not mistaken for an earlier recipient.
      [
        "a bracketed address hidden inside the display name",
        '"Bob <bob@x.com>" <jane@example.com>',
        "jane@example.com",
      ],
      // Same trick, unquoted: an encoded word that DECODES to another address.
      // Nothing addressy survives in the raw header, so jane is still first.
      [
        "an encoded-word display name that decodes to another address",
        "=?utf-8?B?Ym9iQHguY29t?= <jane@example.com>",
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
      ["mixed case", "Jane <JANE@Example.COM>", "jane@example.com"],
      // Folded across two lines, which is how any real long recipient list
      // arrives. The fold must not become a recipient boundary of its own.
      [
        "a header folded across two lines",
        "Jane <jane@example.com>,\r\n\tBob <bob@x.com>",
        "jane@example.com",
      ],
      // Comments are legal anywhere and may be nested. They name nobody, so
      // they must neither supply an address nor hide one.
      [
        "a nested comment before the first address",
        "(a (nested) comment) jane@example.com, bob@x.com",
        "jane@example.com",
      ],
      [
        "a comment between the first and second address",
        "jane@example.com (Jane Doe), bob@x.com",
        "jane@example.com",
      ],
      // A comment that CONTAINS an address. It names nobody — a comment is
      // annotation, not a recipient — so blanking it out is what lets Jane be
      // recognised as the first recipient instead of the header looking like
      // it holds one more person than the parser handed back.
      [
        "a comment containing an address, ahead of the first recipient",
        "(a@b.com) jane@example.com, bob@x.com",
        "jane@example.com",
      ],
      [
        "a unicode local part and an IDN domain",
        "jäne@exämple.com, bob@x.com",
        "jäne@exämple.com",
      ],
      // RFC 5322 groups. postal-mime reports these as `{name, group:[…]}`
      // with no `.address`, so a naive read drops the whole group and promotes
      // whoever came after it. The members are real recipients written at the
      // group's position, and the first of them is the first-written address.
      ["an all-group header", "Team: alice@x.com, bob@y.com;", "alice@x.com"],
      [
        "a group followed by a plain recipient",
        "Team: alice@x.com;, bob@y.com",
        "alice@x.com",
      ],
      // An EMPTY group names nobody at all, so nobody was written ahead of
      // Bob and Bob really is the first recipient.
      [
        "an empty group followed by a plain recipient",
        "undisclosed-recipients:;, bob@x.com",
        "bob@x.com",
      ],
      // Recipient #2 is unusable. That is #2's problem: #1 is written plainly
      // ahead of it and is not in any doubt, and the comma inside the angle
      // brackets belongs to the broken entry rather than separating recipients.
      [
        "a broken second recipient behind a clean first one",
        "jane@example.com, <bob,x@y.com>",
        "jane@example.com",
      ],
      // Only ONE address is written here — masking guarantees each recipient
      // contributes exactly one `@` — so the trailing name-only entry cannot
      // be a recipient that got dropped ahead of Jane.
      [
        "a name-only entry behind the only address",
        "jane@example.com, Bob Doe",
        "jane@example.com",
      ],
      [
        "a very long list",
        Array.from(
          { length: 200 },
          (_, i) => `User${i} <u${i}@example.com>`,
        ).join(", "),
        "u0@example.com",
      ],
      // Two `To:` headers. postal-mime's own `to` array concatenates them
      // LAST-header-first; the first one written is the one that counts.
      [
        "duplicate To: headers",
        ["jane@example.com", "bob@x.com"],
        "jane@example.com",
      ],
      // The three below look malformed and ARE recovered, deliberately —
      // but only because each names exactly ONE recipient, so there is nobody
      // it could be confused with. Add a second recipient to any of them and
      // it moves to the rejects table; the paired entries are there.
      [
        "an unclosed angle bracket around the only recipient",
        "Jane <jane@example.com",
        "jane@example.com",
      ],
      [
        "an unclosed quote after the only recipient",
        'jane@example.com "Bob',
        "jane@example.com",
      ],
      [
        "a leading empty entry before the only recipient",
        ",jane@example.com",
        "jane@example.com",
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
   * Headers that must yield NOTHING.
   *
   * `refused` is the address this header must never put on a row: for the
   * misattribution cases, the wrong customer an earlier round of this code
   * actually filed; for the rest, the not-an-address postal-mime hands back
   * when asked what the header contains. `null` means the header names nobody
   * and there is no plausible wrong answer to assert against — asserting
   * `not.toContain("")` would document nothing, so those rows do not.
   *
   * Malformed is not by itself the test — three malformed headers are
   * recovered in the table above. What disqualifies these is that we cannot
   * prove which recipient was written first, or that the one that was is not
   * an address we will file a customer under.
   *
   * Each GATE comment names the check that ACTUALLY refuses the rows under it,
   * measured by neutering that check and seeing these tests go red — not
   * reasoned about from the source. Where a row is caught by more than one
   * check, the comment says so instead of claiming an exclusive.
   */
  const rejects: Array<[label: string, to: string, refused: string | null]> = [
    // GATE: one-`@`-per-chunk. The headline defect, and the shape the whole
    // task is named after. postal-mime reports ONE entry, `{address:
    // "bob@x.com", name: "Jane"}` — the missing `>` swallowed Jane into a
    // display name — so taking that entry files the reply on the LAST-written
    // address. Two checks see it: the preceding-`@` line fires first (Jane's
    // `@` sits ahead of Bob's in the masked header), and the structural gate
    // catches it again because chunk 0 carries two addresses. Deleting the
    // preceding-`@` line alone leaves this test green.
    [
      "an unclosed angle bracket ahead of a second recipient",
      "Jane <jane@example.com, Bob <bob@x.com>",
      "bob@x.com",
    ],
    // GATE: the addr-spec check. NOT the preceding-`@` check, and nothing is
    // "promoted" — promotion was the pre-fix behaviour, when this code read a
    // FILTERED list and John Doe's unusable entry was deleted out from under
    // it. `addressParser` is unfiltered, so `entries[0]` IS John Doe's entry:
    // postal-mime unquotes `"john doe"` into a local part with a space in it,
    // and a space is a special. `bob@x.com` is what round 4 filed here, which
    // is why it is the address asserted against, but no gate in the current
    // code can reach him.
    [
      "a quoted local part the parser unquotes into something unusable",
      '"john doe"@example.com, bob@x.com',
      "bob@x.com",
    ],
    // GATE: one-`@`-per-chunk, with the preceding-`@` line firing first as
    // above. An unquoted `@` in a display name is illegal, so we cannot tell a
    // display name from a first recipient the parser swallowed.
    [
      "a bare address used as a display name",
      "bob@x.com <jane@example.com>",
      "jane@example.com",
    ],
    // GATE: findable-in-header, exclusively — this is the only row in the file
    // that goes red when that check is removed. It is also the one row here
    // that is NOT a misattribution: `a@b.com` really is the first-written
    // recipient, but the parser RECONSTRUCTED it by unquoting `"a"`, so that
    // string appears nowhere in the header text and its position cannot be
    // established. The header is otherwise structurally perfect.
    [
      "a quoted local part the parser unquotes into a valid address",
      '"a"@b.com, jane@x.com',
      "a@b.com",
    ],
    // GATE: one-`@`-per-chunk — chunk 0 carries two addresses. NOT
    // findable-in-header: masking stops at the inner `)`, so `a@b.com` is
    // sitting in plain view in the masked string and `indexOf` finds it.
    //
    // The nastiest input found while attacking this. RFC 5322 comments nest;
    // postal-mime's do not, so it ends the comment at the inner `)` and hands
    // back `a@b.com` — an address that is COMMENT TEXT, not a recipient at
    // all, with the real recipient shoved into its display name. Nothing about
    // the entry looks wrong: it is a clean, valid addr-spec in slot 0.
    [
      "an address buried in a nested comment",
      "(outer (nested) a@b.com) jane@example.com, bob@x.com",
      "a@b.com",
    ],
    // GATE: the structural gate — one-`@`-per-chunk for the first and third,
    // the chunk count for the second. Each is the two-recipient variant of a
    // header that IS recovered above, which is the whole policy: recovery is
    // safe when nothing could have been dropped ahead of the answer, and only
    // then.
    [
      "an unclosed quote ahead of a second recipient",
      'jane@example.com "Bob <bob@x.com>',
      "jane@example.com",
    ],
    [
      "a leading empty entry ahead of a second recipient",
      ",jane@example.com, bob@x.com",
      "jane@example.com",
    ],
    [
      "two bracketed addresses crammed into ONE entry",
      "Jane <jane@example.com> <bob@x.com>",
      "jane@example.com",
    ],
    // GATE: the addr-spec check, with the structural gate behind it. The
    // round-3 regression — one stray quote suppressed every delimiter in the
    // hand-rolled scanner, which handed back Bob, the LAST address written.
    // postal-mime returns the whole header text as a single "address", which
    // is neither an addr-spec nor a clean one-address-per-entry list.
    [
      "an unclosed quote around the whole header",
      '"Jane jane@example.com, Bob <bob@x.com>',
      "bob@x.com",
    ],
    //
    // ── The addr-spec check ───────────────────────────────────────────────
    //
    // Each row below is a single clean entry that the parser reports
    // faithfully and that `isAddrSpec` refuses. Which CLAUSE each row pins was
    // MEASURED — one clause neutered at a time, this file re-run — rather than
    // reasoned about from the source. Tests killed per clause:
    //
    //   specials regex (whitespace, `,`, `;`)  2  the comma and semicolon rows
    //   `!domain.includes(".")`            3  both dotless rows, plus
    //                                         "stops at an unusable To:"
    //   invisible-character set            2  the ZWSP and RTL rows
    //   `length > 254`                     1
    //   leading/trailing domain dot        1
    //   doubled domain dot                 1
    //   `!local || !domain`                1  the empty-local-part row
    //   `at === -1`                        0
    //   `at !== lastIndexOf("@")`          0
    //
    // TWO CLAUSES ARE PINNED BY NOTHING. That is measured, and it is not an
    // oversight waiting to be tidied away:
    //
    //   - The double-`@` clause CANNOT be pinned by any header. For
    //     `isAddrSpec` to be the check that matters, the address has to have
    //     survived findable-in-header, i.e. appear verbatim in the masked
    //     header — and if it carries two `@`, so does its chunk, so the
    //     structural gate has already refused the header. Measured: neuter the
    //     double-`@` clause alone and this file stays green; neuter it
    //     together with one-`@`-per-chunk and `<jane@@example.com>` goes red.
    //     The row below is kept because the header must be refused, not
    //     because it covers that clause.
    //
    //   - `at === -1` overlaps `!local || !domain`, which in turn overlaps
    //     `!domain.includes(".")`. Measured: neuter `at === -1` AND
    //     `!local || !domain` together and only the empty-local-part row goes
    //     red — the four "names nobody" rows at the bottom stay green, because
    //     the domain-dot clause refuses `""` too.
    //
    // So the four bottom rows pin no clause of their own. They are here for
    // the OUTCOME — a header naming nobody must skip — not for coverage, and
    // the comment above them says so.
    [
      "a comma inside the angle brackets",
      "<jane,x@example.com>",
      "jane,x@example.com",
    ],
    [
      "a semicolon inside the angle brackets",
      "<jane;x@example.com>",
      "jane;x@example.com",
    ],
    ["a dotless domain", "<jane@localhost>", "jane@localhost"],
    [
      "a trailing dot on the domain",
      "<jane@example.com.>",
      "jane@example.com.",
    ],
    [
      "a doubled dot inside the domain",
      "<jane@exa..mple.com>",
      "jane@exa..mple.com",
    ],
    ["an empty local part", "<@example.com>", "@example.com"],
    [
      "an address past RFC 5321's 254-octet ceiling",
      `<${"a".repeat(250)}@example.com>`,
      `${"a".repeat(250)}@example.com`,
    ],
    ["two at-signs", "<jane@@example.com>", "jane@@example.com"],
    // An address carrying a character that renders as nothing. The header is
    // structurally perfect and the address looks, in every UI that will ever
    // show it, exactly like the real one — but `people.email` will never match
    // it, so mirroring it would mint a person row that can never merge with
    // the customer's own. The second is worse than it reads: U+202E makes the
    // rest of the line render right-to-left.
    [
      "a zero-width space welded to the first address",
      "jane@example.com\u200b, bob@x.com",
      "jane@example.com\u200b",
    ],
    [
      "a right-to-left override inside the only address",
      "<jane@ex\u202eample.com>",
      "jane@ex\u202eample.com",
    ],
    // GATE: the addr-spec check, reached through a first recipient that is
    // syntactically fine but not one we will file mail under. The danger here
    // is not the dotless address — it is bob, sitting behind it in slot 1.
    [
      "a dotless domain ahead of a valid one",
      "jane@localhost, bob@x.com",
      "bob@x.com",
    ],
    // NO CLAUSE OF THEIR OWN — see the measurement note above. postal-mime
    // hands back an entry with an empty address (or no entry at all), which
    // `isAddrSpec` refuses via whichever clause it reaches first; every one of
    // those is already pinned by a row further up. These four are here for the
    // outcome: a header that names nobody must skip. They name nobody, so
    // there is no wrong answer to assert against and `refused` is null.
    ["a backslash at the very end of a quoted name", '"Jane\\', null],
    ["empty angle brackets", "<>", null],
    ["only whitespace", "   ", null],
    ["no at-sign at all", "Jane Doe", null],
  ];

  for (const [label, to, refused] of rejects) {
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
      const rows = await getDb().select().from(sentEmails);
      expect(rows).toHaveLength(0);
      // Spelled out so the failure message names the address this header
      // would otherwise have filed. Skipped where the header names nobody:
      // `not.toContain(null)` on an empty array asserts nothing at all, and a
      // test that cannot fail is worse than no test.
      if (refused !== null) {
        expect(rows.map((r) => r.toAddress)).not.toContain(refused);
      }
    });
  }

  it("prefers To: over Cc: over Bcc:, not merely reaching each of them", async () => {
    await seedAccount();
    await seedInbox();
    stubGmail({
      historyIds: ["m1", "m2", "m3"],
      messages: {
        // All three headers present, all three usable: To: must win. This is
        // what makes the ORDER of the fallback chain load-bearing — a chain
        // that tried Cc: or Bcc: first would file this on the wrong person.
        m1: {
          labelIds: ["SENT"],
          raw: rawSent({
            to: "jane@example.com",
            cc: "Bob <bob@example.com>",
            bcc: "Carol <carol@example.com>",
            messageId: "<c2@acme.dev>",
          }),
        },
        // No To:, but Cc: AND Bcc: — Cc: must win over Bcc:.
        m2: {
          labelIds: ["SENT"],
          raw: rawSent({
            cc: "Dave <dave@example.com>",
            bcc: "Erin <erin@example.com>",
            messageId: "<c3@acme.dev>",
          }),
        },
        // A blind-copied send: the Sent folder keeps the Bcc it went out
        // with, and that is the only counterparty there is.
        m3: {
          labelIds: ["SENT"],
          raw: rawSent({
            bcc: "Frank <frank@example.com>",
            messageId: "<c4@acme.dev>",
          }),
        },
      },
    });

    const res = await sync();
    expect(res.ingested).toBe(3);
    const addresses = (await getDb().select().from(sentEmails))
      .map((r) => r.toAddress)
      .sort();
    expect(addresses).toEqual([
      "dave@example.com",
      "frank@example.com",
      "jane@example.com",
    ]);
  });

  it("stops at an unusable To: instead of falling through to Cc:", async () => {
    await seedAccount();
    await seedInbox();
    stubGmail({
      historyIds: ["m1"],
      messages: {
        m1: {
          labelIds: ["SENT"],
          // The To: line names somebody — we just will not file mail under a
          // dotless domain. Bob is a copied third party, not the person this
          // was addressed to, and mirroring it onto his timeline would be a
          // wrong-customer filing dressed up as a graceful fallback.
          raw: rawSent({
            to: "<jane@localhost>",
            cc: "Bob <bob@example.com>",
            messageId: "<c5@acme.dev>",
          }),
        },
      },
    });

    const res = await sync();
    expect(res.ingested).toBe(0);
    expect(res.skipped).toBe(1);
    const rows = await getDb().select().from(sentEmails);
    expect(rows).toHaveLength(0);
    expect(rows.map((r) => r.toAddress)).not.toContain("bob@example.com");
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
