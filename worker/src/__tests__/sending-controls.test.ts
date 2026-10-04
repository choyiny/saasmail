// docs/specs/SPEC-send-controls.md §1 (pause), §3 (daily caps), §4 (settings).
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { eq, sql } from "drizzle-orm";
import { auditEvents } from "../db/audit-events.schema";
import { jmapSubmissions } from "../db/jmap-submissions.schema";
import { outboxEmails } from "../db/outbox-emails.schema";
import { sentEmails } from "../db/sent-emails.schema";
import type {
  EmailSender,
  SendEmailParams,
  SendEmailResult,
} from "../lib/email-sender";
import { appSettings } from "../db/app-settings.schema";
import {
  MAX_OUTBOX_ATTEMPTS,
  attemptOutboxRow,
  drainHeldOutbox,
  processOutbox,
  sendViaOutbox,
} from "../lib/outbox";
import { classifyQueueMessage } from "../lib/queue-router";
import {
  releaseOverdueSubmissions,
  releaseScheduledSubmission,
} from "../jmap/release";
import { parseSubmissionId } from "../jmap/public-ids";
import {
  SENDING_PAUSED_MESSAGE,
  pruneSendCounters,
  reserveDailySend,
  secondsToUtcMidnight,
  setDailySendLimits,
  setSendingPaused,
  utcDay,
} from "../lib/sending-controls";
import {
  applyMigrations,
  authFetch,
  buildSendForm,
  cleanDb,
  createTestTemplate,
  createTestUser,
  getDb,
} from "./helpers";
import { acct, idn } from "./jmap-ids";
import {
  type Credentials,
  Jar,
  createUserWithPassword,
  signIn,
} from "./mcp-helpers";
import {
  INBOX as JMAP_INBOX,
  draftCreate,
  jmapCall,
  recordingSender,
  seedAccount,
} from "./jmap-submission-fixtures";

const INBOX = "support@saasmail.test";
const bindings = env as unknown as CloudflareBindings;

function fakeSender(result: SendEmailResult = { id: "prov-1", error: null }) {
  const calls: SendEmailParams[] = [];
  const sender: EmailSender = {
    provider: "none" as const,
    async send(params: SendEmailParams) {
      calls.push(params);
      return result;
    },
    maxAttachmentBytes: () => 25 * 1024 * 1024,
    maxMessageBytes: () => 25 * 1024 * 1024,
  };
  return { sender, calls };
}

const compose = (overrides: Record<string, unknown> = {}) => ({
  to: "alice@example.com",
  fromAddress: INBOX,
  subject: "Hello",
  bodyHtml: "<p>hi</p>",
  transactional: true,
  ...overrides,
});

async function auditActions(action: string) {
  return (await getDb().select().from(auditEvents)).filter(
    (event) => event.action === action,
  );
}

async function seedDueRow(attempts = 1) {
  const now = Math.floor(Date.now() / 1000);
  await getDb()
    .insert(sentEmails)
    .values({
      id: "se-1",
      personId: null,
      fromAddress: "me@saasmail.test",
      toAddress: "to@example.com",
      subject: "Hi",
      bodyHtml: "<p>Hi</p>",
      messageId: "<mid-1@saasmail.test>",
      status: "retrying",
      sentAt: now - 100,
      createdAt: now - 100,
    });
  await getDb()
    .insert(outboxEmails)
    .values({
      id: "ob-1",
      sentEmailId: "se-1",
      fromAddress: "me@saasmail.test",
      toAddress: "to@example.com",
      subject: "Hi",
      bodyHtml: "<p>Hi</p>",
      headers: JSON.stringify({ "Message-ID": "<mid-1@saasmail.test>" }),
      transactional: 1,
      status: "pending",
      attempts,
      lastError: "quota exceeded",
      nextRetryAt: now - 10,
      createdAt: now - 100,
      updatedAt: now - 100,
    });
}

/** A pending outbox row with no Sent row (enough for the drain). */
async function seedOutboxRow(
  id: string,
  opts: { lastError: string; nextRetryAt: number },
) {
  const now = Math.floor(Date.now() / 1000);
  await getDb()
    .insert(outboxEmails)
    .values({
      id,
      sentEmailId: `se-${id}`,
      fromAddress: "me@saasmail.test",
      toAddress: `${id}@example.com`,
      subject: "Hi",
      bodyHtml: "<p>Hi</p>",
      transactional: 1,
      status: "pending",
      attempts: 0,
      lastError: opts.lastError,
      nextRetryAt: opts.nextRetryAt,
      createdAt: now - 100,
      updatedAt: now - 100,
    });
}

const SESSION_ADMIN: Credentials = {
  name: "Owner",
  email: "owner@saasmail.test",
  password: "correct-horse-battery",
};

/** A signed-in admin's cookie header. */
async function adminSession(): Promise<string> {
  await createUserWithPassword(SESSION_ADMIN, "admin");
  const jar = new Jar();
  await signIn(jar, SESSION_ADMIN);
  return jar.header;
}

const patchAsSession = (cookie: string, body: Record<string, unknown>) =>
  authFetch("/api/admin/settings", {
    method: "PATCH",
    headers: { Cookie: cookie },
    body: JSON.stringify(body),
  });

async function outboxRow() {
  const [row] = await getDb().select().from(outboxEmails);
  return row;
}

beforeAll(async () => {
  await applyMigrations();
});

describe("pausing outbound sending", () => {
  beforeEach(async () => {
    await cleanDb();
  });

  function outboxParams(sender: EmailSender) {
    return {
      db: getDb(),
      env: bindings,
      sender,
      sentEmailId: "se-1",
      fromAddress: "me@saasmail.test",
      from: "Me <me@saasmail.test>",
      to: "to@example.com",
      subject: "Hi",
      html: "<p>Hi</p>",
      headers: { "Message-ID": "<mid-1@saasmail.test>" },
      transactional: true,
    };
  }

  it("records and holds a send without calling the provider", async () => {
    await setSendingPaused(getDb(), true);
    const { sender, calls } = fakeSender();

    const result = await sendViaOutbox(outboxParams(sender));

    expect(calls).toHaveLength(0);
    expect(result.outcome).toBe("retrying");
    expect(result.send.result?.error).toMatchObject({ paused: true });
    const row = await outboxRow();
    expect(row).toMatchObject({
      status: "pending",
      attempts: 0,
      lastError: SENDING_PAUSED_MESSAGE,
    });
  });

  it("holds a one-shot send (an auto-reply) instead of dropping it", async () => {
    await setSendingPaused(getDb(), true);
    const { sender } = fakeSender();
    const result = await sendViaOutbox({
      ...outboxParams(sender),
      retryOnFailure: false,
    });
    expect(result.outcome).toBe("retrying");
    expect((await outboxRow())?.status).toBe("pending");
  });

  it("stops the outbox processor, and a resumed retry delivers the held row", async () => {
    await seedDueRow();
    const before = await outboxRow();
    await setSendingPaused(getDb(), true);

    await processOutbox(bindings);
    expect(await outboxRow()).toEqual(before);

    await setSendingPaused(getDb(), false);
    const { sender, calls } = fakeSender();
    expect(await attemptOutboxRow(getDb(), bindings, sender, "ob-1")).toBe(
      "sent",
    );
    expect(calls).toHaveLength(1);
    expect(await outboxRow()).toBeUndefined();
    const [sent] = await getDb().select().from(sentEmails);
    expect(sent.status).toBe("sent");
  });

  it("gives a retry's attempt back while paused, so a held row never runs out", async () => {
    await seedDueRow(MAX_OUTBOX_ATTEMPTS);
    await setSendingPaused(getDb(), true);
    const { sender, calls } = fakeSender();

    expect(await attemptOutboxRow(getDb(), bindings, sender, "ob-1")).toBe(
      "retrying",
    );
    expect(calls).toHaveLength(0);
    expect(await outboxRow()).toMatchObject({
      status: "pending",
      attempts: MAX_OUTBOX_ATTEMPTS,
      lastError: SENDING_PAUSED_MESSAGE,
    });
  });

  it("drains held mail after a resume, each held row once, a batch at a time", async () => {
    const now = Math.floor(Date.now() / 1000);
    await seedOutboxRow("held-1", {
      lastError: SENDING_PAUSED_MESSAGE,
      nextRetryAt: now - 5,
    });
    await seedOutboxRow("held-2", {
      lastError: SENDING_PAUSED_MESSAGE,
      nextRetryAt: now - 5,
    });
    // Held in the last minute before the resume: due in 30 seconds.
    await seedOutboxRow("held-3", {
      lastError: SENDING_PAUSED_MESSAGE,
      nextRetryAt: now + 30,
    });
    // An ordinary retry is the hourly processor's, not the drain's.
    await seedOutboxRow("other", {
      lastError: "quota exceeded",
      nextRetryAt: now - 5,
    });
    const { sender, calls } = fakeSender({
      id: null,
      error: { message: "quota exceeded", transient: true },
    });

    await setSendingPaused(getDb(), true);
    expect(await drainHeldOutbox(bindings, sender)).toBeNull();
    expect(calls).toHaveLength(0);

    await setSendingPaused(getDb(), false);
    const wait = await drainHeldOutbox(bindings, sender);
    expect(calls.map((call) => call.to).sort()).toEqual([
      "held-1@example.com",
      "held-2@example.com",
    ]);
    expect(wait).toBeGreaterThan(0);
    expect(wait).toBeLessThanOrEqual(30);

    // Both failed: no longer held, so the drain does not try them again.
    expect(await drainHeldOutbox(bindings, sender)).toBe(wait);
    expect(calls).toHaveLength(2);
  });

  it("is a queue message of its own", () => {
    expect(classifyQueueMessage({ type: "outbox_drain" })).toBe("outbox_drain");
  });

  it("reads a pause row without a value as running", async () => {
    await getDb().insert(appSettings).values({
      key: "outbound_paused",
      value: null,
      updatedAt: 1,
      updatedBy: null,
    });
    const config = await authFetch("/api/config");
    expect(await config.json()).toMatchObject({ outboundPaused: false });
  });

  it("holds a subscription confirmation in the outbox while paused", async () => {
    const { sendConfirmationEmail } =
      await import("../lib/subscribe-confirmation");
    const confirm = () =>
      sendConfirmationEmail({
        db: getDb(),
        env: bindings,
        to: "new@example.com",
        fromAddress: "news@saasmail.test",
        listName: "News",
        confirmUrl: "https://mail.example.com/subscribe/confirm/t",
        templateSlug: null,
      });
    (env as any).DEMO_MODE = "1";
    try {
      await setSendingPaused(getDb(), true);
      expect(await confirm()).toEqual({ sent: true });
      const [held] = await getDb().select().from(sentEmails);
      expect(held.status).toBe("retrying");
      expect(await outboxRow()).toMatchObject({
        status: "pending",
        lastError: SENDING_PAUSED_MESSAGE,
      });

      await setSendingPaused(getDb(), false);
      expect(await confirm()).toEqual({ sent: true });
      const statuses = (await getDb().select().from(sentEmails))
        .map((row) => row.status)
        .sort();
      expect(statuses).toEqual(["retrying", "sent"]);
    } finally {
      (env as any).DEMO_MODE = "0";
    }
  });

  it("keeps a delayed JMAP send scheduled until sending resumes", async () => {
    const { authorId } = await seedAccount();
    const drafted = (await jmapCall(authorId, [
      [
        "Email/set",
        { accountId: acct(authorId), create: { d1: draftCreate() } },
        "a",
      ],
    ])) as [string, Record<string, any>, string][];
    const scheduled = (await jmapCall(authorId, [
      [
        "EmailSubmission/set",
        {
          accountId: acct(authorId),
          create: {
            s1: {
              identityId: idn(JMAP_INBOX),
              emailId: drafted[0][1].created.d1.id,
              envelope: {
                mailFrom: {
                  email: JMAP_INBOX,
                  parameters: { HOLDFOR: "600" },
                },
                rcptTo: [
                  { email: "alice@example.com" },
                  { email: "bob@example.com" },
                ],
              },
            },
          },
        },
        "s",
      ],
    ])) as [string, Record<string, any>, string][];
    const id = parseSubmissionId(scheduled[0][1].created.s1.id)!;
    const [row] = await getDb()
      .select()
      .from(jmapSubmissions)
      .where(eq(jmapSubmissions.id, id));

    await setSendingPaused(getDb(), true);
    const { sender, calls } = recordingSender();
    expect(
      await releaseScheduledSubmission(bindings, id, {
        sender,
        now: row.sendAt,
      }),
    ).toBe("notDue");
    expect(
      await releaseOverdueSubmissions(bindings, row.sendAt + 10, sender),
    ).toBe(0);
    expect(calls).toHaveLength(0);
    const [held] = await getDb()
      .select()
      .from(jmapSubmissions)
      .where(eq(jmapSubmissions.id, id));
    expect(held).toMatchObject({
      attemptState: "scheduled",
      undoStatus: "pending",
    });

    await setSendingPaused(getDb(), false);
    expect(
      await releaseScheduledSubmission(bindings, id, {
        sender,
        now: row.sendAt,
      }),
    ).toBe("sent");
    expect(calls).toHaveLength(1);
  });

  describe("over HTTP", () => {
    let adminKey: string;

    beforeEach(async () => {
      ({ apiKey: adminKey } = await createTestUser());
      (env as any).DEMO_MODE = "1";
    });

    afterEach(() => {
      (env as any).DEMO_MODE = "0";
    });

    const patchSettings = (body: Record<string, unknown>, apiKey = adminKey) =>
      authFetch("/api/admin/settings", {
        apiKey,
        method: "PATCH",
        body: JSON.stringify(body),
      });

    it("lets an admin pause and resume, recorded once each, and tells the app", async () => {
      const paused = await patchSettings({ outboundPaused: true });
      expect(paused.status).toBe(200);
      const body = (await paused.json()) as Record<string, any>;
      expect(body.outboundPaused).toBe(true);
      expect(body.outboundPause.byLabel).toMatch(/^API key /);
      expect(body.outboundPause.since).toBeGreaterThan(0);

      // Pausing again changes nothing and records nothing.
      await patchSettings({ outboundPaused: true });
      expect(await auditActions("sending.paused")).toHaveLength(1);

      const config = await authFetch("/api/config");
      expect(await config.json()).toMatchObject({ outboundPaused: true });
      const settings = await authFetch("/api/admin/settings", {
        apiKey: adminKey,
      });
      expect(await settings.json()).toMatchObject({
        outboundPaused: true,
        outboundPause: { byLabel: body.outboundPause.byLabel },
      });

      // An API key can pause, not resume.
      const refused = await patchSettings({ outboundPaused: false });
      expect(refused.status).toBe(403);
      expect(await refused.json()).toMatchObject({ code: "SESSION_REQUIRED" });
      expect(await auditActions("sending.resumed")).toHaveLength(0);

      // A signed-in admin can, and the resume starts the drain on the queue.
      const cookie = await adminSession();
      const queue = (env as any).EMAIL_QUEUE;
      const queued: unknown[] = [];
      (env as any).EMAIL_QUEUE = {
        send: async (message: unknown) => {
          queued.push(message);
        },
      };
      try {
        const resumed = await patchAsSession(cookie, { outboundPaused: false });
        expect(resumed.status).toBe(200);
        expect(await resumed.json()).toMatchObject({
          outboundPaused: false,
          outboundPause: null,
        });
      } finally {
        (env as any).EMAIL_QUEUE = queue;
      }
      expect(queued).toEqual([{ type: "outbox_drain" }]);
      expect(await auditActions("sending.resumed")).toHaveLength(1);
      const after = await authFetch("/api/config");
      expect(await after.json()).toMatchObject({ outboundPaused: false });
    });

    it("refuses a limit change from an API key", async () => {
      const res = await patchSettings({ dailySendLimits: { mcp: null } });
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ code: "SESSION_REQUIRED" });
      expect(await auditActions("settings.changed")).toHaveLength(0);
    });

    it("lets an admin cancel a message the pause is holding, at once", async () => {
      await patchSettings({ outboundPaused: true });
      await authFetch("/api/send", {
        apiKey: adminKey,
        method: "POST",
        body: buildSendForm(compose()),
      });
      const row = await outboxRow();
      const res = await authFetch(`/api/outbox/${row.id}`, {
        apiKey: adminKey,
        method: "DELETE",
      });
      expect(res.status).toBe(200);
      expect(await outboxRow()).toBeUndefined();
      const [sent] = await getDb().select().from(sentEmails);
      expect(sent.status).toBe("failed");
    });

    it("refuses a member", async () => {
      const member = await createTestUser({
        id: "member-1",
        email: "member@example.com",
        role: "member",
      });
      const res = await patchSettings({ outboundPaused: true }, member.apiKey);
      expect(res.status).toBe(403);
      expect(await auditActions("sending.paused")).toHaveLength(0);
    });

    it("answers a send while paused with status retrying and paused: true", async () => {
      await patchSettings({ outboundPaused: true });
      const res = await authFetch("/api/send", {
        apiKey: adminKey,
        method: "POST",
        body: buildSendForm(compose()),
      });
      expect(res.status).toBe(201);
      expect(await res.json()).toMatchObject({
        status: "retrying",
        paused: true,
      });
      const [sent] = await getDb().select().from(sentEmails);
      expect(sent.status).toBe("retrying");
      expect(await outboxRow()).toMatchObject({ status: "pending" });

      const count = await authFetch("/api/outbox/count", { apiKey: adminKey });
      expect(await count.json()).toEqual({ pending: 1, held: 1, paused: true });
    });

    it("answers a send that is not paused without the flag", async () => {
      const res = await authFetch("/api/send", {
        apiKey: adminKey,
        method: "POST",
        body: buildSendForm(compose()),
      });
      expect(res.status).toBe(201);
      expect(await res.json()).not.toHaveProperty("paused");
    });
  });
});

describe("daily send limits", () => {
  let userId: string;

  beforeEach(async () => {
    await cleanDb();
    ({ userId } = await createTestUser());
  });

  async function counter(channel = "api") {
    const [row] = await getDb().all<{ count: number }>(
      sql`SELECT count FROM send_counters WHERE user_id = ${userId} AND channel = ${channel}`,
    );
    return row ? Number(row.count) : undefined;
  }

  it("never touches the table for an unlimited channel", async () => {
    const reservation = await reserveDailySend(getDb(), {
      userId,
      channel: "web",
    });
    expect(reservation.allowed).toBe(true);
    expect(await getDb().all(sql`SELECT * FROM send_counters`)).toEqual([]);
  });

  it("refuses the message over the limit until the next UTC midnight, and records it once", async () => {
    await setDailySendLimits(getDb(), { api: 2 });
    const now = Date.UTC(2026, 9, 4, 23, 0, 0) / 1000;
    const reserve = () =>
      reserveDailySend(getDb(), { userId, channel: "api", now });

    expect((await reserve()).allowed).toBe(true);
    expect((await reserve()).allowed).toBe(true);
    const refused = await reserve();
    expect(refused).toMatchObject({
      allowed: false,
      retryAfter: 3600,
      limit: 2,
      message:
        "Daily send limit reached: 2 messages a day through api. It resets at midnight UTC.",
    });
    expect((await reserve()).allowed).toBe(false);
    expect(await counter()).toBe(2);
    expect(await auditActions("send.limit_reached")).toHaveLength(1);
  });

  it("blocks a channel set to 0", async () => {
    await setDailySendLimits(getDb(), { mcp: 0 });
    const refused = await reserveDailySend(getDb(), {
      userId,
      channel: "mcp",
    });
    expect(refused.allowed).toBe(false);
    expect(refused.message).toBe(
      "Sending through mcp is turned off on this server by its administrator.",
    );
  });

  it("admits exactly the limit when sends race at the boundary", async () => {
    await setDailySendLimits(getDb(), { api: 5 });
    const results = await Promise.all(
      Array.from({ length: 12 }, () =>
        reserveDailySend(getDb(), { userId, channel: "api" }),
      ),
    );
    expect(results.filter((r) => r.allowed)).toHaveLength(5);
    expect(await counter()).toBe(5);
  });

  it("gives a slot back with release", async () => {
    await setDailySendLimits(getDb(), { api: 1 });
    const first = await reserveDailySend(getDb(), { userId, channel: "api" });
    await first.release();
    const second = await reserveDailySend(getDb(), { userId, channel: "api" });
    expect(second.allowed).toBe(true);
  });

  it("counts to the next UTC midnight", () => {
    expect(secondsToUtcMidnight(Date.UTC(2026, 9, 4, 0, 0, 0) / 1000)).toBe(
      86400,
    );
    expect(secondsToUtcMidnight(Date.UTC(2026, 9, 4, 23, 59, 59) / 1000)).toBe(
      1,
    );
  });

  it("prunes counters more than a week old", async () => {
    const now = Math.floor(Date.now() / 1000);
    const day = 24 * 60 * 60;
    for (const [d, n] of [
      [utcDay(now), 3],
      [utcDay(now - 7 * day), 2],
      [utcDay(now - 8 * day), 1],
    ] as const) {
      await getDb().run(
        sql`INSERT INTO send_counters (user_id, channel, day, count) VALUES (${userId}, 'api', ${d}, ${n})`,
      );
    }
    await pruneSendCounters(getDb(), now);
    const left = await getDb().all<{ day: string }>(
      sql`SELECT day FROM send_counters ORDER BY day`,
    );
    expect(left.map((row) => row.day)).toEqual([
      utcDay(now - 7 * day),
      utcDay(now),
    ]);
  });

  describe("over HTTP", () => {
    let apiKey: string;
    const KEY = "0b6f7a9e-2c4d-4e8f-a1b2-c3d4e5f60718";

    beforeEach(async () => {
      ({ apiKey } = await createTestUser({
        id: "sender-1",
        email: "sender@example.com",
      }));
      userId = "sender-1";
      (env as any).DEMO_MODE = "1";
    });

    afterEach(() => {
      (env as any).DEMO_MODE = "0";
    });

    const send = (
      payload: Record<string, unknown>,
      headers: Record<string, string> = {},
      key = apiKey,
    ) =>
      authFetch("/api/send", {
        apiKey: key,
        method: "POST",
        headers,
        body: buildSendForm(payload),
      });

    it("answers 429 with Retry-After over an API key's limit", async () => {
      await setDailySendLimits(getDb(), { api: 1 });
      expect((await send(compose())).status).toBe(201);

      const refused = await send(compose({ subject: "Again" }));
      expect(refused.status).toBe(429);
      const retryAfter = Number(refused.headers.get("Retry-After"));
      expect(retryAfter).toBeGreaterThan(0);
      expect(retryAfter).toBeLessThanOrEqual(86400);
      expect(await refused.json()).toEqual({
        error:
          "Daily send limit reached: 1 messages a day through api. It resets at midnight UTC.",
        code: "DAILY_SEND_LIMIT_REACHED",
        retryAfter,
      });
      expect(await getDb().all(sql`SELECT id FROM sent_emails`)).toHaveLength(
        1,
      );
    });

    it("does not count a replayed idempotent send", async () => {
      await setDailySendLimits(getDb(), { api: 1 });
      expect((await send(compose(), { "Idempotency-Key": KEY })).status).toBe(
        201,
      );
      const replay = await send(compose(), { "Idempotency-Key": KEY });
      expect(replay.status).toBe(201);
      expect(replay.headers.get("Idempotency-Replayed")).toBe("true");
      expect(await counter()).toBe(1);
      expect((await send(compose({ subject: "New" }))).status).toBe(429);
    });

    it("frees the key of a refused keyed send", async () => {
      await setDailySendLimits(getDb(), { api: 0 });
      expect((await send(compose(), { "Idempotency-Key": KEY })).status).toBe(
        429,
      );
      expect(await getDb().all(sql`SELECT * FROM send_idempotency`)).toEqual(
        [],
      );
    });

    it("gives the slot back when the send is refused", async () => {
      await setDailySendLimits(getDb(), { api: 5 });
      const member = await createTestUser({
        id: "member-1",
        email: "member@example.com",
        role: "member",
      });
      expect((await send(compose(), {}, member.apiKey)).status).toBe(403);
      userId = "member-1";
      expect(await counter()).toBe(0);
    });

    it("counts template sends on the same channel", async () => {
      await setDailySendLimits(getDb(), { api: 1 });
      await createTestTemplate({
        slug: "welcome",
        subject: "Welcome",
        bodyHtml: "<p>Welcome</p>",
      });
      const template = await authFetch("/api/email-templates/welcome/send", {
        apiKey,
        method: "POST",
        body: JSON.stringify({ to: "alice@example.com", fromAddress: INBOX }),
      });
      expect(template.status).toBe(201);
      expect((await send(compose())).status).toBe(429);
    });

    it("reports today's usage and takes the limits from the settings route", async () => {
      const { apiKey: adminKey } = await createTestUser({
        id: "admin-2",
        email: "admin2@example.com",
      });
      const patched = await patchAsSession(await adminSession(), {
        dailySendLimits: { api: 3, mcp: null },
      });
      expect(patched.status).toBe(200);
      expect(await patched.json()).toMatchObject({
        dailySendLimits: { web: null, api: 3, mcp: null, jmap: null },
      });
      expect(await auditActions("settings.changed")).toHaveLength(2);

      await send(compose());
      await send(compose({ subject: "Two" }));
      const usage = await authFetch("/api/admin/send-usage", {
        apiKey: adminKey,
      });
      expect(usage.status).toBe(200);
      expect(await usage.json()).toEqual({
        day: utcDay(Math.floor(Date.now() / 1000)),
        limits: { web: null, api: 3, mcp: null, jmap: null },
        usage: [
          {
            channel: "api",
            userId: "sender-1",
            email: "sender@example.com",
            count: 2,
          },
        ],
      });
    });

    it("rejects a negative limit", async () => {
      const res = await authFetch("/api/admin/settings", {
        apiKey,
        method: "PATCH",
        body: JSON.stringify({ dailySendLimits: { api: -1 } }),
      });
      expect(res.status).toBe(400);
    });

    it("documents the 429 in /doc", async () => {
      const doc = (await (await authFetch("/doc")).json()) as {
        paths: Record<string, { post?: { responses: object } }>;
      };
      for (const path of [
        "/api/send",
        "/api/send/reply/{emailId}",
        "/api/email-templates/{slug}/send",
      ]) {
        expect(Object.keys(doc.paths[path]!.post!.responses), path).toContain(
          "429",
        );
      }
    });
  });

  describe("over JMAP", () => {
    it("refuses a submission over the limit with forbiddenToSend", async () => {
      await cleanDb();
      const { authorId } = await seedAccount();
      await setDailySendLimits(getDb(), { jmap: 1 });
      const { sender, calls } = recordingSender();

      const submit = async () => {
        const drafted = (await jmapCall(
          authorId,
          [
            [
              "Email/set",
              { accountId: acct(authorId), create: { d1: draftCreate() } },
              "a",
            ],
          ],
          { sender },
        )) as [string, Record<string, any>, string][];
        const res = (await jmapCall(
          authorId,
          [
            [
              "EmailSubmission/set",
              {
                accountId: acct(authorId),
                create: {
                  s1: {
                    identityId: idn(JMAP_INBOX),
                    emailId: drafted[0][1].created.d1.id,
                  },
                },
              },
              "s",
            ],
          ],
          { sender },
        )) as [string, Record<string, any>, string][];
        return res[0][1];
      };

      expect((await submit()).created?.s1).toBeDefined();
      const refused = await submit();
      expect(refused.created ?? null).toBeNull();
      expect(refused.notCreated.s1).toEqual({
        type: "forbiddenToSend",
        description:
          "Daily send limit reached: 1 messages a day through jmap. It resets at midnight UTC.",
      });
      expect(calls).toHaveLength(1);
    });
  });
});
