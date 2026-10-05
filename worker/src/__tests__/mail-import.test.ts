// docs/data.md: import mail from mbox and .eml.
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  onTestFinished,
} from "vitest";
import { env } from "cloudflare:workers";
import { eq, sql } from "drizzle-orm";
import { asyncJobs } from "../db/async-jobs.schema";
import { emails } from "../db/emails.schema";
import { inboxPermissions } from "../db/inbox-permissions.schema";
import { people } from "../db/people.schema";
import { rules } from "../db/rules.schema";
import { sentEmails } from "../db/sent-emails.schema";
import { parseRawEmail } from "../lib/email-parser";
import { storeReceivedMessage } from "../lib/inbound/store-received";
import { storeSentMessage } from "../lib/inbound/store-sent";
import {
  mboxStart,
  readMessages,
  separatorDate,
} from "../lib/import/mbox-reader";
import {
  IMPORT_LIMITS,
  IMPORT_PART_BYTES,
  completeImportUpload,
  exporterLabels,
  deleteMailImport,
  expectedParts,
  importJobById,
  importParams,
  labelState,
  parseLabels,
  reapMailImports,
  runMailImportSlice,
  skipStuckMessage,
  startMailImport,
  uploadImportPart,
} from "../lib/import/mail-import";
import { setSpamFilterEnabled } from "../lib/spam/filter";
import { classifyQueueMessage } from "../lib/queue-router";
import {
  applyMigrations,
  authFetch,
  cleanDb,
  createTestPerson,
  createTestUser,
  getDb,
} from "./helpers";

const INBOX = "support@saasmail.test";
const encoder = new TextEncoder();
const decoder = new TextDecoder();

beforeAll(async () => {
  await applyMigrations();
});

beforeEach(async () => {
  await cleanDb();
});

/** One RFC 5322 message, CRLF. */
function message(options: {
  from?: string;
  to?: string;
  cc?: string;
  subject?: string;
  id?: string | null;
  date?: string;
  labels?: string;
  body?: string;
  headers?: string[];
}): string {
  const lines = [
    // Gmail Takeout writes its labels first, above the message's own headers.
    ...(options.labels !== undefined
      ? [`X-Gmail-Labels: ${options.labels}`]
      : []),
    `From: ${options.from ?? "Alice <alice@example.com>"}`,
    `To: ${options.to ?? INBOX}`,
    ...(options.cc ? [`Cc: ${options.cc}`] : []),
    `Subject: ${options.subject ?? "Hello"}`,
    ...(options.id === null
      ? []
      : [
          `Message-ID: <${options.id ?? `${crypto.randomUUID()}@example.com`}>`,
        ]),
    `Date: ${options.date ?? "Mon, 01 Jun 2026 10:00:00 +0000"}`,
    ...(options.headers ?? []),
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "",
    options.body ?? "Hi there",
    "",
  ];
  return lines.join("\r\n");
}

/** An mbox of these messages (mboxrd: body `From ` lines quoted). */
function mbox(messages: string[]): string {
  return messages
    .map(
      (text) =>
        `From sender@example.com Sat Oct  3 14:02:00 2026\n${text.replace(/^(>*From )/gm, ">$1")}\n`,
    )
    .join("");
}

async function importFile(
  content: string | Uint8Array,
  options: {
    direction?: "strict" | "all_received";
    createFoldersFromLabels?: boolean;
    filename?: string;
  } = {},
) {
  const bytes = typeof content === "string" ? encoder.encode(content) : content;
  const job = await startMailImport(getDb(), env, {
    inbox: INBOX,
    filename: options.filename ?? "mail.mbox",
    size: bytes.length,
    direction: options.direction ?? "strict",
    createFoldersFromLabels: options.createFoldersFromLabels ?? true,
    userId: "admin-1",
  });
  for (let n = 1; n <= expectedParts(bytes.length); n++) {
    const current = await importJobById(getDb(), job.id);
    await uploadImportPart(
      getDb(),
      env,
      current!,
      n,
      bytes.subarray((n - 1) * IMPORT_PART_BYTES, n * IMPORT_PART_BYTES),
    );
  }
  return completeImportUpload(
    getDb(),
    env,
    (await importJobById(getDb(), job.id))!,
  );
}

async function runAll(jobId: string): Promise<number> {
  let slice: number | null = 0;
  let runs = 0;
  while (slice !== null) {
    slice = await runMailImportSlice(getDb(), env, jobId, slice);
    runs++;
  }
  return runs;
}

async function jobRow(id: string) {
  return (await importJobById(getDb(), id))!;
}

describe("the mbox reader", () => {
  it("reads a Gmail Takeout file (CRLF, labels, zone in the separator)", () => {
    const file = encoder.encode(
      [
        "From 1712345678901234567@xxx Fri Oct 02 12:00:00 +0000 2020\r\n",
        "X-Gmail-Labels: Inbox,Starred\r\nSubject: One\r\n\r\nBody one\r\n\r\n",
        "From 1712345678901234568@xxx Fri Oct 02 13:00:00 +0200 2020\r\n",
        "Subject: Two\r\n\r\nBody two\r\n",
      ].join(""),
    );
    const read = readMessages(file, 0, true);
    expect(read.messages).toHaveLength(2);
    expect(decoder.decode(read.messages[0].bytes)).toBe(
      "X-Gmail-Labels: Inbox,Starred\r\nSubject: One\r\n\r\nBody one\r\n",
    );
    expect(read.messages[0].separatorDate?.toISOString()).toBe(
      "2020-10-02T12:00:00.000Z",
    );
    expect(read.messages[1].separatorDate?.toISOString()).toBe(
      "2020-10-02T11:00:00.000Z",
    );
    expect(read.nextOffset).toBe(file.length);
  });

  it("reads a Thunderbird file and undoes mboxrd quoting", () => {
    const text =
      "From - Sat Oct 03 14:02:00 2026\nX-Mozilla-Status: 0001\nSubject: Q\n\n>From the start\n>>From deeper\nFromage\n\nFrom here on, no time: still the body\n\n" +
      "From - Sat Oct 03 15:02:00 2026\nSubject: R\n\nok\n";
    const read = readMessages(encoder.encode(text), 0, true);
    expect(read.messages).toHaveLength(2);
    expect(decoder.decode(read.messages[0].bytes)).toBe(
      "X-Mozilla-Status: 0001\nSubject: Q\n\nFrom the start\n>From deeper\nFromage\n\nFrom here on, no time: still the body\n",
    );
  });

  it("leaves a message the window cuts off to the next window", () => {
    const text = mbox([
      message({ subject: "First" }),
      message({ subject: "Second", body: "x".repeat(500) }),
    ]);
    const bytes = encoder.encode(text);
    const second = text.indexOf("From sender", 10);
    // Cut inside the second message: the first is whole, the second waits.
    const first = readMessages(bytes.subarray(0, second + 200), 0, false);
    expect(first.messages).toHaveLength(1);
    expect(first.nextOffset).toBe(second);
    const rest = readMessages(bytes.subarray(second), second, true);
    expect(rest.messages).toHaveLength(1);
    expect(decoder.decode(rest.messages[0].bytes)).toContain("Subject: Second");
    // Cut inside its separator line: that line is not a separator yet, so
    // nothing ends in the window and the next read starts at the first.
    expect(readMessages(bytes.subarray(0, second + 10), 0, false)).toEqual({
      messages: [],
      nextOffset: 0,
    });
    // Nothing ends inside a window that only holds the start of a message.
    expect(readMessages(bytes.subarray(0, 50), 0, false)).toEqual({
      messages: [],
      nextOffset: 0,
    });
  });

  it("finds where an mbox starts, and tells a single message apart", () => {
    expect(
      mboxStart(encoder.encode("﻿\n\nFrom a@b Sat Oct  3 14:02:00 2026\n")),
    ).toBe(5);
    expect(mboxStart(encoder.encode(message({})))).toBe(-1);
    expect(mboxStart(encoder.encode("From: alice@example.com\r\n"))).toBe(-1);
    expect(
      separatorDate("From x Sat Oct  3 14:02:00 2026")?.toISOString(),
    ).toBe("2026-10-03T14:02:00.000Z");
  });
});

describe("labels", () => {
  it("parses quoted, encoded and Gmail labels", () => {
    expect(
      parseLabels(
        'Inbox, "Clients, VIP", =?UTF-8?B?w4lxdWlwZQ==?=,Category Updates',
      ),
    ).toEqual(["Inbox", "Clients, VIP", "Équipe", "Category Updates"]);
  });

  it("maps labels to state", () => {
    const state = (
      labels: string,
      direction: "received" | "sent" = "received",
    ) => labelState(labels, direction);
    expect(state("Inbox,Starred,Clients")).toEqual({
      archived: false,
      spam: false,
      trashed: false,
      starred: true,
      folders: ["Clients"],
    });
    expect(state("Opened,Category Updates")).toMatchObject({
      archived: true,
      folders: [],
    });
    expect(state("Spam")).toMatchObject({ spam: true, archived: false });
    expect(state("Trash,Spam")).toMatchObject({ trashed: true, spam: false });
    expect(state("Sent", "sent")).toMatchObject({ archived: false });
    expect(labelState(undefined, "received")).toMatchObject({
      archived: false,
    });
    // Our own export's header reads the same way.
    expect(labelState("", "received")).toMatchObject({
      archived: true,
    });
  });
});

describe("the storage helpers", () => {
  beforeEach(async () => {
    await createTestUser({ id: "admin-1" });
  });

  it("stores imported mail as read history that keeps its person's activity", async () => {
    const recent = Math.floor(Date.now() / 1000);
    await createTestPerson({ id: "p1", email: "alice@example.com" });
    await getDb()
      .update(people)
      .set({ lastEmailAt: recent, unreadCount: 1, totalCount: 1 })
      .where(eq(people.id, "p1"));
    const parsed = await parseRawEmail(
      encoder.encode(
        message({
          cc: "Carol <carol@example.com>",
          headers: ["Reply-To: billing@other.example"],
        }),
      ).buffer,
    );
    const stored = await storeReceivedMessage(getDb(), env, {
      parsed,
      inbox: INBOX,
      fromAddress: "alice@example.com",
      receivedAt: 1_780_000_000,
      now: recent,
      source: "import",
      ourDomains: ["saasmail.test"],
    });
    const [row] = await getDb()
      .select()
      .from(emails)
      .where(eq(emails.id, stored.emailId));
    expect(row).toMatchObject({
      personId: "p1",
      recipient: INBOX,
      isRead: 1,
      spamProbability: null,
      receivedAt: 1_780_000_000,
    });
    expect(JSON.parse(row.cc!)).toEqual([
      { email: "carol@example.com", name: "Carol" },
    ]);
    expect(JSON.parse(row.replyTo!)[0].email).toBe("billing@other.example");
    expect(row.conversationId).not.toBeNull();
    expect(await env.R2.head(row.rawR2Key!)).not.toBeNull();
    const [person] = await getDb()
      .select()
      .from(people)
      .where(eq(people.id, "p1"));
    expect(person).toMatchObject({
      unreadCount: 1,
      totalCount: 2,
      lastEmailAt: recent,
    });
  });

  it("stores a sent message with its recipients, without counting", async () => {
    const parsed = await parseRawEmail(
      encoder.encode(
        message({
          from: INBOX,
          to: "Bob <bob@example.com>, dan@example.com",
          cc: "carol@example.com",
          headers: ["Bcc: eve@example.com", "In-Reply-To: <x@example.com>"],
          subject: "Quote",
        }),
      ).buffer,
    );
    const stored = await storeSentMessage(getDb(), env, {
      parsed,
      inbox: INBOX,
      sentAt: 1_780_000_000,
      now: 1_780_000_100,
      ourDomains: [],
    });
    const [row] = await getDb()
      .select()
      .from(sentEmails)
      .where(eq(sentEmails.id, stored!.sentId));
    expect(row).toMatchObject({
      fromAddress: INBOX,
      toAddress: "bob@example.com",
      subject: "Quote",
      status: "sent",
      inReplyTo: "<x@example.com>",
      sentAt: 1_780_000_000,
    });
    expect(JSON.parse(row.additionalTo!)).toEqual([
      { email: "dan@example.com", name: null },
    ]);
    expect(JSON.parse(row.bcc!)[0].email).toBe("eve@example.com");
    const [person] = await getDb()
      .select()
      .from(people)
      .where(eq(people.email, "bob@example.com"));
    expect(person).toMatchObject({ unreadCount: 0, totalCount: 0 });
  });
});

describe("the import job", () => {
  beforeEach(async () => {
    await createTestUser({ id: "admin-1" });
  });

  it("imports by direction, counts what it skips, and re-imports nothing", async () => {
    const file = mbox([
      message({ subject: "To us", id: "one@example.com" }),
      message({
        from: INBOX,
        to: "bob@example.com",
        subject: "From us",
        id: "two@example.com",
      }),
      message({ to: "someone@else.example", subject: "Not ours" }),
    ]);
    const job = await importFile(file);
    expect(job.status).toBe("running");
    await runAll(job.id);
    const done = await jobRow(job.id);
    expect(done).toMatchObject({
      status: "completed",
      processedRows: 3,
      importedCount: 2,
      skippedCount: 1,
    });
    expect(JSON.parse(done.errorSummary!)).toEqual([
      { row: 3, reason: `not addressed to ${INBOX}: Not ours` },
    ]);
    const received = await getDb().select().from(emails);
    expect(received.map((r) => r.subject)).toEqual(["To us"]);
    expect(received[0].isRead).toBe(1);
    expect(received[0].receivedAt).toBe(
      Date.parse("2026-06-01T10:00:00Z") / 1000,
    );
    const sent = await getDb().select().from(sentEmails);
    expect(sent.map((r) => r.subject)).toEqual(["From us"]);

    // The same file again: everything is a duplicate or not ours.
    const again = await importFile(file);
    await runAll(again.id);
    expect(await jobRow(again.id)).toMatchObject({
      importedCount: 0,
      skippedCount: 3,
    });
    expect(await getDb().select().from(emails)).toHaveLength(1);
  });

  it("stores everything not from the inbox as received with all_received", async () => {
    const job = await importFile(
      mbox([message({ to: "old-address@gone.example", subject: "Old" })]),
      { direction: "all_received" },
    );
    await runAll(job.id);
    expect(await jobRow(job.id)).toMatchObject({ importedCount: 1 });
    const [row] = await getDb().select().from(emails);
    expect(row.recipient).toBe(INBOX);
  });

  it("restores state from labels, creating each folder once", async () => {
    const job = await importFile(
      mbox([
        message({ subject: "Kept", labels: "Inbox,Starred,Clients" }),
        message({ subject: "Archived", labels: "Opened,Clients" }),
        message({ subject: "Junked", labels: "Spam" }),
        message({ subject: "Binned", labels: "Trash" }),
        message({ subject: "Plain" }),
      ]),
    );
    await runAll(job.id);
    const rows = await getDb().all<{
      subject: string;
      archived_at: number | null;
      spam_at: number | null;
      trashed_at: number | null;
      starred_at: number | null;
      folders: string | null;
    }>(sql`
      SELECT e.subject, s.archived_at, s.spam_at, s.trashed_at, u.starred_at,
        (SELECT group_concat(m.name) FROM message_mailboxes mm JOIN mailboxes m ON m.id = mm.mailbox_id
          WHERE mm.message_kind = 'received' AND mm.message_id = e.id) AS folders
      FROM emails e
      LEFT JOIN mailbox_message_state s ON s.message_kind = 'received' AND s.message_id = e.id
      LEFT JOIN message_user_state u ON u.message_kind = 'received' AND u.message_id = e.id AND u.user_id = 'admin-1'
      ORDER BY e.subject
    `);
    const by = Object.fromEntries(rows.map((row) => [row.subject, row]));
    expect(by.Kept).toMatchObject({ archived_at: null, folders: "Clients" });
    expect(by.Kept.starred_at).not.toBeNull();
    expect(by.Archived.archived_at).not.toBeNull();
    expect(by.Archived.folders).toBe("Clients");
    expect(by.Junked.spam_at).not.toBeNull();
    expect(by.Binned.trashed_at).not.toBeNull();
    expect(by.Plain).toMatchObject({
      archived_at: null,
      spam_at: null,
      trashed_at: null,
      folders: null,
    });
    const folders = await getDb().all<{ n: number }>(
      sql`SELECT COUNT(*) AS n FROM mailboxes WHERE inbox = ${INBOX} AND name = 'Clients'`,
    );
    expect(Number(folders[0].n)).toBe(1);
  });

  it("runs no rules, sends no notices but one refresh, and never trains the filter", async () => {
    const now = Math.floor(Date.now() / 1000);
    await getDb()
      .insert(rules)
      .values({
        id: "r1",
        name: "Archive everything",
        inbox: INBOX,
        trigger: "message.received",
        conditions: [],
        actions: [{ type: "archive" }],
        position: 0,
        stopProcessing: 0,
        enabled: 1,
        matchCount: 0,
        createdAt: now,
        updatedAt: now,
      });
    await setSpamFilterEnabled(getDb(), INBOX, true);
    const hub = (env as any).NOTIFICATIONS_HUB;
    const calls: { url: string; body: string }[] = [];
    (env as any).NOTIFICATIONS_HUB = {
      idFromName: (name: string) => name,
      get: () => ({
        fetch: async (request: Request) => {
          calls.push({ url: request.url, body: await request.text() });
          return new Response("ok");
        },
      }),
    };
    try {
      const job = await importFile(
        mbox([
          message({ subject: "One", labels: "Spam" }),
          message({ subject: "Two" }),
        ]),
      );
      await runAll(job.id);
    } finally {
      (env as any).NOTIFICATIONS_HUB = hub;
    }
    const [rule] = await getDb().select().from(rules);
    expect(rule.matchCount).toBe(0);
    expect(
      await getDb().all(
        sql`SELECT 1 FROM mailbox_message_state WHERE archived_at IS NOT NULL`,
      ),
    ).toEqual([]);
    expect(calls.every((call) => call.url.endsWith("/realtime"))).toBe(true);
    expect(calls.map((call) => JSON.parse(call.body).type)).toEqual([
      "mail_refresh",
      "import_done",
    ]);
    expect(await getDb().all(sql`SELECT 1 FROM spam_training`)).toEqual([]);
    const audit = await getDb().all<{ action: string; channel: string }>(
      sql`SELECT action, channel FROM audit_events WHERE action IN ('mail.spam', 'import.completed') ORDER BY action`,
    );
    expect(audit).toEqual([
      { action: "import.completed", channel: "import" },
      { action: "mail.spam", channel: "import" },
    ]);
  });

  it("works through a large file in slices at the byte cursor", async () => {
    const ops = IMPORT_LIMITS.sliceOps;
    IMPORT_LIMITS.sliceOps = 100_000;
    onTestFinished(() => {
      IMPORT_LIMITS.sliceOps = ops;
    });
    const file = mbox(
      Array.from({ length: 230 }, (_, i) =>
        message({ subject: `Bulk ${i}`, id: `bulk-${i}@example.com` }),
      ),
    );
    const job = await importFile(file);
    expect(await runMailImportSlice(getDb(), env, job.id, 0)).toBe(1);
    const half = await jobRow(job.id);
    expect(half.processedRows).toBe(200);
    expect(Number(half.cursor)).toBe(
      encoder.encode(file).length -
        encoder.encode(
          mbox(
            Array.from({ length: 30 }, (_, i) =>
              message({
                subject: `Bulk ${i + 200}`,
                id: `bulk-${i + 200}@example.com`,
              }),
            ),
          ),
        ).length,
    );
    // A late duplicate of slice 0 does nothing.
    expect(await runMailImportSlice(getDb(), env, job.id, 0)).toBeNull();
    expect(await runMailImportSlice(getDb(), env, job.id, 1)).toBeNull();
    expect(await jobRow(job.id)).toMatchObject({
      status: "completed",
      importedCount: 230,
    });
  });

  it("stops a slice on its budget of D1 and R2 calls", async () => {
    const job = await importFile(
      mbox(
        Array.from({ length: 100 }, (_, i) =>
          message({ subject: `Budget ${i}`, id: `budget-${i}@example.com` }),
        ),
      ),
    );
    expect(await runMailImportSlice(getDb(), env, job.id, 0)).toBe(1);
    expect((await jobRow(job.id)).processedRows).toBe(
      Math.ceil(IMPORT_LIMITS.sliceOps / 6),
    );
    let slice: number | null = importParams(await jobRow(job.id)).slice;
    while (slice !== null) {
      slice = await runMailImportSlice(getDb(), env, job.id, slice);
    }
    expect(await jobRow(job.id)).toMatchObject({
      status: "completed",
      importedCount: 100,
    });
  });

  it("skips a message larger than the limit, and goes on", async () => {
    const limits = { ...IMPORT_LIMITS };
    IMPORT_LIMITS.window = 256 * 1024;
    IMPORT_LIMITS.maxMessage = 1024 * 1024;
    onTestFinished(() => {
      Object.assign(IMPORT_LIMITS, limits);
    });
    const big = "z".repeat(76).concat("\r\n").repeat(20_000); // ~1.5 MB
    const job = await importFile(
      mbox([
        message({ subject: "Before" }),
        message({ subject: "Huge", body: big }),
        message({ subject: "After" }),
      ]),
    );
    await runAll(job.id);
    const done = await jobRow(job.id);
    expect(done).toMatchObject({ importedCount: 2, skippedCount: 1 });
    expect(JSON.parse(done.errorSummary!)).toEqual([
      { row: 2, reason: "a message larger than 1 MB was skipped" },
    ]);
    expect(
      (await getDb().select().from(emails)).map((r) => r.subject).sort(),
    ).toEqual(["After", "Before"]);
  });

  it("reads a message larger than the window", async () => {
    const big = "y".repeat(76).concat("\r\n").repeat(120_000); // ~9.4 MB
    const job = await importFile(
      mbox([
        message({ subject: "Small 1" }),
        message({ subject: "Big", body: big }),
        message({ subject: "Small 2" }),
      ]),
    );
    await runAll(job.id);
    expect(await jobRow(job.id)).toMatchObject({ importedCount: 3 });
    const rows = await getDb().select().from(emails);
    expect(rows.map((r) => r.subject).sort()).toEqual([
      "Big",
      "Small 1",
      "Small 2",
    ]);
    // The body is cut for D1; the message is whole in R2.
    const bigRow = rows.find((r) => r.subject === "Big")!;
    expect(bigRow.bodyText!.length).toBe(250_000);
    expect((await env.R2.head(bigRow.rawR2Key!))!.size).toBeGreaterThan(
      9_000_000,
    );
  });

  it("gives a message without a Message-ID a stable one", async () => {
    const file = mbox([message({ id: null, subject: "No id" })]);
    const first = await importFile(file);
    await runAll(first.id);
    const [row] = await getDb().select().from(emails);
    expect(row.messageId).toMatch(/^<import-[0-9a-f]{64}@saasmail\.local>$/);
    const second = await importFile(file);
    await runAll(second.id);
    expect(await jobRow(second.id)).toMatchObject({
      importedCount: 0,
      skippedCount: 1,
    });
  });

  it("imports a single .eml file", async () => {
    const job = await importFile(message({ subject: "Just one" }), {
      filename: "one.eml",
    });
    expect(await runAll(job.id)).toBe(1);
    expect(importParams(await jobRow(job.id)).format).toBe("eml");
    const [row] = await getDb().select().from(emails);
    expect(row.subject).toBe("Just one");
  });

  it("resumes a slice that failed mid-way without counting twice", async () => {
    const file = mbox([
      message({ subject: "A", id: "a@example.com" }),
      message({ subject: "B", id: "b@example.com" }),
      message({ subject: "C", id: "c@example.com" }),
    ]);
    const job = await importFile(file);
    // The D1 write of the second message fails once.
    const db = getDb();
    let inserts = 0;
    const failing = new Proxy(db, {
      get(target, property, receiver) {
        if (property === "insert") {
          return (table: unknown) => {
            if (table === emails && ++inserts === 2) {
              throw new Error("D1 is down");
            }
            return target.insert(table as typeof emails);
          };
        }
        return Reflect.get(target, property, receiver);
      },
    });
    await expect(runMailImportSlice(failing, env, job.id, 0)).rejects.toThrow(
      "D1 is down",
    );
    const partial = await jobRow(job.id);
    expect(partial).toMatchObject({ processedRows: 1, importedCount: 1 });
    expect(importParams(partial).slice).toBe(0);

    expect(await runMailImportSlice(getDb(), env, job.id, 0)).toBeNull();
    expect(await jobRow(job.id)).toMatchObject({
      status: "completed",
      processedRows: 3,
      importedCount: 3,
      skippedCount: 0,
    });
    const [alice] = await getDb()
      .select()
      .from(people)
      .where(eq(people.email, "alice@example.com"));
    expect(alice.totalCount).toBe(3);
  });

  it("skips a message too large for a row, leaving nothing of it", async () => {
    const job = await importFile(
      mbox([
        message({ subject: "One", id: "one@example.com" }),
        message({ subject: "Two", id: "two@example.com" }),
        message({ subject: "Three", id: "three@example.com" }),
      ]),
    );
    const rawsBefore = (await env.R2.list({ prefix: "inbound-raw/" })).objects
      .length;
    const db = getDb();
    let batches = 0;
    const tooBig = new Proxy(db, {
      get(target, property, receiver) {
        if (property === "batch") {
          return (queries: Parameters<typeof db.batch>[0]) => {
            if (++batches === 2) {
              // What Drizzle throws: the D1 error is the cause.
              throw new Error("Failed query: insert into emails …", {
                cause: new Error(
                  "D1_ERROR: string or blob too big: SQLITE_TOOBIG",
                ),
              });
            }
            return target.batch(queries);
          };
        }
        return Reflect.get(target, property, receiver);
      },
    });
    expect(await runMailImportSlice(tooBig, env, job.id, 0)).toBeNull();
    const done = await jobRow(job.id);
    expect(done).toMatchObject({
      status: "completed",
      importedCount: 2,
      skippedCount: 1,
    });
    expect(JSON.parse(done.errorSummary!)).toEqual([
      { row: 2, reason: "too large to store (its headers or bodies)" },
    ]);
    const rows = await getDb().select().from(emails);
    expect(rows.map((r) => r.subject).sort()).toEqual(["One", "Three"]);
    // Only the two stored messages left their raw bytes.
    expect((await env.R2.list({ prefix: "inbound-raw/" })).objects.length).toBe(
      rawsBefore + 2,
    );
    expect(rows.every((row) => row.importJobId === job.id)).toBe(true);
    const [alice] = await getDb()
      .select()
      .from(people)
      .where(eq(people.email, "alice@example.com"));
    expect(alice.totalCount).toBe(2);
  });

  it("labels and counts mail a crashed slice stored, on the retry", async () => {
    const job = await importFile(
      mbox([
        message({ subject: "A", id: "a@example.com", labels: "Opened" }),
        message({ subject: "B", id: "b@example.com", labels: "Opened" }),
        message({ subject: "C", id: "c@example.com", labels: "Opened" }),
      ]),
    );
    // The run dies after storing two messages, before saving anything.
    let calls = 0;
    const dying = () => {
      if (++calls === 6) throw new Error("exceeded CPU");
      return Date.now();
    };
    await expect(
      runMailImportSlice(getDb(), env, job.id, 0, dying),
    ).rejects.toThrow("exceeded CPU");
    expect(await getDb().select().from(emails)).toHaveLength(2);
    expect((await jobRow(job.id)).processedRows).toBe(0);

    expect(await runMailImportSlice(getDb(), env, job.id, 0)).toBeNull();
    expect(await jobRow(job.id)).toMatchObject({
      importedCount: 3,
      skippedCount: 0,
    });
    const archived = await getDb().all(
      sql`SELECT 1 FROM mailbox_message_state WHERE archived_at IS NOT NULL`,
    );
    expect(archived).toHaveLength(3);
    const [alice] = await getDb()
      .select()
      .from(people)
      .where(eq(people.email, "alice@example.com"));
    expect(alice.totalCount).toBe(3);
  });

  it("trusts only the labels an exporter put first, and skips drafts", async () => {
    const job = await importFile(
      mbox([
        message({
          subject: "Gmail said spam",
          labels: "Spam",
          headers: ["X-Gmail-Labels: Inbox,Starred,Pwned"],
        }),
        message({
          subject: "Sender says trash",
          headers: ["X-Saasmail-Labels: Trash"],
        }),
        message({
          from: INBOX,
          to: "bob@example.com",
          subject: "Unsent",
          labels: "Draft",
        }),
      ]),
    );
    await runAll(job.id);
    const done = await jobRow(job.id);
    expect(done).toMatchObject({ importedCount: 2, skippedCount: 1 });
    expect(JSON.parse(done.errorSummary!)).toEqual([
      { row: 3, reason: "a draft, never sent: Unsent" },
    ]);
    const rows = await getDb().all<{
      subject: string;
      spam_at: number | null;
      trashed_at: number | null;
    }>(sql`
      SELECT e.subject, s.spam_at, s.trashed_at FROM emails e
      LEFT JOIN mailbox_message_state s ON s.message_kind = 'received' AND s.message_id = e.id
      ORDER BY e.subject
    `);
    expect(rows[0]).toMatchObject({ subject: "Gmail said spam" });
    expect(rows[0].spam_at).not.toBeNull();
    expect(rows[1]).toMatchObject({
      subject: "Sender says trash",
      trashed_at: null,
    });
    expect(await getDb().select().from(sentEmails)).toEqual([]);
    expect(
      await getDb().all(sql`SELECT 1 FROM mailboxes WHERE name = 'Pwned'`),
    ).toEqual([]);
    expect(
      exporterLabels(
        encoder.encode(
          "X-GM-THRID: 1\r\nX-Gmail-Labels: Inbox,\r\n Work\r\nFrom: a@b.c\r\n",
        ),
      ),
    ).toBe("Inbox, Work");
  });

  it("matches Delivered-To exactly", async () => {
    const job = await importFile(
      mbox([
        message({
          to: "list@example.com",
          subject: "Delivered here",
          headers: [`Delivered-To: ${INBOX}`],
        }),
        message({
          to: "list@example.com",
          subject: "Delivered elsewhere",
          headers: [`Delivered-To: x${INBOX}`],
        }),
      ]),
    );
    await runAll(job.id);
    expect((await getDb().select().from(emails)).map((r) => r.subject)).toEqual(
      ["Delivered here"],
    );
  });

  it("knows a JMAP send by its own Message-ID", async () => {
    await getDb().run(sql`
      INSERT INTO jmap_message_content (id, inbox, from_json, to_json, cc_json, bcc_json, subject, message_id, sent_at, parts_json, text_body_json, html_body_json, attachments_json, body_values_json, preview, thread_key, raw_r2_key, size, created_at)
      VALUES ('c1', ${INBOX}, '{}', '[]', '[]', '[]', 'Hi', 'jmap-1@saasmail.test', '2026-06-01T10:00:00Z', '{}', '[]', '[]', '[]', '{}', '', 't1', 'k', 1, 0)
    `);
    await getDb().run(sql`
      INSERT INTO sent_emails (id, from_address, to_address, subject, message_id, status, jmap_content_id, sent_at, created_at)
      VALUES ('s1', ${INBOX}, 'bob@example.com', 'Hi', '<provider-id@mail.example>', 'sent', 'c1', 1, 1)
    `);
    const job = await importFile(
      mbox([
        message({
          from: INBOX,
          to: "bob@example.com",
          subject: "Hi",
          id: "jmap-1@saasmail.test",
        }),
      ]),
    );
    await runAll(job.id);
    expect(await jobRow(job.id)).toMatchObject({
      importedCount: 0,
      skippedCount: 1,
    });
  });

  it("skips a message that kept failing, and goes on", async () => {
    const file = mbox([
      message({ subject: "First", id: "first@example.com" }),
      message({ subject: "Poison", id: "poison@example.com" }),
      message({ subject: "Last", id: "last@example.com" }),
    ]);
    const job = await importFile(file);
    const db = getDb();
    let batches = 0;
    const failing = new Proxy(db, {
      get(target, property, receiver) {
        if (property === "batch") {
          return (queries: Parameters<typeof db.batch>[0]) => {
            if (++batches === 2) throw new Error("D1 timed out");
            return target.batch(queries);
          };
        }
        return Reflect.get(target, property, receiver);
      },
    });
    await expect(runMailImportSlice(failing, env, job.id, 0)).rejects.toThrow(
      "D1 timed out",
    );
    // The queue gave up on it: the message is skipped with a note.
    expect(await skipStuckMessage(getDb(), env, job.id, "D1 timed out")).toBe(
      0,
    );
    expect(await runMailImportSlice(getDb(), env, job.id, 0)).toBeNull();
    const done = await jobRow(job.id);
    expect(done).toMatchObject({
      status: "completed",
      importedCount: 2,
      skippedCount: 1,
    });
    expect(JSON.parse(done.errorSummary!)).toEqual([
      { row: 2, reason: "could not be stored and was skipped: D1 timed out" },
    ]);
    expect(
      (await getDb().select().from(emails)).map((r) => r.subject).sort(),
    ).toEqual(["First", "Last"]);
  });

  it("stops when cancelled, keeping what it imported", async () => {
    const job = await importFile(
      mbox(
        Array.from({ length: 210 }, (_, i) =>
          message({ subject: `M ${i}`, id: `m-${i}@example.com` }),
        ),
      ),
    );
    expect(await runMailImportSlice(getDb(), env, job.id, 0)).toBe(1);
    const kept = (await jobRow(job.id)).importedCount;
    expect(kept).toBeGreaterThan(0);
    await deleteMailImport(getDb(), env, await jobRow(job.id));
    expect(await runMailImportSlice(getDb(), env, job.id, 1)).toBeNull();
    expect(await env.R2.head(job.storageKey!)).toBeNull();
    expect(await getDb().select().from(emails)).toHaveLength(kept);
  });

  it("deletes the file a day after, and gives up unfinished uploads", async () => {
    const now = Math.floor(Date.now() / 1000);
    const done = await importFile(mbox([message({ subject: "x" })]));
    await runAll(done.id);
    await getDb()
      .update(asyncJobs)
      .set({ updatedAt: now - 25 * 60 * 60 })
      .where(eq(asyncJobs.id, done.id));
    const upload = await startMailImport(getDb(), env, {
      inbox: INBOX,
      filename: "never.mbox",
      size: 10,
      direction: "strict",
      createFoldersFromLabels: false,
      userId: "admin-1",
    });
    await getDb()
      .update(asyncJobs)
      .set({ updatedAt: now - 25 * 60 * 60 })
      .where(eq(asyncJobs.id, upload.id));

    expect(await reapMailImports(getDb(), env, now)).toMatchObject({
      sourcesDeleted: 1,
      failed: 1,
    });
    expect(await env.R2.head(done.storageKey!)).toBeNull();
    expect(importParams(await jobRow(done.id)).sourceDeleted).toBe(true);
    expect((await jobRow(upload.id)).status).toBe("failed");
  });
});

describe("the import API", () => {
  const queue = (env as any).EMAIL_QUEUE;
  let sent: unknown[];
  let adminKey: string;
  let memberKey: string;

  beforeEach(async () => {
    sent = [];
    (env as any).EMAIL_QUEUE = {
      send: async (body: unknown) => void sent.push(body),
    };
    ({ apiKey: adminKey } = await createTestUser({
      id: "admin-1",
      email: "admin@example.com",
    }));
    ({ apiKey: memberKey } = await createTestUser({
      id: "user-aa",
      role: "member",
      email: "aa@example.com",
    }));
    await getDb()
      .insert(inboxPermissions)
      .values({ userId: "user-aa", email: INBOX, createdAt: 1 });
    await getDb().run(
      sql`INSERT INTO sender_identities (email, created_at, updated_at) VALUES (${INBOX}, 1, 1)`,
    );
  });

  afterEach(() => {
    (env as any).EMAIL_QUEUE = queue;
  });

  const create = (key: string, size: number) =>
    authFetch("/api/admin/imports", {
      method: "POST",
      apiKey: key,
      body: JSON.stringify({ inbox: INBOX, filename: "mail.mbox", size }),
    });

  it("is for admins only", async () => {
    expect((await create(memberKey, 10)).status).toBe(403);
    expect(
      (await authFetch("/api/admin/imports", { apiKey: memberKey })).status,
    ).toBe(403);
  });

  it("imports only into an inbox", async () => {
    const res = await authFetch("/api/admin/imports", {
      method: "POST",
      apiKey: adminKey,
      body: JSON.stringify({
        inbox: "nobody@saasmail.test",
        filename: "x.mbox",
        size: 10,
      }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe("UNKNOWN_INBOX");
    expect(
      classifyQueueMessage({ type: "mail_import", jobId: "j", slice: 0 }),
    ).toBe("mail_import");
  });

  it("lists the newest first, also within one second", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      ids.push(
        ((await (await create(adminKey, 10)).json()) as { id: string }).id,
      );
    }
    const listed = (await (
      await authFetch("/api/admin/imports", { apiKey: adminKey })
    ).json()) as { imports: { id: string }[] };
    expect(listed.imports.map((entry) => entry.id)).toEqual(ids.reverse());
  });

  it("uploads, completes and queues the first slice", async () => {
    const bytes = encoder.encode(mbox([message({ subject: "Via API" })]));
    const res = await create(adminKey, bytes.length);
    expect(res.status).toBe(201);
    const created = (await res.json()) as {
      id: string;
      status: string;
      partsExpected: number;
    };
    expect(created).toMatchObject({ status: "uploading", partsExpected: 1 });

    const early = await authFetch(`/api/admin/imports/${created.id}/complete`, {
      method: "POST",
      apiKey: adminKey,
    });
    expect(early.status).toBe(400);
    expect(((await early.json()) as { code: string }).code).toBe(
      "PARTS_MISSING",
    );

    const wrong = await authFetch(`/api/admin/imports/${created.id}/parts/1`, {
      method: "PUT",
      apiKey: adminKey,
      body: bytes.subarray(1),
    });
    expect(wrong.status).toBe(400);
    expect(((await wrong.json()) as { code: string }).code).toBe(
      "INVALID_PART_SIZE",
    );
    const outOfRange = await authFetch(
      `/api/admin/imports/${created.id}/parts/2`,
      { method: "PUT", apiKey: adminKey, body: bytes },
    );
    expect(outOfRange.status).toBe(400);

    const part = await authFetch(`/api/admin/imports/${created.id}/parts/1`, {
      method: "PUT",
      apiKey: adminKey,
      body: bytes,
    });
    expect(part.status).toBe(200);
    expect(await part.json()).toEqual({ partNumber: 1, partsUploaded: 1 });

    const complete = await authFetch(
      `/api/admin/imports/${created.id}/complete`,
      { method: "POST", apiKey: adminKey },
    );
    expect(complete.status).toBe(202);
    expect(sent).toEqual([
      { type: "mail_import", jobId: created.id, slice: 0 },
    ]);
    const audit = await getDb().all<{ action: string }>(
      sql`SELECT action FROM audit_events WHERE action = 'import.started'`,
    );
    expect(audit).toHaveLength(1);

    await runAll(created.id);
    const shown = (await (
      await authFetch(`/api/admin/imports/${created.id}`, { apiKey: adminKey })
    ).json()) as Record<string, unknown>;
    expect(shown).toMatchObject({
      status: "completed",
      importedMessages: 1,
      bytesRead: bytes.length,
    });
    const listed = (await (
      await authFetch("/api/admin/imports", { apiKey: adminKey })
    ).json()) as { imports: { id: string }[] };
    expect(listed.imports.map((entry) => entry.id)).toEqual([created.id]);

    const removed = await authFetch(`/api/admin/imports/${created.id}`, {
      method: "DELETE",
      apiKey: adminKey,
    });
    expect(removed.status).toBe(200);
    expect(await importJobById(getDb(), created.id)).toBeNull();
    // Imported mail stays.
    expect(await getDb().select().from(emails)).toHaveLength(1);
  });
});
