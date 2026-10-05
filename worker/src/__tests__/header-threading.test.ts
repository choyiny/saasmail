// docs/inboxes.md: an inbox can group its mail into
// threads by In-Reply-To/References instead of by customer.
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { eq, sql } from "drizzle-orm";
import { asyncJobs } from "../db/async-jobs.schema";
import { auditEvents as auditLog } from "../db/audit-events.schema";
import { emails } from "../db/emails.schema";
import { inboxConversationState } from "../db/inbox-conversation-state.schema";
import { jmapMessageContent } from "../db/jmap-message-content.schema";
import { senderIdentities } from "../db/sender-identities.schema";
import { sentEmails } from "../db/sent-emails.schema";
import { handleEmail } from "../email-handler";
import type { EmailSender, SendEmailResult } from "../lib/email-sender";
import { snoozeConversations } from "../lib/messages/conversation-state";
import {
  BACKFILL_LIMITS,
  failThreadBackfill,
  insertThreadBackfill,
  rethreadAfterImport,
  runThreadBackfillSlice,
} from "../lib/messages/thread-backfill";
import {
  citedIdsOf,
  resolveThreadKey,
  threadKeyOf,
} from "../lib/messages/thread-key";
import { replyToEmail, sendEmail } from "../lib/send-email";
import { bumpJmapEpoch, readJmapEpoch } from "../jmap/epoch";
import { publicAccountId } from "../jmap/public-ids";
import {
  applyMigrations,
  authFetch,
  cleanDb,
  createTestPerson,
  createTestUser,
  getDb,
} from "./helpers";
import { ALL_CAPABILITIES, recordingSender, runJmap } from "./jmap-harness";
import { acct, rid, thread } from "./jmap-ids";

const INBOX = "support@saasmail.test";
const OTHER_INBOX = "billing@saasmail.test";
const ADMIN = { isAdmin: true } as const;
const bindings = env as unknown as CloudflareBindings;

async function identity(email: string, mode: "relationship" | "headers") {
  await getDb()
    .insert(senderIdentities)
    .values({ email, threadingMode: mode, createdAt: 1, updatedAt: 1 })
    .onConflictDoUpdate({
      target: senderIdentities.email,
      set: { threadingMode: mode },
    });
}

async function received(
  id: string,
  opts: {
    messageId: string | null;
    inReplyTo?: string | null;
    references?: string | null;
    at?: number;
    inbox?: string;
    personId?: string;
    threadKey?: string | null;
    replyTo?: string | null;
  },
) {
  await getDb()
    .insert(emails)
    .values({
      id,
      personId: opts.personId ?? "p1",
      recipient: opts.inbox ?? INBOX,
      subject: `Subject ${id}`,
      bodyHtml: null,
      bodyText: id,
      rawHeaders: "{}",
      messageId: opts.messageId,
      inReplyTo: opts.inReplyTo ?? null,
      referencesHeader: opts.references ?? null,
      threadKey: opts.threadKey ?? null,
      replyTo: opts.replyTo ?? null,
      isRead: 0,
      receivedAt: opts.at ?? 1_000,
      createdAt: opts.at ?? 1_000,
    });
}

async function sent(
  id: string,
  opts: {
    messageId: string | null;
    inReplyTo?: string | null;
    at?: number;
    inbox?: string;
    threadKey?: string | null;
    jmapContentId?: string;
  },
) {
  await getDb()
    .insert(sentEmails)
    .values({
      id,
      personId: "p1",
      fromAddress: opts.inbox ?? INBOX,
      toAddress: "alice@example.com",
      subject: `Subject ${id}`,
      bodyHtml: "<p>hi</p>",
      bodyText: "hi",
      inReplyTo: opts.inReplyTo ?? null,
      messageId: opts.messageId,
      status: "sent",
      threadKey: opts.threadKey ?? null,
      jmapContentId: opts.jmapContentId ?? null,
      sentAt: opts.at ?? 1_000,
      createdAt: opts.at ?? 1_000,
    });
}

async function jmapContent(id: string, messageId: string, threadKey: string) {
  await getDb()
    .insert(jmapMessageContent)
    .values({
      id,
      inbox: INBOX,
      fromJson: JSON.stringify([{ email: INBOX, name: null }]),
      toJson: JSON.stringify([{ email: "alice@example.com", name: null }]),
      ccJson: "[]",
      bccJson: "[]",
      subject: "JMAP send",
      messageId,
      sentAt: "2026-10-01T00:00:00Z",
      partsJson: "[]",
      textBodyJson: "[]",
      htmlBodyJson: "[]",
      attachmentsJson: "[]",
      bodyValuesJson: "{}",
      preview: "",
      threadKey,
      rawR2Key: `jmap/${id}`,
      size: 10,
      createdAt: 1,
    });
}

const keyOf = async (table: "emails" | "sent_emails", id: string) => {
  const [row] = await getDb().all<{ thread_key: string | null }>(
    sql`SELECT thread_key FROM ${sql.raw(table)} WHERE id = ${id}`,
  );
  return row?.thread_key ?? null;
};

function recorder(): EmailSender {
  return {
    provider: "demo" as const,
    async send(): Promise<SendEmailResult> {
      return { id: "provider-1", error: null };
    },
    maxAttachmentBytes: () => 25 * 1024 * 1024,
    maxMessageBytes: () => 25 * 1024 * 1024,
  };
}

beforeAll(async () => {
  await applyMigrations();
});

beforeEach(async () => {
  await cleanDb();
  await createTestPerson({ id: "p1", email: "alice@example.com" });
});

describe("citedIdsOf", () => {
  it("puts In-Reply-To first, then References from the last, once each", () => {
    expect(citedIdsOf("<b@x>", "<root@x> <a@x> <b@x>")).toEqual([
      "b@x",
      "a@x",
      "root@x",
    ]);
    expect(citedIdsOf("bare@x", null)).toEqual(["bare@x"]);
    expect(citedIdsOf(null, null)).toEqual([]);
    // A bare In-Reply-To still comes first beside bracketed References.
    expect(citedIdsOf("bare@x", "<root@x> <bare@x>")).toEqual([
      "bare@x",
      "root@x",
    ]);
    const many = Array.from({ length: 30 }, (_, i) => `<m${i}@x>`).join(" ");
    expect(citedIdsOf(null, many)).toHaveLength(20);
    expect(citedIdsOf(null, many)[0]).toBe("m29@x");
  });
});

describe("resolveThreadKey", () => {
  const db = () => getDb();

  it("joins the thread of the message In-Reply-To names", async () => {
    await received("r1", { messageId: "<root@x>", threadKey: "t:root" });
    expect(
      await resolveThreadKey(db(), {
        inbox: INBOX,
        messageId: "<reply@x>",
        citedIds: citedIdsOf("<root@x>", null),
      }),
    ).toBe("t:root");
  });

  it("falls back to a later References id when the parent is unknown", async () => {
    await received("r1", { messageId: "<root@x>", threadKey: "t:root" });
    expect(
      await resolveThreadKey(db(), {
        inbox: INBOX,
        messageId: "<c@x>",
        citedIds: citedIdsOf("<missing@x>", "<root@x> <missing@x>"),
      }),
    ).toBe("t:root");
  });

  it("prefers the nearest citation", async () => {
    await received("r1", { messageId: "<root@x>", threadKey: "t:root" });
    await received("r2", { messageId: "<mid@x>", threadKey: "t:mid" });
    expect(
      await resolveThreadKey(db(), {
        inbox: INBOX,
        messageId: "<c@x>",
        citedIds: citedIdsOf("<mid@x>", "<root@x> <mid@x>"),
      }),
    ).toBe("t:mid");
  });

  it("crosses received and sent mail, and a JMAP send's own Message-ID", async () => {
    await sent("s1", { messageId: "<ours@saasmail.test>", threadKey: "t:s" });
    expect(
      await resolveThreadKey(db(), {
        inbox: INBOX,
        messageId: "<c@x>",
        citedIds: ["ours@saasmail.test"],
      }),
    ).toBe("t:s");

    await jmapContent("c1", "client-id@saasmail.test", "t:j");
    await sent("s2", {
      messageId: "<provider-id@cloudflare>",
      threadKey: "t:j",
      jmapContentId: "c1",
    });
    expect(
      await resolveThreadKey(db(), {
        inbox: INBOX,
        messageId: "<d@x>",
        citedIds: ["client-id@saasmail.test"],
      }),
    ).toBe("t:j");
  });

  it("roots a new thread at its own Message-ID, or a random one", async () => {
    expect(
      await resolveThreadKey(db(), {
        inbox: INBOX,
        messageId: "<alone@x>",
        citedIds: [],
      }),
    ).toBe(await threadKeyOf("alone@x"));
    expect(await threadKeyOf("<alone@x>")).toBe(await threadKeyOf("alone@x"));
    const random = await resolveThreadKey(db(), {
      inbox: INBOX,
      messageId: null,
      citedIds: ["unknown@x"],
    });
    expect(random).toMatch(/^t:[0-9a-f]{64}$/);
    expect(random).not.toBe(await threadKeyOf(null));
  });

  it("never joins a message of another inbox", async () => {
    await received("r1", {
      messageId: "<root@x>",
      threadKey: "t:other",
      inbox: OTHER_INBOX,
    });
    expect(
      await resolveThreadKey(db(), {
        inbox: INBOX,
        messageId: "<reply@x>",
        citedIds: ["root@x"],
      }),
    ).toBe(await threadKeyOf("reply@x"));
  });
});

function inbound(
  messageId: string,
  headers: string[],
): ForwardableEmailMessage {
  const raw = new TextEncoder().encode(
    [
      "From: Alice <alice@example.com>",
      `To: ${INBOX}`,
      "Subject: Order",
      `Message-ID: <${messageId}>`,
      ...headers,
      "MIME-Version: 1.0",
      "Content-Type: text/plain; charset=utf-8",
      "",
      "hello",
    ].join("\r\n"),
  );
  return {
    from: "alice@example.com",
    to: INBOX,
    raw: new Response(raw).body!,
    rawSize: raw.byteLength,
    headers: new Headers(),
    setReject() {},
    async forward() {},
    async reply() {},
  } as unknown as ForwardableEmailMessage;
}

async function deliver(messageId: string, headers: string[] = []) {
  const pending: Promise<unknown>[] = [];
  await handleEmail(inbound(messageId, headers), bindings, {
    waitUntil: (p: Promise<unknown>) => void pending.push(p),
    passThroughOnException() {},
  } as unknown as ExecutionContext);
  await Promise.allSettled(pending);
  const [row] = await getDb()
    .select()
    .from(emails)
    .where(eq(emails.messageId, `<${messageId}>`));
  return row!;
}

describe("thread keys on the write paths", () => {
  it("leaves a relationship inbox's mail without one", async () => {
    await identity(INBOX, "relationship");
    const first = await deliver("one@example.com");
    const reply = await deliver("two@example.com", [
      "In-Reply-To: <one@example.com>",
    ]);
    expect(first.threadKey).toBeNull();
    expect(reply.threadKey).toBeNull();
  });

  it("threads a headers inbox's mail by its headers, not by person", async () => {
    await identity(INBOX, "headers");
    const first = await deliver("one@example.com");
    const reply = await deliver("two@example.com", [
      "In-Reply-To: <one@example.com>",
      "References: <one@example.com>",
    ]);
    const other = await deliver("three@example.com");
    expect(first.threadKey).toBe(await threadKeyOf("one@example.com"));
    expect(reply.threadKey).toBe(first.threadKey);
    expect(other.threadKey).toBe(await threadKeyOf("three@example.com"));
  });

  it("puts a reply in its thread and a new message in a thread of its own", async () => {
    await identity(INBOX, "headers");
    const first = await deliver("one@example.com");
    const replied = await replyToEmail({
      db: getDb(),
      env: bindings,
      emailId: first.id,
      payload: { fromAddress: INBOX, bodyHtml: "<p>thanks</p>" },
      files: [],
      allowed: ADMIN,
      sender: recorder(),
    });
    expect(replied.ok).toBe(true);
    const fresh = await sendEmail({
      db: getDb(),
      env: bindings,
      payload: {
        fromAddress: INBOX,
        to: "alice@example.com",
        subject: "News",
        bodyHtml: "<p>hello</p>",
      },
      files: [],
      allowed: ADMIN,
      sender: recorder(),
    });
    const rows = await getDb()
      .select({
        id: sentEmails.id,
        threadKey: sentEmails.threadKey,
        inReplyTo: sentEmails.inReplyTo,
      })
      .from(sentEmails);
    const reply = rows.find((row) => row.inReplyTo);
    const other = rows.find((row) => row.id === fresh.id);
    expect(reply?.threadKey).toBe(first.threadKey);
    expect(other?.threadKey).toMatch(/^t:/);
    expect(other?.threadKey).not.toBe(first.threadKey);
  });

  it("puts a reply to a message without a Message-ID in its thread", async () => {
    await identity(INBOX, "headers");
    await received("orig", { messageId: null, threadKey: "t:orig" });
    const replied = await replyToEmail({
      db: getDb(),
      env: bindings,
      emailId: "orig",
      payload: { fromAddress: INBOX, bodyHtml: "<p>thanks</p>" },
      files: [],
      allowed: ADMIN,
      sender: recorder(),
    });
    expect(replied.ok).toBe(true);
    const [row] = await getDb()
      .select({ threadKey: sentEmails.threadKey })
      .from(sentEmails);
    expect(row!.threadKey).toBe("t:orig");
  });

  it("snoozes a thread, not the customer, in a headers inbox", async () => {
    await identity(INBOX, "headers");
    const first = await deliver("one@example.com");
    const other = await deliver("three@example.com");
    const until = Math.floor(Date.now() / 1000) + 3600;
    await snoozeConversations(
      getDb(),
      ADMIN,
      null,
      [{ kind: "received", id: first.id }],
      until,
    );
    const states = await getDb().select().from(inboxConversationState);
    expect(states.map((state) => state.conversationKey)).toEqual([
      first.threadKey,
    ]);
    expect(other.threadKey).not.toBe(first.threadKey);
  });
});

describe("switching an inbox's conversation mode", () => {
  const queue = (env as any).EMAIL_QUEUE;
  const limits = { ...BACKFILL_LIMITS };
  let queued: { type: string; jobId: string; slice: number }[];
  let adminKey: string;

  beforeEach(async () => {
    queued = [];
    (env as any).EMAIL_QUEUE = {
      send: async (body: any) => void queued.push(body),
    };
    ({ apiKey: adminKey } = await createTestUser({
      id: "admin-1",
      email: "admin@example.com",
    }));
    await identity(INBOX, "relationship");
  });

  afterEach(() => {
    (env as any).EMAIL_QUEUE = queue;
    Object.assign(BACKFILL_LIMITS, limits);
  });

  const patch = (body: Record<string, unknown>) =>
    authFetch(`/api/admin/inboxes/${encodeURIComponent(INBOX)}`, {
      method: "PATCH",
      apiKey: adminKey,
      body: JSON.stringify(body),
    });

  /** Runs every slice of the job, as the queue would. */
  async function drain(jobId: string) {
    let slice: number | null = 0;
    let slices = 0;
    while (slice !== null) {
      slice = await runThreadBackfillSlice(getDb(), bindings, jobId, slice);
      slices++;
      expect(slices).toBeLessThan(200);
    }
    return slices;
  }

  /**
   * C (oldest) replies to P, which arrives later; G replies to C; S is our
   * reply to P; U is unrelated; M is mail of another inbox.
   */
  async function fixture() {
    await received("u", { messageId: "<u@x>", at: 50 });
    await received("c", { messageId: "<c@x>", inReplyTo: "<p@x>", at: 100 });
    await received("p", { messageId: "<p@x>", at: 200 });
    await sent("s", {
      messageId: "<s@saasmail.test>",
      inReplyTo: "<p@x>",
      at: 250,
      jmapContentId: "content-s",
    });
    await jmapContent("content-s", "s-own@saasmail.test", "p:p1");
    await received("g", {
      messageId: "<g@x>",
      inReplyTo: "<c@x>",
      references: "<p@x> <c@x>",
      at: 300,
    });
    await received("n", { messageId: null, at: 400 });
    await received("m", {
      messageId: "<m@x>",
      inReplyTo: "<p@x>",
      at: 150,
      inbox: OTHER_INBOX,
    });
  }

  it("groups the inbox by thread in slices, a late parent included", async () => {
    await fixture();
    const now = Math.floor(Date.now() / 1000);
    await getDb()
      .insert(inboxConversationState)
      .values([
        {
          inbox: INBOX,
          conversationKey: "p:p1",
          snoozedUntil: now + 99,
          updatedAt: now,
        },
        {
          inbox: INBOX,
          conversationKey: "c:1",
          assignedUserId: "admin-1",
          updatedAt: now,
        },
        {
          inbox: OTHER_INBOX,
          conversationKey: "p:p1",
          snoozedUntil: now + 99,
          updatedAt: now,
        },
      ]);
    BACKFILL_LIMITS.pageSize = 2;
    BACKFILL_LIMITS.sliceStatements = 2;

    const res = await patch({ threadingMode: "headers" });
    expect(res.status).toBe(200);
    const body = await res.json<any>();
    expect(body.threadingMode).toBe("headers");
    expect(body.threadBackfill).toMatchObject({
      mode: "headers",
      status: "running",
      processed: 0,
      total: 12,
    });
    expect(queued).toEqual([
      { type: "thread_backfill", jobId: body.threadBackfill.id, slice: 0 },
    ]);
    const states = await getDb().select().from(inboxConversationState);
    expect(states.map((state) => state.inbox)).toEqual([OTHER_INBOX]);
    const [switched] = await getDb()
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "inbox.updated"));
    expect(JSON.parse(switched!.details!)).toMatchObject({
      threadingMode: { from: "relationship", to: "headers" },
      clearedConversationStates: 2,
    });
    // A second switch while this one runs changes nothing.
    const again = await patch({ threadingMode: "relationship" });
    expect(again.status).toBe(409);
    const [mode] = await getDb()
      .select({ mode: senderIdentities.threadingMode })
      .from(senderIdentities)
      .where(eq(senderIdentities.email, INBOX));
    expect(mode!.mode).toBe("headers");

    expect(await readJmapEpoch(getDb())).toBe(0);
    expect(await drain(body.threadBackfill.id)).toBeGreaterThan(3);

    const root = await threadKeyOf("p@x");
    expect(await keyOf("emails", "p")).toBe(root);
    expect(await keyOf("emails", "c")).toBe(root);
    expect(await keyOf("emails", "g")).toBe(root);
    expect(await keyOf("sent_emails", "s")).toBe(root);
    expect(await keyOf("emails", "u")).toBe(await threadKeyOf("u@x"));
    expect(await keyOf("emails", "n")).toBe(await threadKeyOf("received:n"));
    expect(await keyOf("emails", "m")).toBeNull();
    const [content] = await getDb()
      .select({ threadKey: jmapMessageContent.threadKey })
      .from(jmapMessageContent);
    expect(content!.threadKey).toBe(root);

    const [job] = await getDb()
      .select()
      .from(asyncJobs)
      .where(eq(asyncJobs.id, body.threadBackfill.id));
    expect(job!.status).toBe("completed");
    expect(job!.totalRows).toBe(12);
    expect(job!.processedRows).toBe(12);
    // Thread ids changed under every JMAP account: clients resync once.
    expect(await readJmapEpoch(getDb())).toBe(1);
    const audits = await getDb()
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "inbox.updated"));
    expect(audits.map((row) => JSON.parse(row.details!))).toContainEqual({
      threadingMode: "headers",
      backfill: "completed",
      rows: 12,
    });

    const list = await (
      await authFetch("/api/admin/inboxes", { apiKey: adminKey })
    ).json<any[]>();
    expect(list.find((row) => row.email === INBOX)).toMatchObject({
      threadingMode: "headers",
      threadBackfill: { status: "completed", processed: 12, total: 12 },
    });
  });

  it("goes back to grouping by customer, restoring a JMAP send's thread", async () => {
    await fixture();
    await identity(INBOX, "headers");
    for (const id of ["u", "c", "p", "g", "n"]) {
      await getDb()
        .update(emails)
        .set({ threadKey: `t:${id}` })
        .where(eq(emails.id, id));
    }
    await getDb()
      .update(sentEmails)
      .set({ threadKey: "t:p" })
      .where(eq(sentEmails.id, "s"));
    await getDb().update(jmapMessageContent).set({ threadKey: "t:p" });
    BACKFILL_LIMITS.clearBatch = 2;

    const res = await patch({ threadingMode: "relationship" });
    expect(res.status).toBe(200);
    const body = await res.json<any>();
    const [saved] = await getDb()
      .select({ mode: senderIdentities.threadingMode })
      .from(senderIdentities)
      .where(eq(senderIdentities.email, INBOX));
    expect(saved!.mode).toBe("relationship");
    await drain(body.threadBackfill.id);

    const keys = await getDb().all<{ k: string | null }>(sql`
      SELECT thread_key AS k FROM emails WHERE recipient = ${INBOX}
      UNION ALL SELECT thread_key FROM sent_emails`);
    expect(keys.every((row) => row.k === null)).toBe(true);
    const [content] = await getDb()
      .select({ threadKey: jmapMessageContent.threadKey })
      .from(jmapMessageContent);
    expect(content!.threadKey).toBe("p:p1");
    const [job] = await getDb()
      .select()
      .from(asyncJobs)
      .where(eq(asyncJobs.id, body.threadBackfill.id));
    expect(job).toMatchObject({
      status: "completed",
      totalRows: 6,
      processedRows: 6,
    });
  });

  it("runs a failed backfill again when the same mode is asked for", async () => {
    const res = await patch({ threadingMode: "headers" });
    const { threadBackfill } = await res.json<any>();
    await failThreadBackfill(getDb(), threadBackfill.id, "boom");
    expect(await readJmapEpoch(getDb())).toBe(1);
    const list = await (
      await authFetch("/api/admin/inboxes", { apiKey: adminKey })
    ).json<any[]>();
    expect(
      list.find((row) => row.email === INBOX).threadBackfill,
    ).toMatchObject({ status: "failed", mode: "headers" });

    const retry = await patch({ threadingMode: "headers" });
    expect(retry.status).toBe(200);
    const again = await retry.json<any>();
    expect(again.threadBackfill.status).toBe("running");
    expect(again.threadBackfill.id).not.toBe(threadBackfill.id);
    // Asking for the mode it has, with nothing failed, starts nothing.
    await drain(again.threadBackfill.id);
    queued = [];
    expect((await patch({ threadingMode: "headers" })).status).toBe(200);
    expect(queued).toEqual([]);
  });

  it("records a stopped regrouping in the audit log", async () => {
    const res = await patch({ threadingMode: "headers" });
    const { threadBackfill } = await res.json<any>();
    await failThreadBackfill(getDb(), threadBackfill.id, "boom");
    const audits = await getDb()
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "inbox.updated"));
    expect(audits.map((row) => JSON.parse(row.details!))).toContainEqual({
      threadingMode: "headers",
      backfill: "failed",
      rows: 0,
      reason: "boom",
    });
  });

  it("fails a backfill whose inbox no longer has its mode", async () => {
    await received("a", { messageId: "<a@x>" });
    const job = await insertThreadBackfill(getDb(), {
      inbox: INBOX,
      mode: "headers",
      requestedBy: null,
    });
    // The switch's save never happened: the inbox is still by customer.
    expect(
      await runThreadBackfillSlice(getDb(), bindings, job!.id, 0),
    ).toBeNull();
    const [row] = await getDb()
      .select()
      .from(asyncJobs)
      .where(eq(asyncJobs.id, job!.id));
    expect(row!.status).toBe("failed");
    expect(row!.errorSummary).toContain("conversation mode changed");
    expect(await keyOf("emails", "a")).toBeNull();
  });

  it("writes nothing from a run that lost the job mid-page", async () => {
    await received("a", { messageId: "<a@x>", at: 100 });
    await received("b", { messageId: "<b@x>", inReplyTo: "<a@x>", at: 200 });
    const res = await patch({ threadingMode: "headers" });
    const { threadBackfill } = await res.json<any>();
    const real = getDb() as any;
    const client = real.$client;
    // Another run takes the job between this run's read and its write.
    const stealing = new Proxy(real, {
      get(target, prop) {
        if (prop === "$client") {
          return new Proxy(client, {
            get(c, q) {
              if (q === "batch") {
                return async (statements: D1PreparedStatement[]) => {
                  await c
                    .prepare(
                      "UPDATE async_jobs SET params = json_set(params, '$.lease', 'thief') WHERE id = ?",
                    )
                    .bind(threadBackfill.id)
                    .run();
                  return c.batch(statements);
                };
              }
              const value = c[q];
              return typeof value === "function" ? value.bind(c) : value;
            },
          });
        }
        const value = target[prop];
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    expect(
      await runThreadBackfillSlice(stealing, bindings, threadBackfill.id, 0),
    ).toBeNull();
    expect(await keyOf("emails", "a")).toBeNull();
    expect(await keyOf("emails", "b")).toBeNull();
  });

  it("counts page reads against a slice's budget", async () => {
    for (let i = 0; i < 6; i++) {
      await received(`r${i}`, { messageId: `<r${i}@x>`, at: 100 + i });
    }
    await identity(INBOX, "headers");
    BACKFILL_LIMITS.pageSize = 1;
    BACKFILL_LIMITS.sliceStatements = 4;
    const job = await insertThreadBackfill(getDb(), {
      inbox: INBOX,
      mode: "headers",
      requestedBy: null,
      rethread: "import",
    });
    // Pass 2 only, and nothing here cites anything: no row statements, yet
    // each page is a read and a write, so a slice stops after two pages.
    expect(await drain(job!.id)).toBeGreaterThanOrEqual(3);
  });

  it("joins mail imported out of order once the import is done", async () => {
    await identity(INBOX, "headers");
    // Stored as the import met them: the reply first, in a thread of its own.
    await received("c", {
      messageId: "<c@x>",
      inReplyTo: "<p@x>",
      at: 200,
      threadKey: await threadKeyOf("c@x"),
    });
    await received("p", {
      messageId: "<p@x>",
      at: 100,
      threadKey: await threadKeyOf("p@x"),
    });
    const now = Math.floor(Date.now() / 1000);
    await getDb()
      .insert(inboxConversationState)
      .values({
        inbox: INBOX,
        conversationKey: "t:kept",
        snoozedUntil: now + 99,
        updatedAt: now,
      });
    await rethreadAfterImport(getDb(), bindings, INBOX, "admin-1");
    expect(queued).toHaveLength(1);
    const [job] = await getDb()
      .select()
      .from(asyncJobs)
      .where(eq(asyncJobs.id, queued[0]!.jobId));
    expect(job!.totalRows).toBe(2);
    await drain(job!.id);
    expect(await keyOf("emails", "c")).toBe(await threadKeyOf("p@x"));
    // Snoozes stay: nothing switched.
    expect(await getDb().select().from(inboxConversationState)).toHaveLength(1);
    expect(await readJmapEpoch(getDb())).toBe(1);
    const audits = await getDb()
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "inbox.updated"));
    expect(audits.map((row) => row.summary)).toContain(
      `Threaded the mail imported into ${INBOX}`,
    );

    // A relationship inbox has nothing to re-thread.
    queued = [];
    await identity(INBOX, "relationship");
    await rethreadAfterImport(getDb(), bindings, INBOX, "admin-1");
    expect(queued).toEqual([]);
  });

  it("waits for an import into the inbox before switching", async () => {
    await getDb().run(sql`
      INSERT INTO async_jobs (id, job_type, ref_id, status, processed_rows,
        imported_count, skipped_count, created_at, updated_at)
      VALUES ('imp-1', 'mail_import', ${INBOX}, 'running', 0, 0, 0, 1, 1)`);
    const res = await patch({ threadingMode: "headers" });
    expect(res.status).toBe(409);
    expect(queued).toEqual([]);
  });

  it("clears an inbox's threads when it is deleted, not while it regroups", async () => {
    await received("a", { messageId: "<a@x>", threadKey: "t:a" });
    const switched = await (
      await patch({ threadingMode: "headers" })
    ).json<any>();
    const del = () =>
      authFetch(`/api/admin/inboxes/${encodeURIComponent(INBOX)}`, {
        method: "DELETE",
        apiKey: adminKey,
      });
    expect((await del()).status).toBe(409);
    await drain(switched.threadBackfill.id);

    queued = [];
    expect((await del()).status).toBe(200);
    expect(queued).toHaveLength(1);
    await drain(queued[0]!.jobId);
    expect(await keyOf("emails", "a")).toBeNull();
  });

  it("is for admins only", async () => {
    const { apiKey } = await createTestUser({
      id: "user-aa",
      role: "member",
      email: "aa@example.com",
    });
    const res = await authFetch(
      `/api/admin/inboxes/${encodeURIComponent(INBOX)}`,
      {
        method: "PATCH",
        apiKey,
        body: JSON.stringify({ threadingMode: "headers" }),
      },
    );
    expect(res.status).toBe(403);
  });
});

describe("the JMAP account epoch", () => {
  const jmap = (apiKey: string, methodCalls: unknown[]) =>
    authFetch("/jmap/api", {
      method: "POST",
      apiKey,
      body: JSON.stringify({ using: ALL_CAPABILITIES, methodCalls }),
    });

  it("gives every user a new account and refuses older ids and states", async () => {
    const { userId, apiKey } = await createTestUser({ id: "epoch-user" });
    const session = await (
      await authFetch("/.well-known/jmap", { apiKey })
    ).json<Record<string, any>>();
    const before = publicAccountId(userId, 0);
    expect(Object.keys(session.accounts)).toEqual([before]);
    const first = await (
      await jmap(apiKey, [["Mailbox/get", { accountId: before, ids: [] }, "0"]])
    ).json<any>();
    const oldState = first.methodResponses[0][1].state;

    expect(await bumpJmapEpoch(getDb(), null)).toBe(1);
    const after = publicAccountId(userId, 1);
    expect(after).not.toBe(before);
    const next = await (
      await authFetch("/.well-known/jmap", { apiKey })
    ).json<Record<string, any>>();
    expect(Object.keys(next.accounts)).toEqual([after]);
    expect(next.state).not.toBe(session.state);

    const responses = await (
      await jmap(apiKey, [
        ["Mailbox/get", { accountId: before, ids: [] }, "old"],
        ["Mailbox/changes", { accountId: after, sinceState: oldState }, "chg"],
        ["Mailbox/get", { accountId: after, ids: [] }, "new"],
      ])
    ).json<any>();
    expect(responses.methodResponses[0]).toEqual([
      "error",
      { type: "accountNotFound" },
      "old",
    ]);
    expect(responses.methodResponses[1]).toEqual([
      "error",
      { type: "cannotCalculateChanges" },
      "chg",
    ]);
    expect(responses.methodResponses[2][1].state).not.toBe(oldState);
  });
});

describe("JMAP in a headers inbox", () => {
  it("shows a thread as its reply chain, and received mail's Reply-To", async () => {
    const { userId } = await createTestUser({ id: "jmap-user" });
    await identity(INBOX, "headers");
    await received("a", {
      messageId: "<a@x>",
      threadKey: "t:a",
      at: 100,
      replyTo: JSON.stringify([{ email: "help@example.com", name: "Help" }]),
    });
    await received("b", {
      messageId: "<b@x>",
      inReplyTo: "<a@x>",
      threadKey: "t:a",
      at: 200,
    });
    // Same customer, another thread.
    await received("c", { messageId: "<c@x>", threadKey: "t:c", at: 300 });

    const { sender } = recordingSender();
    const responses = await runJmap(
      userId,
      [
        [
          "Email/get",
          {
            accountId: acct(userId),
            ids: [rid("a"), rid("c")],
            properties: ["threadId", "replyTo"],
          },
          "0",
        ],
        [
          "Thread/get",
          { accountId: acct(userId), ids: [thread("t:a"), thread("t:c")] },
          "1",
        ],
      ],
      sender,
    );
    const [a, c] = (responses[0][1] as any).list;
    expect(a).toMatchObject({
      threadId: thread("t:a"),
      replyTo: [{ email: "help@example.com", name: "Help" }],
    });
    expect(c).toMatchObject({ threadId: thread("t:c"), replyTo: null });
    expect((responses[1][1] as any).list).toEqual([
      { id: thread("t:a"), emailIds: [rid("a"), rid("b")] },
      { id: thread("t:c"), emailIds: [rid("c")] },
    ]);
  });
});
