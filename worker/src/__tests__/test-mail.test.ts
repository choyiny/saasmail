// docs/test-mail.md: the wait endpoint answers the first matching message to
// a test inbox, with its links and codes, and refuses every other inbox.
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { handleEmail } from "../email-handler";
import { emails } from "../db/emails.schema";
import { people } from "../db/people.schema";
import { rules } from "../db/rules.schema";
import { senderIdentities } from "../db/sender-identities.schema";
import { inboxPermissions } from "../db/inbox-permissions.schema";
import { setWebhookConfig } from "../lib/webhook-config";
import {
  extractCodes,
  extractLinks,
  pruneTestMail,
  waitForTestMail,
  type TestMail,
} from "../lib/test-mail";
import {
  applyMigrations,
  authFetch,
  cleanDb,
  createTestPerson,
  createTestUser,
  getDb,
} from "./helpers";

const TEST_INBOX = "e2e@saasmail.test";
const NORMAL_INBOX = "support@saasmail.test";
const OTHER_TEST_INBOX = "qa@saasmail.test";

async function addInbox(
  email: string,
  purpose: "mail" | "test",
  testRetentionDays: number | null = null,
) {
  const now = Math.floor(Date.now() / 1000);
  await getDb().insert(senderIdentities).values({
    email,
    purpose,
    testRetentionDays,
    createdAt: now,
    updatedAt: now,
  });
}

async function grant(userId: string, ...inboxes: string[]) {
  const now = Math.floor(Date.now() / 1000);
  await getDb()
    .insert(inboxPermissions)
    .values(
      inboxes.map((email) => ({
        userId,
        email,
        createdAt: now,
        createdBy: userId,
      })),
    );
}

let seq = 0;
/** A stored test-inbox message, as the inbound handler writes it. */
async function addMail(opts: {
  recipient?: string;
  detail?: string | null;
  subject?: string;
  text?: string | null;
  html?: string | null;
  receivedAt?: number;
  personId?: string;
}) {
  const now = Math.floor(Date.now() / 1000);
  const id = `mail-${++seq}`;
  await getDb()
    .insert(emails)
    .values({
      id,
      personId: opts.personId ?? "sender-1",
      recipient: opts.recipient ?? TEST_INBOX,
      recipientDetail: opts.detail === undefined ? "run1" : opts.detail,
      subject: opts.subject ?? "Reset your password",
      bodyText: opts.text === undefined ? "Code 482913" : opts.text,
      bodyHtml: opts.html ?? null,
      messageId: `<${id}@example.com>`,
      receivedAt: opts.receivedAt ?? now,
      createdAt: now,
    });
  return id;
}

function waitUrl(params: Record<string, string | number>) {
  const query = new URLSearchParams(
    Object.entries(params).map(([k, v]) => [k, String(v)]),
  );
  return `/api/test-mail/wait?${query}`;
}

/** A sleep that only moves the fake clock forward. */
function fakeClock(start = 0) {
  let t = start;
  return {
    now: () => t,
    sleep: vi.fn(async (ms: number) => {
      t += ms;
    }),
  };
}

beforeAll(async () => {
  await applyMigrations();
});

beforeEach(async () => {
  await cleanDb();
  await createTestPerson({ id: "sender-1", email: "no-reply@example.com" });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("extractLinks and extractCodes", () => {
  it("takes text URLs, dropping trailing punctuation and duplicates", () => {
    expect(
      extractLinks(
        '<a href="https://example.com/x">x</a> <a href="mailto:a@b.c">m</a>',
        "Go to https://example.com/x. Or (https://example.com/y), ftp://no",
      ),
    ).toEqual(["https://example.com/x", "https://example.com/y"]);
  });

  it("finds whole 4–8 digit runs, not parts of longer ones", () => {
    expect(
      extractCodes("Code 1234", "is 482913, ref 1234567890, id 12"),
    ).toEqual(["1234", "482913"]);
    expect(extractCodes(null, "1234567890")).toEqual([]);
  });
});

describe("GET /api/test-mail/wait", () => {
  it("returns a match with its links and codes", async () => {
    const { apiKey } = await createTestUser({ id: "admin-1" });
    await addInbox(TEST_INBOX, "test");
    const id = await addMail({
      text: "Your code is 482913. Reset at https://example.com/reset?a=1&b=2",
    });

    const res = await authFetch(
      waitUrl({ inbox: TEST_INBOX, detail: "RUN1", since: 0, timeout: 1 }),
      { apiKey },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      id,
      inbox: TEST_INBOX,
      detail: "run1",
      from: "no-reply@example.com",
      subject: "Reset your password",
      links: ["https://example.com/reset?a=1&b=2"],
      codes: ["482913"],
    });
  });

  it("filters by detail, subject and since", async () => {
    const { apiKey } = await createTestUser({ id: "admin-1" });
    await addInbox(TEST_INBOX, "test");
    const now = Math.floor(Date.now() / 1000);
    await addMail({ detail: "other", subject: "Welcome" });
    await addMail({
      detail: "run1",
      subject: "Welcome",
      receivedAt: now - 100,
    });
    const wanted = await addMail({ detail: "run1", subject: "Welcome aboard" });
    await addMail({ detail: "run1", subject: "Invoice" });

    const res = await authFetch(
      waitUrl({
        inbox: TEST_INBOX,
        detail: "run1",
        subject: "WELCOME",
        since: now - 10,
        timeout: 1,
      }),
      { apiKey },
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as TestMail).id).toBe(wanted);
  });

  it("finds a match behind six near-matches", async () => {
    const { apiKey } = await createTestUser({ id: "admin-1" });
    await addInbox(TEST_INBOX, "test");
    const now = Math.floor(Date.now() / 1000);
    for (let i = 0; i < 6; i++) {
      await addMail({ subject: `Newsletter ${i}`, receivedAt: now - 60 + i });
    }
    const wanted = await addMail({ subject: "Your sign-in link" });

    const res = await authFetch(
      waitUrl({
        inbox: TEST_INBOX,
        from: "no-reply@example.com",
        subject: "sign-in",
        since: now - 120,
        timeout: 1,
      }),
      { apiKey },
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as TestMail).id).toBe(wanted);
  });

  it("reads the code of an HTML-only message", async () => {
    const { apiKey } = await createTestUser({ id: "admin-1" });
    await addInbox(TEST_INBOX, "test");
    await addMail({
      text: null,
      html: '<p>Your code: <b>739201</b></p><a href="https://example.com/v?t=1&amp;u=2">Verify</a>',
    });

    const res = await authFetch(
      waitUrl({ inbox: TEST_INBOX, since: 0, timeout: 1 }),
      { apiKey },
    );
    const body = (await res.json()) as TestMail;
    expect(body.codes).toContain("739201");
    expect(body.links).toEqual(["https://example.com/v?t=1&u=2"]);
  });

  it("refuses a normal inbox and an inbox outside the member's grant with the same 403", async () => {
    const { apiKey, userId } = await createTestUser({
      id: "member-1",
      role: "member",
    });
    await addInbox(TEST_INBOX, "test");
    await addInbox(NORMAL_INBOX, "mail");
    await addInbox(OTHER_TEST_INBOX, "test");
    await grant(userId, TEST_INBOX, NORMAL_INBOX);

    const normal = await authFetch(
      waitUrl({ inbox: NORMAL_INBOX, since: 0, timeout: 1 }),
      { apiKey },
    );
    const outside = await authFetch(
      waitUrl({ inbox: OTHER_TEST_INBOX, since: 0, timeout: 1 }),
      { apiKey },
    );
    const missing = await authFetch(
      waitUrl({ inbox: "nobody@saasmail.test", since: 0, timeout: 1 }),
      {
        apiKey: (
          await createTestUser({ id: "admin-2", email: "a2@example.com" })
        ).apiKey,
      },
    );
    expect(normal.status).toBe(403);
    expect(outside.status).toBe(403);
    expect(missing.status).toBe(403);
    const bodies = [
      await normal.json(),
      await outside.json(),
      await missing.json(),
    ];
    expect(new Set(bodies.map((b) => JSON.stringify(b))).size).toBe(1);
  });

  it("answers a message with an href naming no code point, dropping that link", async () => {
    const { apiKey } = await createTestUser({ id: "admin-1" });
    await addInbox(TEST_INBOX, "test");
    const id = await addMail({
      text: null,
      html: '<a href="https://example.com/x?&#1114112;">bad</a> <a href="https://example.com/ok">ok</a> code 482913',
    });

    const res = await authFetch(
      waitUrl({ inbox: TEST_INBOX, since: 0, timeout: 1 }),
      { apiKey },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as TestMail;
    expect(body.id).toBe(id);
    expect(body.links).toEqual(["https://example.com/ok"]);
  });

  it("answers 400 on a bad query", async () => {
    const { apiKey } = await createTestUser({ id: "admin-1" });
    for (const params of [
      { inbox: TEST_INBOX },
      { inbox: TEST_INBOX, since: 0, timeout: 31 },
      { inbox: TEST_INBOX, since: 0, timeout: 0 },
      { inbox: "not-an-address", since: 0 },
    ]) {
      const res = await authFetch(waitUrl(params), { apiKey });
      expect(res.status).toBe(400);
    }
  });

  it("answers 204 when nothing arrives before the timeout", async () => {
    const { apiKey } = await createTestUser({ id: "admin-1" });
    await addInbox(TEST_INBOX, "test");
    const res = await authFetch(
      waitUrl({ inbox: TEST_INBOX, detail: "none", since: 0, timeout: 1 }),
      { apiKey },
    );
    expect(res.status).toBe(204);
  });
});

describe("waitForTestMail", () => {
  it("returns a message that arrives during the wait", async () => {
    await addInbox(TEST_INBOX, "test");
    const clock = fakeClock();
    let id = "";
    const tick = clock.sleep.getMockImplementation()!;
    clock.sleep.mockImplementation(async (ms: number) => {
      await tick(ms);
      if (clock.sleep.mock.calls.length === 2) id = await addMail({});
    });
    const result = await waitForTestMail(
      getDb(),
      { isAdmin: true },
      { inbox: TEST_INBOX, detail: "run1", since: 0, timeout: 30 },
      clock,
    );
    expect(result.message?.id).toBe(id);
    expect(clock.sleep).toHaveBeenCalledTimes(2);
  });

  it("stops when the signal aborts", async () => {
    await addInbox(TEST_INBOX, "test");
    const controller = new AbortController();
    const clock = fakeClock();
    clock.sleep.mockImplementation(async () => controller.abort());
    const result = await waitForTestMail(
      getDb(),
      { isAdmin: true },
      { inbox: TEST_INBOX, since: 0, timeout: 30 },
      { ...clock, signal: controller.signal },
    );
    expect(result.message).toBeNull();
    expect(clock.sleep).toHaveBeenCalledTimes(1);
  });
});

describe("pruneTestMail", () => {
  it("never prunes a test inbox mapped to Gmail", async () => {
    const now = Math.floor(Date.now() / 1000);
    await addInbox(TEST_INBOX, "test");
    // Mapped by another path, as a concurrent edit could leave it.
    await getDb()
      .update(senderIdentities)
      .set({ source: "gmail", gmailAccountId: "g-1" })
      .where(eq(senderIdentities.email, TEST_INBOX));
    await addMail({ receivedAt: now - 10 * 24 * 60 * 60 });

    expect(await pruneTestMail(getDb(), env as never, now)).toBe(0);
    expect(await getDb().select().from(emails)).toHaveLength(1);
  });

  it("deletes R2 keys in chunks of 1,000, after the counts, and survives an R2 failure", async () => {
    const now = Math.floor(Date.now() / 1000);
    await addInbox(TEST_INBOX, "test");
    await getDb()
      .update(people)
      .set({ totalCount: 5, unreadCount: 5 })
      .where(eq(people.id, "sender-1"));
    const ids = [
      await addMail({ receivedAt: now - 4 * 24 * 60 * 60 }),
      await addMail({ receivedAt: now - 4 * 24 * 60 * 60 }),
    ];
    // 600 attachment rows per message: 1,200 keys in one pass.
    for (const id of ids) {
      await env.DB.prepare(
        `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 600)
         INSERT INTO attachments (id, email_id, kind, filename, content_type, size, r2_key, created_at)
         SELECT ?1 || '-a' || i, ?1, 'inbound', 'f.txt', 'text/plain', 1, 'attachments/' || ?1 || '/' || i, ?2 FROM n`,
      )
        .bind(id, now)
        .run();
    }
    const calls: number[] = [];
    const r2 = {
      delete: vi.fn(async (keys: string[]) => {
        calls.push(keys.length);
        if (keys.length > 1000) throw new Error("too many keys");
        // The second chunk fails anyway: the pass must still finish.
        if (calls.length === 2) throw new Error("R2 unavailable");
      }),
    };

    expect(await pruneTestMail(getDb(), { ...env, R2: r2 } as never, now)).toBe(
      2,
    );
    expect(calls).toEqual([1000, 200]);
    const [person] = await getDb()
      .select({ total: people.totalCount, unread: people.unreadCount })
      .from(people)
      .where(eq(people.id, "sender-1"));
    expect(person).toEqual({ total: 3, unread: 3 });
    expect(await getDb().select().from(emails)).toHaveLength(0);
  });

  it("keeps mail whose inbox stopped being a test inbox after the candidates were read", async () => {
    const now = Math.floor(Date.now() / 1000);
    await addInbox(TEST_INBOX, "test");
    const id = await addMail({ receivedAt: now - 4 * 24 * 60 * 60 });
    const rawKey = `inbound-raw/${id}.eml`;
    await env.R2.put(rawKey, "raw message");
    await getDb()
      .update(emails)
      .set({ rawR2Key: rawKey })
      .where(eq(emails.id, id));
    const switchToMail = async () => {
      await getDb()
        .update(senderIdentities)
        .set({ purpose: "mail", testRetentionDays: null })
        .where(eq(senderIdentities.email, TEST_INBOX));
    };

    expect(
      await pruneTestMail(getDb(), env as never, now, {
        beforeDelete: switchToMail,
      }),
    ).toBe(0);
    expect(
      await getDb().select().from(emails).where(eq(emails.id, id)),
    ).toHaveLength(1);
    expect(await env.R2.get(rawKey)).not.toBeNull();

    // Back to a test inbox, the same pass deletes it and its raw message.
    await getDb()
      .update(senderIdentities)
      .set({ purpose: "test" })
      .where(eq(senderIdentities.email, TEST_INBOX));
    expect(await pruneTestMail(getDb(), env as never, now)).toBe(1);
    expect(await env.R2.get(rawKey)).toBeNull();
  });

  it("deletes only test-inbox mail older than its retention", async () => {
    const now = Math.floor(Date.now() / 1000);
    const day = 24 * 60 * 60;
    await addInbox(TEST_INBOX, "test");
    await addInbox(OTHER_TEST_INBOX, "test", 10);
    await addInbox(NORMAL_INBOX, "mail");
    const oldTest = await addMail({ receivedAt: now - 4 * day });
    const freshTest = await addMail({ receivedAt: now - 2 * day });
    const keptByLongerRetention = await addMail({
      recipient: OTHER_TEST_INBOX,
      receivedAt: now - 4 * day,
    });
    const oldNormal = await addMail({
      recipient: NORMAL_INBOX,
      detail: null,
      receivedAt: now - 40 * day,
    });

    expect(await pruneTestMail(getDb(), env as never, now)).toBe(1);
    const left = (await getDb().select({ id: emails.id }).from(emails)).map(
      (r) => r.id,
    );
    expect(left).not.toContain(oldTest);
    expect(left).toEqual(
      expect.arrayContaining([freshTest, keptByLongerRetention, oldNormal]),
    );
  });

  it("deletes at most 40 per pass, oldest first across test inboxes", async () => {
    const now = Math.floor(Date.now() / 1000);
    const day = 24 * 60 * 60;
    await addInbox(TEST_INBOX, "test", 1);
    await addInbox(OTHER_TEST_INBOX, "test", 5);
    // 30 expired in each inbox (each past its own retention), plus 3 in the
    // 5-day inbox that are past 1 day but not 5, so they stay.
    const values = [
      ...Array.from({ length: 30 }, (_, i) => ({
        recipient: TEST_INBOX,
        receivedAt: now - 2 * day - i,
      })),
      ...Array.from({ length: 30 }, (_, i) => ({
        recipient: OTHER_TEST_INBOX,
        receivedAt: now - 6 * day - i,
      })),
      ...Array.from({ length: 3 }, (_, i) => ({
        recipient: OTHER_TEST_INBOX,
        receivedAt: now - 2 * day - i,
      })),
    ].map((v, i) => ({
      ...v,
      id: `bulk-${i}`,
      personId: "sender-1",
      subject: "old",
      messageId: `<bulk-${i}@example.com>`,
      createdAt: now,
    }));
    for (let i = 0; i < values.length; i += 8) {
      await getDb()
        .insert(emails)
        .values(values.slice(i, i + 8));
    }

    expect(await pruneTestMail(getDb(), env as never, now)).toBe(40);
    // Oldest first: the 30 in the 5-day inbox went, then the 10 oldest of the
    // 1-day inbox.
    const left = await getDb()
      .select({ recipient: emails.recipient, receivedAt: emails.receivedAt })
      .from(emails);
    expect(left).toHaveLength(23);
    expect(left.filter((r) => r.receivedAt < now - 5 * day)).toHaveLength(0);

    expect(await pruneTestMail(getDb(), env as never, now)).toBe(20);
    const kept = await getDb()
      .select({ recipient: emails.recipient })
      .from(emails);
    expect(kept).toEqual(
      Array.from({ length: 3 }, () => ({ recipient: OTHER_TEST_INBOX })),
    );
    expect(await pruneTestMail(getDb(), env as never, now)).toBe(0);
  });
});

describe("test inbox end to end", () => {
  it("returns plus mail to a member key granted only the test inbox, and fires nothing", async () => {
    const { apiKey, userId } = await createTestUser({
      id: "ci-member",
      role: "member",
    });
    await addInbox(TEST_INBOX, "test");
    await addInbox(NORMAL_INBOX, "mail");
    await grant(userId, TEST_INBOX);
    const now = Math.floor(Date.now() / 1000);
    await getDb()
      .insert(rules)
      .values({
        id: "rule-all",
        name: "Every message",
        inbox: null,
        trigger: "message.received",
        conditions: [],
        actions: [{ type: "archive" }] as never,
        position: 0,
        stopProcessing: 0,
        enabled: 1,
        matchCount: 0,
        createdAt: now,
        updatedAt: now,
      });
    await setWebhookConfig(
      getDb(),
      { url: "https://hook.example.com/inbound", secret: null },
      null,
    );
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const since = now - 1;
    const raw = [
      "From: App <no-reply@example.com>",
      "To: e2e+run42@saasmail.test",
      "Subject: Reset your password",
      "Message-ID: <run42@example.com>",
      'Content-Type: multipart/alternative; boundary="b"',
      "",
      "--b",
      "Content-Type: text/plain; charset=utf-8",
      "",
      "Your code is 482913.",
      "--b",
      "Content-Type: text/html; charset=utf-8",
      "",
      '<p>Your code is 482913.</p><a href="https://example.com/reset?a=1&amp;b=2">Reset</a>',
      "--b--",
    ].join("\r\n");
    const waitUntil = vi.fn();
    await handleEmail(
      {
        from: "no-reply@example.com",
        to: "e2e+run42@saasmail.test",
        raw: new Response(raw).body!,
        rawSize: raw.length,
        headers: new Headers(),
        setReject: vi.fn(),
        async forward() {},
        async reply() {},
      } as unknown as ForwardableEmailMessage,
      env as unknown as CloudflareBindings,
      { waitUntil, passThroughOnException() {} } as unknown as ExecutionContext,
    );

    const res = await authFetch(
      waitUrl({ inbox: TEST_INBOX, detail: "run42", since, timeout: 5 }),
      { apiKey },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as TestMail;
    expect(body.links).toEqual(["https://example.com/reset?a=1&b=2"]);
    expect(body.codes).toEqual(["482913"]);
    expect(body.detail).toBe("run42");

    // No rule ran, no webhook went out, no notification was fanned out.
    const [rule] = await getDb()
      .select({ matchCount: rules.matchCount })
      .from(rules)
      .where(eq(rules.id, "rule-all"));
    expect(rule.matchCount).toBe(0);
    const state = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM mailbox_message_state WHERE archived_at IS NOT NULL",
    ).first<{ n: number }>();
    expect(state?.n).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(waitUntil).not.toHaveBeenCalled();

    const normal = await authFetch(
      waitUrl({ inbox: NORMAL_INBOX, since, timeout: 1 }),
      { apiKey },
    );
    expect(normal.status).toBe(403);
  });
});

describe("GET /api/test-mail/wait — the subject filter", () => {
  // The subject is a case-insensitive substring (docs/test-mail.md): a `%` or
  // `_` in it is a literal character, never a wildcard that lets an earlier
  // message match, and case folds for French capitals as for ASCII ones.
  it("treats % and _ literally and folds accented capitals", async () => {
    const { apiKey } = await createTestUser({ id: "admin-1" });
    await addInbox(TEST_INBOX, "test");
    const now = Math.floor(Date.now() / 1000);
    // Earlier near-matches that a wildcard would let through first.
    await addMail({ subject: "Remise de 100 euros", receivedAt: now - 50 });
    await addMail({ subject: "code-a-usage", receivedAt: now - 40 });
    await addMail({ subject: "Bienvenue", receivedAt: now - 30 });
    const percent = await addMail({
      subject: "Remise de 100% sur votre abonnement",
      receivedAt: now - 20,
    });
    const underscore = await addMail({
      subject: "code_a_usage unique",
      receivedAt: now - 10,
    });
    const accented = await addMail({
      subject: "Réinitialisation de votre mot de passe",
      receivedAt: now - 5,
    });

    const first = async (subject: string) => {
      const res = await authFetch(
        waitUrl({ inbox: TEST_INBOX, subject, since: now - 60, timeout: 1 }),
        { apiKey },
      );
      return res.status === 200 ? ((await res.json()) as TestMail).id : null;
    };

    expect(await first("100%")).toBe(percent);
    expect(await first("code_a")).toBe(underscore);
    expect(await first("réinitialisation")).toBe(accented);
    // Case-insensitive for ASCII letters: the accented letter in the mail's
    // own case still matches.
    expect(await first("RéINITIALISATION")).toBe(accented);
  });
});
