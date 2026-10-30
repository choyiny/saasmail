// docs/suppressions.md (bounces and complaints): Cloudflare Email Sending
// events recorded from EMAIL_QUEUE, the hard-bounce refusal at every send
// boundary, and the reads that show them.
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
import {
  applyMigrations,
  authFetch,
  buildSendForm,
  cleanDb,
  createTestEmail,
  createTestPerson,
  createTestSentEmail,
  createTestUser,
  getDb,
} from "./helpers";
import {
  bouncedEvent,
  complainedEvent,
  deliveredEvent,
  EVENT_TIMESTAMP,
  failedEvent,
  rejectedEvent,
} from "./fixtures/cloudflare-events";
import { auditEvents } from "../db/audit-events.schema";
import { campaigns } from "../db/campaigns.schema";
import { contacts } from "../db/contacts.schema";
import {
  deliveryEvents,
  deliveryMessageIds,
} from "../db/delivery-events.schema";
import { gmailAccounts } from "../db/gmail-accounts.schema";
import { jmapSubmissions } from "../db/jmap-submissions.schema";
import { listMembers } from "../db/list-members.schema";
import { lists } from "../db/lists.schema";
import { outboxEmails } from "../db/outbox-emails.schema";
import { senderIdentities } from "../db/sender-identities.schema";
import { sentEmails } from "../db/sent-emails.schema";
import { suppressions } from "../db/suppressions.schema";
import { parseCloudflareEvent } from "../lib/delivery/cloudflare";
import { recordDeliveryEvent } from "../lib/delivery/record";
import { undoListUnsubscribe } from "../lib/list-unsubscribe";
import { sendEmail } from "../lib/send-email";
import { signToken } from "../lib/unsubscribe-token";
import { campaignUnsubscribeAttributions } from "../db/campaign-unsubscribe-attributions.schema";
import type { DeliveryEvent } from "../lib/delivery/types";
import { encryptSecret } from "../lib/crypto";
import type { EmailSender, SendEmailParams } from "../lib/email-sender";
import { attemptOutboxRow } from "../lib/outbox";
import { classifyQueueMessage, handleQueueBatch } from "../lib/queue-router";
import { releaseScheduledSubmission } from "../jmap/release";
import { acct, idn } from "./jmap-ids";
import {
  INBOX as JMAP_INBOX,
  draftCreate,
  jmapCall,
  recordingSender,
  seedAccount,
} from "./jmap-submission-fixtures";

const INBOX = "support@saasmail.test";
const DEAD = "user@example.net";
const MESSAGE_ID = "<cf-msg-1@saasmail.test>";
const ts = () => Math.floor(Date.now() / 1000);

function parse(body: unknown): DeliveryEvent {
  const event = parseCloudflareEvent(body);
  if (event === null || event === "ignore") throw new Error("not an event");
  return event;
}

function queueMessage(body: unknown, attempts = 1) {
  return {
    id: `m-${Math.random()}`,
    timestamp: new Date(),
    body,
    attempts,
    ack: vi.fn(),
    retry: vi.fn(),
  };
}

async function runQueue(
  message: ReturnType<typeof queueMessage>,
  runSuggestedReply = vi.fn(),
) {
  await handleQueueBatch(
    {
      queue: "test",
      messages: [message],
      ackAll: vi.fn(),
      retryAll: vi.fn(),
    } as unknown as MessageBatch<unknown>,
    env as unknown as CloudflareBindings,
    { runSuggestedReply },
  );
  return runSuggestedReply;
}

async function seedList(id: string) {
  await getDb().insert(lists).values({
    id,
    name: id,
    description: null,
    fromAddress: INBOX,
    archivedAt: null,
    createdAt: ts(),
    updatedAt: ts(),
  });
}

/** A contact on two lists, both subscribed. */
async function seedMember(email = DEAD) {
  await seedList("list-a");
  await seedList("list-b");
  await getDb().insert(contacts).values({
    id: "c-1",
    email,
    name: null,
    personId: null,
    createdAt: ts(),
    updatedAt: ts(),
  });
  for (const listId of ["list-a", "list-b"]) {
    await getDb()
      .insert(listMembers)
      .values({
        id: `m-${listId}`,
        listId,
        contactId: "c-1",
        email,
        status: "subscribed",
        source: "api",
        consentSource: "api",
        consentAt: ts(),
        importJobId: null,
        subscribedAt: ts(),
        unsubscribedAt: null,
        unsubscribeReason: null,
        createdAt: ts(),
      });
  }
}

async function snapshot() {
  const db = getDb();
  return {
    events: await db.select().from(deliveryEvents),
    suppressions: await db.select().from(suppressions),
    members: await db.select().from(listMembers).orderBy(listMembers.id),
    audit: (await db.select().from(auditEvents)).filter((e) =>
      e.action.startsWith("mail."),
    ),
  };
}

beforeAll(applyMigrations);

describe("recordDeliveryEvent", () => {
  beforeEach(cleanDb);

  it("records a hard bounce once: row, suppression, every list left", async () => {
    await createTestSentEmail({ id: "se-1", messageId: MESSAGE_ID });
    await seedMember();

    const outcome = await recordDeliveryEvent(getDb(), parse(bouncedEvent()));
    expect(outcome).toMatchObject({
      sentEmailId: "se-1",
      suppression: "hard_bounce",
      listsLeft: 2,
    });

    const after = await snapshot();
    expect(after.events).toHaveLength(1);
    expect(after.events[0]).toMatchObject({
      id: "cloudflare:0190d0c4-7ea1-7af2-8b88-c1d2e3f4a5b6",
      kind: "bounced",
      bounceType: "hard",
      sentEmailId: "se-1",
      messageId: MESSAGE_ID,
      recipient: DEAD,
      smtpStatus: "550 5.1.1",
      detail: "550 5.1.1 User unknown",
      occurredAt: EVENT_TIMESTAMP,
    });
    expect(after.suppressions).toEqual([
      expect.objectContaining({
        email: DEAD,
        reason: "hard_bounce",
        source: "cloudflare",
        note: "550 5.1.1",
      }),
    ]);
    expect(after.members.map((m) => [m.status, m.unsubscribeReason])).toEqual([
      ["unsubscribed", "hard_bounce"],
      ["unsubscribed", "hard_bounce"],
    ]);
    // Audited without the address.
    expect(after.audit).toHaveLength(1);
    expect(after.audit[0]).toMatchObject({
      action: "mail.bounced",
      targetType: "message",
      targetId: "sent:se-1",
    });
    expect(JSON.stringify(after.audit[0])).not.toContain(DEAD);

    // The same event again changes nothing.
    expect(
      await recordDeliveryEvent(getDb(), parse(bouncedEvent())),
    ).toBeNull();
    expect(await snapshot()).toEqual(after);
  });

  it("commits nothing when the batch fails, and the retry applies it all", async () => {
    await seedMember();
    const event = parse(bouncedEvent());
    await expect(
      recordDeliveryEvent(getDb(), event, {
        // A NOT NULL column left null: the statement fails inside the batch.
        extend: ({ db }) => [
          db.insert(contacts).values({
            id: "c-bad",
            email: null as unknown as string,
            createdAt: ts(),
            updatedAt: ts(),
          }),
        ],
      }),
    ).rejects.toThrow();
    let state = await snapshot();
    expect(state.events).toEqual([]);
    expect(state.suppressions).toEqual([]);
    expect(state.members.every((m) => m.status === "subscribed")).toBe(true);

    expect(await recordDeliveryEvent(getDb(), event)).not.toBeNull();
    state = await snapshot();
    expect(state.events).toHaveLength(1);
    expect(state.suppressions[0].reason).toBe("hard_bounce");
    expect(state.members.every((m) => m.status === "unsubscribed")).toBe(true);
  });

  it("keeps an existing reason on a complaint, and still leaves the lists", async () => {
    await seedMember();
    await getDb().insert(suppressions).values({
      id: "s-1",
      email: DEAD,
      reason: "unsubscribe",
      source: "link",
      note: null,
      createdAt: ts(),
    });
    const outcome = await recordDeliveryEvent(
      getDb(),
      parse(complainedEvent()),
    );
    expect(outcome?.suppression).toBe("complaint");
    const state = await snapshot();
    expect(state.suppressions).toEqual([
      expect.objectContaining({ id: "s-1", reason: "unsubscribe" }),
    ]);
    expect(state.members.map((m) => m.unsubscribeReason)).toEqual([
      "complaint",
      "complaint",
    ]);
  });

  it("upgrades an existing reason to hard_bounce", async () => {
    await getDb().insert(suppressions).values({
      id: "s-1",
      email: DEAD,
      reason: "complaint",
      source: "cloudflare",
      note: null,
      createdAt: ts(),
    });
    await recordDeliveryEvent(getDb(), parse(bouncedEvent()));
    const [row] = await getDb().select().from(suppressions);
    expect(row).toMatchObject({ id: "s-1", reason: "hard_bounce" });
  });

  it("suppresses as soft_bounce at the third soft bounce in 30 days", async () => {
    await seedMember();
    for (const n of [1, 2]) {
      const outcome = await recordDeliveryEvent(
        getDb(),
        parse(bouncedEvent({ type: "soft", eventId: `soft-${n}` })),
      );
      expect(outcome?.suppression).toBeNull();
    }
    expect(await getDb().select().from(suppressions)).toEqual([]);

    const third = await recordDeliveryEvent(
      getDb(),
      parse(bouncedEvent({ type: "soft", eventId: "soft-3" })),
    );
    expect(third?.suppression).toBe("soft_bounce");
    const state = await snapshot();
    expect(state.suppressions[0].reason).toBe("soft_bounce");
    // A soft bounce never touches the lists.
    expect(state.members.every((m) => m.status === "subscribed")).toBe(true);
  });

  it("does not count soft bounces older than 30 days", async () => {
    const old = EVENT_TIMESTAMP - 31 * 24 * 60 * 60;
    for (const n of [1, 2]) {
      await recordDeliveryEvent(getDb(), {
        ...parse(bouncedEvent({ type: "soft", eventId: `old-${n}` })),
        occurredAt: old,
      });
    }
    const outcome = await recordDeliveryEvent(
      getDb(),
      parse(bouncedEvent({ type: "soft", eventId: "new" })),
    );
    expect(outcome?.suppression).toBeNull();
  });

  it("counts soft bounces only: two cleared hard bounces and one soft suppress nothing", async () => {
    for (const n of [1, 2]) {
      await recordDeliveryEvent(
        getDb(),
        parse(bouncedEvent({ eventId: `hard-${n}` })),
      );
      await getDb().delete(suppressions);
    }
    const outcome = await recordDeliveryEvent(
      getDb(),
      parse(bouncedEvent({ type: "soft", eventId: "soft-1" })),
    );
    expect(outcome?.suppression).toBeNull();
    expect(await getDb().select().from(suppressions)).toEqual([]);
  });

  it("does not let a late, 100-day-old soft bounce complete the threshold", async () => {
    for (const n of [1, 2]) {
      await recordDeliveryEvent(
        getDb(),
        parse(bouncedEvent({ type: "soft", eventId: `recent-${n}` })),
      );
    }
    const late = await recordDeliveryEvent(getDb(), {
      ...parse(bouncedEvent({ type: "soft", eventId: "late" })),
      occurredAt: EVENT_TIMESTAMP - 100 * 24 * 60 * 60,
    });
    expect(late?.suppression).toBeNull();
    expect(await getDb().select().from(suppressions)).toEqual([]);
  });

  it("suppresses when three soft bounces within 30 days arrive out of order", async () => {
    const at = (days: number) => EVENT_TIMESTAMP - days * 24 * 60 * 60;
    // Occurred at -20, -10 and 0 days; the middle one arrives last.
    for (const [id, days] of [
      ["s-0", 0],
      ["s-20", 20],
    ] as const) {
      await recordDeliveryEvent(getDb(), {
        ...parse(bouncedEvent({ type: "soft", eventId: id })),
        occurredAt: at(days),
      });
    }
    const middle = await recordDeliveryEvent(getDb(), {
      ...parse(bouncedEvent({ type: "soft", eventId: "s-10" })),
      occurredAt: at(10),
    });
    expect(middle?.suppression).toBe("soft_bounce");
  });

  it("does not suppress three soft bounces spread over more than 30 days", async () => {
    const at = (days: number) => EVENT_TIMESTAMP - days * 24 * 60 * 60;
    for (const [id, days] of [
      ["s-0", 0],
      ["s-40", 40],
      ["s-20", 20],
    ] as const) {
      await recordDeliveryEvent(getDb(), {
        ...parse(bouncedEvent({ type: "soft", eventId: id })),
        occurredAt: at(days),
      });
    }
    expect(await getDb().select().from(suppressions)).toEqual([]);
  });

  it("decides the threshold inside the batch: three concurrent soft bounces suppress once", async () => {
    await Promise.all(
      [1, 2, 3].map((n) =>
        recordDeliveryEvent(
          getDb(),
          parse(bouncedEvent({ type: "soft", eventId: `c-${n}` })),
        ),
      ),
    );
    const rows = await getDb().select().from(suppressions);
    expect(rows).toHaveLength(1);
    expect(rows[0].reason).toBe("soft_bounce");
  });

  it("does not suppress again when the third soft bounce is redelivered after an admin cleared it", async () => {
    for (const n of [1, 2, 3]) {
      await recordDeliveryEvent(
        getDb(),
        parse(bouncedEvent({ type: "soft", eventId: `soft-${n}` })),
      );
    }
    await getDb().delete(suppressions);
    expect(
      await recordDeliveryEvent(
        getDb(),
        parse(bouncedEvent({ type: "soft", eventId: "soft-3" })),
      ),
    ).toBeNull();
    expect(await getDb().select().from(suppressions)).toEqual([]);
  });

  it("suppresses an event without messageId, uncorrelated", async () => {
    await createTestSentEmail({ id: "se-1", messageId: MESSAGE_ID });
    const outcome = await recordDeliveryEvent(
      getDb(),
      parse(bouncedEvent({ messageId: null })),
    );
    expect(outcome).toMatchObject({
      sentEmailId: null,
      suppression: "hard_bounce",
    });
    const [row] = await getDb().select().from(deliveryEvents);
    expect(row).toMatchObject({ sentEmailId: null, messageId: null });
  });

  it("applies the provider rejection rules", async () => {
    const suppressed = await recordDeliveryEvent(
      getDb(),
      parse(rejectedEvent()),
    );
    expect(suppressed?.suppression).toBe("provider");
    const other = await recordDeliveryEvent(
      getDb(),
      parse(
        rejectedEvent({
          eventId: "r-2",
          recipient: "b@example.net",
          reason: "spam",
        }),
      ),
    );
    expect(other?.suppression).toBeNull();
    const failed = await recordDeliveryEvent(
      getDb(),
      parse(failedEvent({ recipient: "c@example.net" })),
    );
    expect(failed?.suppression).toBeNull();
    expect(
      (await getDb().select().from(suppressions)).map((s) => s.email),
    ).toEqual([DEAD]);
    expect(await getDb().select().from(deliveryEvents)).toHaveLength(3);
  });
});

describe("parseCloudflareEvent", () => {
  it("parses the example body", () => {
    expect(parse(bouncedEvent())).toEqual({
      provider: "cloudflare",
      providerEventId: "0190d0c4-7ea1-7af2-8b88-c1d2e3f4a5b6",
      kind: "bounced",
      bounceType: "hard",
      messageId: MESSAGE_ID,
      recipient: DEAD,
      sender: "support@saasmail.test",
      smtpStatus: "550 5.1.1",
      detail: "550 5.1.1 User unknown",
      rejectionReason: null,
      occurredAt: EVENT_TIMESTAMP,
    });
  });

  it("falls back to now for a bad timestamp", () => {
    const now = 1_800_000_000;
    for (const eventTimestamp of ["not a date", 12, undefined]) {
      const event = parseCloudflareEvent(bouncedEvent({ eventTimestamp }), now);
      expect(event).toMatchObject({ occurredAt: now });
    }
  });

  it("ignores types it does not handle and refuses malformed bodies", () => {
    expect(parseCloudflareEvent(deliveredEvent())).toBe("ignore");
    expect(
      parseCloudflareEvent({
        ...bouncedEvent(),
        type: "cf.email.sending.message.constructor",
      }),
    ).toBe("ignore");
    expect(
      parseCloudflareEvent({ type: "cf.email.sending.message.deferred" }),
    ).toBe("ignore");
    const noId = bouncedEvent();
    delete (noId.payload as Record<string, unknown>).eventId;
    expect(parseCloudflareEvent(noId)).toBeNull();
    const badRecipient = bouncedEvent();
    (badRecipient.payload as Record<string, unknown>).recipient = 42;
    expect(parseCloudflareEvent(badRecipient)).toBeNull();
    const oddId = bouncedEvent();
    (oddId.payload as Record<string, unknown>).messageId = { x: 1 };
    expect(parse(oddId).messageId).toBeNull();
  });

  it("lowercases the recipient and truncates the detail", () => {
    const body = bouncedEvent({ recipient: "  User@Example.NET " });
    body.payload.bounce.reason = "x".repeat(600);
    const event = parse(body);
    expect(event.recipient).toBe(DEAD);
    expect(event.detail).toHaveLength(500);
  });
});

describe("delivery events on EMAIL_QUEUE", () => {
  beforeEach(async () => {
    await cleanDb();
    (env as any).DEMO_MODE = "0";
  });

  it("classifies a Cloudflare event and never runs a suggested reply", async () => {
    expect(classifyQueueMessage(bouncedEvent())).toBe("delivery_event");
    expect(classifyQueueMessage(deliveredEvent())).toBe("delivery_event");
    await createTestSentEmail({ id: "se-1", messageId: MESSAGE_ID });
    const message = queueMessage(bouncedEvent());
    const suggest = await runQueue(message);
    expect(suggest).not.toHaveBeenCalled();
    expect(message.ack).toHaveBeenCalledOnce();
    expect(message.retry).not.toHaveBeenCalled();
    expect(await getDb().select().from(deliveryEvents)).toHaveLength(1);
  });

  it("retries an uncorrelated first attempt with a delay, then records it", async () => {
    const first = queueMessage(bouncedEvent(), 1);
    await runQueue(first);
    expect(first.retry).toHaveBeenCalledWith({ delaySeconds: 60 });
    expect(first.ack).not.toHaveBeenCalled();
    expect(await getDb().select().from(deliveryEvents)).toEqual([]);

    // The sent row landed meanwhile: the second attempt correlates.
    await createTestSentEmail({ id: "se-late", messageId: MESSAGE_ID });
    const second = queueMessage(bouncedEvent(), 2);
    await runQueue(second);
    expect(second.ack).toHaveBeenCalledOnce();
    const [row] = await getDb().select().from(deliveryEvents);
    expect(row.sentEmailId).toBe("se-late");
  });

  it("acks a delivered event and a malformed one without a write", async () => {
    const delivered = queueMessage(deliveredEvent());
    await runQueue(delivered);
    expect(delivered.ack).toHaveBeenCalledOnce();
    const malformed = queueMessage({
      type: "cf.email.sending.message.bounced",
      payload: {},
    });
    await runQueue(malformed);
    expect(malformed.ack).toHaveBeenCalledOnce();
    expect(await getDb().select().from(deliveryEvents)).toEqual([]);
    expect(await getDb().select().from(suppressions)).toEqual([]);
  });
});

describe("hard bounces block transactional mail", () => {
  let apiKey: string;

  beforeEach(async () => {
    await cleanDb();
    ({ apiKey } = await createTestUser());
    (env as any).DEMO_MODE = "0";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    (env as any).DEMO_MODE = "0";
  });

  async function receivedFrom(address: string) {
    const person = await createTestPerson({ id: "p-1", email: address });
    await createTestEmail({
      id: "rcv-1",
      personId: person.id,
      recipient: INBOX,
      subject: "Question",
    });
  }

  function reply(headers: Record<string, string> = {}) {
    return authFetch("/api/send/reply/rcv-1", {
      apiKey,
      method: "POST",
      headers,
      body: buildSendForm({ fromAddress: INBOX, bodyHtml: "<p>Thanks</p>" }),
    });
  }

  async function sentCount() {
    return (await getDb().select().from(sentEmails)).length;
  }

  it("a hard-bounce event leaves every list and refuses the next reply with 422; twice changes nothing", async () => {
    await receivedFrom(DEAD);
    await seedMember();
    const message = queueMessage(bouncedEvent(), 2);
    await runQueue(message);
    const once = await snapshot();
    expect(once.members.every((m) => m.status === "unsubscribed")).toBe(true);

    (env as any).DEMO_MODE = "1";
    const res = await reply();
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({
      code: "RECIPIENT_HARD_BOUNCED",
      addresses: [DEAD],
    });
    expect(await sentCount()).toBe(0);

    (env as any).DEMO_MODE = "0";
    await runQueue(queueMessage(bouncedEvent(), 2));
    expect(await snapshot()).toEqual(once);
  });

  it("refuses a compose to a hard-bounced Cc", async () => {
    (env as any).DEMO_MODE = "1";
    await recordDeliveryEvent(getDb(), parse(bouncedEvent()));
    const res = await authFetch("/api/send", {
      apiKey,
      method: "POST",
      body: buildSendForm({
        to: "fine@example.com",
        cc: [{ email: DEAD }],
        fromAddress: INBOX,
        subject: "Hi",
        bodyHtml: "<p>hi</p>",
        transactional: true,
      }),
    });
    expect(res.status).toBe(422);
    expect(await sentCount()).toBe(0);
  });

  it("sends a non-transactional compose to the clean recipient and lists the bounced one as suppressed", async () => {
    (env as any).DEMO_MODE = "1";
    await recordDeliveryEvent(getDb(), parse(bouncedEvent()));
    const res = await authFetch("/api/send", {
      apiKey,
      method: "POST",
      body: buildSendForm({
        to: "fine@example.com",
        cc: [{ email: DEAD }],
        fromAddress: INBOX,
        subject: "News",
        bodyHtml: "<p>news</p>",
        transactional: false,
      }),
    });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({
      delivered: ["fine@example.com"],
      suppressed: [DEAD],
    });
    expect(await sentCount()).toBe(1);
  });

  it("refuses a reply from a Gmail-mapped inbox before Gmail is called", async () => {
    const now = ts();
    await getDb()
      .insert(gmailAccounts)
      .values({
        id: "acct-1",
        emailAddress: "collector@xyspace.dev",
        refreshTokenEncrypted: await encryptSecret(
          "rt-1",
          "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
        ),
        accessToken: "cached-at",
        expiresAt: now + 3600,
        historyId: "1",
        connectedBy: "user-1",
        createdAt: now,
        updatedAt: now,
      });
    await getDb().insert(senderIdentities).values({
      email: INBOX,
      displayName: "Support",
      source: "gmail",
      gmailAccountId: "acct-1",
      createdAt: now,
      updatedAt: now,
    });
    await receivedFrom(DEAD);
    await recordDeliveryEvent(getDb(), parse(bouncedEvent()));
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const res = await reply();
    expect(res.status).toBe(422);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await sentCount()).toBe(0);
  });

  it("still replies to an address that complained", async () => {
    (env as any).DEMO_MODE = "1";
    await receivedFrom(DEAD);
    await recordDeliveryEvent(getDb(), parse(complainedEvent()));
    const res = await reply();
    expect(res.status).toBe(201);
    expect(await sentCount()).toBe(1);
  });

  it("sends a retry with the same idempotency key once the suppression is removed", async () => {
    (env as any).DEMO_MODE = "1";
    await receivedFrom(DEAD);
    await recordDeliveryEvent(getDb(), parse(bouncedEvent()));
    const key = { "Idempotency-Key": "k-bounce-1" };
    expect((await reply(key)).status).toBe(422);

    await getDb().delete(suppressions).where(eq(suppressions.email, DEAD));
    const retry = await reply(key);
    expect(retry.status).toBe(201);
    expect(retry.headers.get("Idempotency-Replayed")).toBeNull();
    expect(await sentCount()).toBe(1);
  });

  it("refuses an outbox retry whose Cc hard-bounced", async () => {
    await createTestSentEmail({ id: "se-1", status: "retrying" });
    await getDb()
      .insert(outboxEmails)
      .values({
        id: "ob-1",
        sentEmailId: "se-1",
        fromAddress: INBOX,
        toAddress: "fine@example.com",
        cc: JSON.stringify([{ email: DEAD, name: null }]),
        subject: "Hi",
        bodyHtml: "<p>hi</p>",
        transactional: 1,
        status: "pending",
        attempts: 1,
        nextRetryAt: ts() - 10,
        createdAt: ts(),
        updatedAt: ts(),
      });
    await recordDeliveryEvent(getDb(), parse(bouncedEvent()));
    const calls: SendEmailParams[] = [];
    const sender: EmailSender = {
      provider: "cloudflare",
      async send(params) {
        calls.push(params);
        return { id: "prov-1", error: null };
      },
      maxAttachmentBytes: () => 1e7,
      maxMessageBytes: () => 1e7,
    };

    expect(
      await attemptOutboxRow(
        getDb(),
        env as unknown as CloudflareBindings,
        sender,
        "ob-1",
      ),
    ).toBe("suppressed");
    expect(calls).toEqual([]);
    expect(await getDb().select().from(outboxEmails)).toEqual([]);
    const [sent] = await getDb().select().from(sentEmails);
    expect(sent.status).toBe("failed");
  });
});

describe("hard bounces and JMAP", () => {
  let authorId: string;

  beforeEach(async () => {
    await cleanDb();
    (env as any).DEMO_MODE = "0";
    ({ authorId } = await seedAccount());
  });

  async function draft(): Promise<string> {
    const res = (await jmapCall(authorId, [
      [
        "Email/set",
        { accountId: acct(authorId), create: { d1: draftCreate() } },
        "a",
      ],
    ])) as [string, Record<string, any>, string][];
    return res[0][1].created.d1.id as string;
  }

  function submit(emailId: string, holdFor?: string) {
    return jmapCall(
      authorId,
      [
        [
          "EmailSubmission/set",
          {
            accountId: acct(authorId),
            create: {
              s1: {
                identityId: idn(JMAP_INBOX),
                emailId,
                ...(holdFor
                  ? {
                      envelope: {
                        mailFrom: {
                          email: JMAP_INBOX,
                          parameters: { HOLDFOR: holdFor },
                        },
                        rcptTo: [
                          { email: "alice@example.com" },
                          { email: "bob@example.com" },
                        ],
                      },
                    }
                  : {}),
              },
            },
          },
          "s",
        ],
      ],
      { sender: recordingSender().sender },
    ) as Promise<[string, Record<string, any>, string][]>;
  }

  async function hardBounce(address: string) {
    await recordDeliveryEvent(
      getDb(),
      parse(bouncedEvent({ recipient: address })),
    );
  }

  it("refuses a submission to a hard-bounced address with invalidRecipients", async () => {
    const draftId = await draft();
    await hardBounce("alice@example.com");
    const res = await submit(draftId);
    expect(res[0][1].notCreated.s1).toMatchObject({
      type: "invalidRecipients",
      invalidRecipients: ["alice@example.com"],
    });
  });

  it("sends nothing when a scheduled send's recipient hard-bounced meanwhile", async () => {
    const draftId = await draft();
    const res = await submit(draftId, "600");
    expect(res[0][1].created?.s1).toBeDefined();
    const [row] = await getDb().select().from(jmapSubmissions);
    await hardBounce("alice@example.com");

    const { sender, calls } = recordingSender();
    expect(
      await releaseScheduledSubmission(env, row.id, {
        sender,
        now: row.sendAt,
      }),
    ).toBe("failed");
    expect(calls).toEqual([]);
    const [sent] = await getDb()
      .select()
      .from(sentEmails)
      .where(eq(sentEmails.id, row.sentEmailId));
    expect(sent.status).toBe("failed");
  });
});

describe("reads carry deliveryProblems", () => {
  let apiKey: string;

  beforeEach(async () => {
    await cleanDb();
    ({ apiKey } = await createTestUser());
  });

  async function seedSentWithBounce() {
    await createTestPerson({ id: "p-1", email: DEAD });
    await createTestSentEmail({
      id: "se-1",
      personId: "p-1",
      fromAddress: INBOX,
      toAddress: DEAD,
      cc: JSON.stringify([{ email: "fine@example.com", name: null }]),
      messageId: MESSAGE_ID,
      conversationId: "conv-1",
    });
    await recordDeliveryEvent(getDb(), parse(bouncedEvent()));
  }

  const PROBLEM = {
    kind: "bounced",
    bounceType: "hard",
    recipient: DEAD,
    smtpStatus: "550 5.1.1",
    detail: "550 5.1.1 User unknown",
    occurredAt: EVENT_TIMESTAMP,
  };

  it("on the person timeline, the conversation and /mail", async () => {
    await seedSentWithBounce();

    const timeline = await (
      await authFetch("/api/emails/by-person/p-1", { apiKey })
    ).json<any>();
    const sentOnTimeline = timeline.emails.find((e: any) => e.id === "se-1");
    expect(sentOnTimeline.deliveryProblems).toEqual([PROBLEM]);

    const conversation = await (
      await authFetch("/api/conversations/conv-1/emails", { apiKey })
    ).json<any>();
    expect(conversation.emails[0].deliveryProblems).toEqual([PROBLEM]);

    const mail = await (
      await authFetch("/api/messages?personId=p-1", { apiKey })
    ).json<any>();
    const sentInMail = mail.messages.find((m: any) => m.ref === "sent:se-1");
    expect(sentInMail.deliveryProblems).toEqual([PROBLEM]);
    expect(sentInMail.delivery).toEqual({ status: "sent" });
  });

  it("is empty for a sent message without events", async () => {
    await createTestPerson({ id: "p-1", email: DEAD });
    await createTestSentEmail({ id: "se-1", personId: "p-1" });
    const timeline = await (
      await authFetch("/api/emails/by-person/p-1", { apiKey })
    ).json<any>();
    expect(timeline.emails[0].deliveryProblems).toEqual([]);
  });

  it("campaign stats count bounces and complaints by campaign", async () => {
    await seedList("list-a");
    for (const id of ["camp-1", "camp-2"]) {
      await getDb().insert(campaigns).values({
        id,
        name: id,
        subject: "S",
        templateSlug: "weekly",
        bodyHtml: "<p>x</p>",
        fromAddress: INBOX,
        listId: "list-a",
        status: "sent",
        sentAt: ts(),
        createdAt: ts(),
        updatedAt: ts(),
      });
    }
    const sends: [string, string, string][] = [
      ["se-1", "camp-1", "<a@saasmail.test>"],
      ["se-2", "camp-1", "<b@saasmail.test>"],
      ["se-3", "camp-2", "<c@saasmail.test>"],
    ];
    for (const [id, campaignId, messageId] of sends) {
      await createTestSentEmail({ id, campaignId, messageId });
    }
    await recordDeliveryEvent(
      getDb(),
      parse(bouncedEvent({ eventId: "e1", messageId: "<a@saasmail.test>" })),
    );
    await recordDeliveryEvent(
      getDb(),
      parse(
        complainedEvent({
          eventId: "e2",
          messageId: "<b@saasmail.test>",
          recipient: "b@example.net",
        }),
      ),
    );
    await recordDeliveryEvent(
      getDb(),
      parse(
        bouncedEvent({
          eventId: "e3",
          messageId: "<c@saasmail.test>",
          recipient: "c@example.net",
        }),
      ),
    );

    const detail = await (
      await authFetch("/api/campaigns/camp-1", { apiKey })
    ).json<any>();
    expect(detail.stats).toMatchObject({ bounces: 1, complaints: 1 });
    const other = await (
      await authFetch("/api/campaigns/camp-2", { apiKey })
    ).json<any>();
    expect(other.stats).toMatchObject({ bounces: 1, complaints: 0 });
  });

  it("list members show the reason they left", async () => {
    await seedMember();
    await recordDeliveryEvent(getDb(), parse(bouncedEvent()));
    const page = await (
      await authFetch("/api/lists/list-a/members", { apiKey })
    ).json<any>();
    expect(page.items[0]).toMatchObject({
      status: "unsubscribed",
      unsubscribeReason: "hard_bounce",
    });
  });
});

describe("contact export and erase", () => {
  let apiKey: string;

  beforeEach(async () => {
    await cleanDb();
    ({ apiKey } = await createTestUser());
  });

  it("exports an address known only from an event, and erase pseudonymizes it", async () => {
    await recordDeliveryEvent(getDb(), parse(bouncedEvent()));

    const exported = await authFetch(
      `/api/contacts/${encodeURIComponent(DEAD)}/export`,
      { apiKey },
    );
    expect(exported.status).toBe(200);
    const body = await exported.json<any>();
    expect(body.deliveryEvents).toHaveLength(1);
    expect(body.deliveryEvents[0].recipient).toBe(DEAD);

    const erased = await authFetch(
      `/api/contacts/${encodeURIComponent(DEAD)}/erase`,
      { apiKey, method: "POST" },
    );
    expect(erased.status).toBe(200);
    expect((await erased.json<any>()).deliveryEvents).toBe(1);
    const [row] = await getDb().select().from(deliveryEvents);
    expect(row.recipient).toMatch(/^erased\+[0-9a-f]+@invalid$/);
    expect(row).toMatchObject({
      sender: null,
      detail: null,
      smtpStatus: null,
      kind: "bounced",
    });
  });
});

describe("unsubscribe links never undo a provider's decision", () => {
  // Matches the binding in vitest.config.test.ts.
  const SECRET = "test-secret-do-not-use-in-prod";

  beforeEach(cleanDb);

  async function undoV1(email: string) {
    const token = await signToken(email, SECRET);
    return authFetch(
      `/api/unsubscribe/undo?token=${encodeURIComponent(token)}`,
      { method: "POST" },
    );
  }

  it("a v1 undo keeps a hard_bounce suppression and answers 410", async () => {
    await recordDeliveryEvent(getDb(), parse(bouncedEvent()));
    const res = await undoV1(DEAD);
    expect(res.status).toBe(410);
    const rows = await getDb().select().from(suppressions);
    expect(rows.map((r) => r.reason)).toEqual(["hard_bounce"]);
  });

  it("a v1 undo still removes the unsubscribe its link made", async () => {
    await getDb().insert(suppressions).values({
      id: "s-1",
      email: DEAD,
      reason: "unsubscribe",
      source: "one-click",
      note: null,
      createdAt: ts(),
    });
    const res = await undoV1(DEAD);
    expect(res.status).toBe(200);
    expect(await getDb().select().from(suppressions)).toEqual([]);
  });

  it("a v2 undo does not restore a membership a hard bounce removed", async () => {
    await seedMember();
    await getDb().insert(campaigns).values({
      id: "camp-1",
      name: "c",
      subject: "S",
      templateSlug: "weekly",
      bodyHtml: "<p>x</p>",
      fromAddress: INBOX,
      listId: "list-a",
      status: "sent",
      sentAt: ts(),
      createdAt: ts(),
      updatedAt: ts(),
    });
    await getDb().insert(campaignUnsubscribeAttributions).values({
      id: "ua-1",
      campaignId: "camp-1",
      listMemberId: "m-list-a",
      occurredAt: ts(),
    });
    await recordDeliveryEvent(getDb(), parse(bouncedEvent()));

    const outcome = await undoListUnsubscribe(getDb(), {
      listId: "list-a",
      campaignId: "camp-1",
      contactId: "c-1",
    });
    expect(outcome.error).toBe("window_closed");
    const [member] = await getDb()
      .select()
      .from(listMembers)
      .where(eq(listMembers.id, "m-list-a"));
    expect(member).toMatchObject({
      status: "unsubscribed",
      unsubscribeReason: "hard_bounce",
    });
    expect(
      await getDb().select().from(campaignUnsubscribeAttributions),
    ).toHaveLength(1);
  });
});

describe("a Cc copy of a non-transactional send", () => {
  beforeEach(async () => {
    await cleanDb();
    (env as any).DEMO_MODE = "0";
  });

  it("correlates its bounce through the copy's Message-ID", async () => {
    // Each copy gets its own provider Message-ID, named after its recipient.
    const sender: EmailSender = {
      provider: "cloudflare",
      async send(params) {
        const local = String(params.to)
          .replace(/^.*<|>.*$/g, "")
          .split("@")[0];
        return {
          id: `<${local}@cf.test>`,
          error: null,
          deliveredMessageId: `<${local}@cf.test>`,
        };
      },
      maxAttachmentBytes: () => 1e7,
      maxMessageBytes: () => 1e7,
    };
    const result = await sendEmail({
      db: getDb(),
      env: env as unknown as CloudflareBindings,
      payload: {
        to: "first@example.com",
        cc: [{ email: "second@example.com" }],
        fromAddress: INBOX,
        subject: "News",
        bodyHtml: "<p>news</p>",
        transactional: false,
      },
      files: [],
      allowed: { isAdmin: true },
      sender,
    });
    expect(result.ok).toBe(true);

    const outcome = await recordDeliveryEvent(
      getDb(),
      parse(
        bouncedEvent({
          messageId: "<second@cf.test>",
          recipient: "second@example.com",
        }),
      ),
    );
    expect(outcome?.sentEmailId).toBe(result.id);
  });

  it("records all 49 Cc copies in one statement, and the last one correlates", async () => {
    const sender: EmailSender = {
      provider: "cloudflare",
      async send(params) {
        const local = String(params.to)
          .replace(/^.*<|>.*$/g, "")
          .split("@")[0];
        return {
          id: `<${local}@cf.test>`,
          error: null,
          deliveredMessageId: `<${local}@cf.test>`,
        };
      },
      maxAttachmentBytes: () => 1e7,
      maxMessageBytes: () => 1e7,
    };
    const cc = Array.from({ length: 49 }, (_, n) => ({
      email: `cc${n + 1}@example.com`,
    }));
    const result = await sendEmail({
      db: getDb(),
      env: env as unknown as CloudflareBindings,
      payload: {
        to: "first@example.com",
        cc,
        fromAddress: INBOX,
        subject: "News",
        bodyHtml: "<p>news</p>",
        transactional: false,
      },
      files: [],
      allowed: { isAdmin: true },
      sender,
    });
    expect(result.ok).toBe(true);
    expect(await getDb().select().from(deliveryMessageIds)).toHaveLength(49);

    const outcome = await recordDeliveryEvent(
      getDb(),
      parse(
        bouncedEvent({
          messageId: "<cc49@cf.test>",
          recipient: "cc49@example.com",
        }),
      ),
    );
    expect(outcome?.sentEmailId).toBe(result.id);
  });
});
