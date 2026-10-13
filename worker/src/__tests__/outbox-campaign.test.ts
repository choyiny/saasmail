import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { applyMigrations, cleanDb, getDb } from "./helpers";
import { outboxEmails } from "../db/outbox-emails.schema";
import { sentEmails } from "../db/sent-emails.schema";
import {
  attemptOutboxRow,
  finalizeOutboxRow,
  sendViaOutbox,
  processOutbox,
} from "../lib/outbox";
import type {
  EmailSender,
  SendEmailParams,
  SendEmailResult,
} from "../lib/email-sender";

beforeAll(applyMigrations);
beforeEach(cleanDb);

function fakeSender(result: SendEmailResult): EmailSender & {
  calls: SendEmailParams[];
} {
  const calls: SendEmailParams[] = [];
  return {
    provider: "none" as const,
    calls,
    async send(params: SendEmailParams) {
      calls.push(params);
      return result;
    },
    maxAttachmentBytes: () => 25 * 1024 * 1024,
  };
}

const OK: SendEmailResult = { id: "prov-1", error: null };
const TRANSIENT: SendEmailResult = {
  id: null,
  error: { message: "quota exceeded", transient: true },
};

const baseParams = {
  fromAddress: "me@saasmail.test",
  from: "Me <me@saasmail.test>",
  to: "sub@example.com",
  subject: "Hi",
  html: "<p>Hi</p>",
  transactional: false,
};

async function outboxRows() {
  return getDb().select().from(outboxEmails);
}

describe("sendViaOutbox — campaign sends", () => {
  /**
   * The core of the crash-recovery design. Deleting the row the instant the
   * provider accepts erases the only durable evidence that it did; a crash
   * before the campaign writes its own rows would then be indistinguishable
   * from a send that never happened, and the retry would duplicate it.
   */
  it("holds the row as bookkeeping_pending instead of deleting it", async () => {
    const sender = fakeSender(OK);
    const result = await sendViaOutbox({
      db: getDb(),
      env: env as unknown as CloudflareBindings,
      sender,
      sentEmailId: "se-1",
      campaignRecipientId: "cr-1",
      ...baseParams,
    });

    expect(result.outcome).toBe("sent");
    const rows = await outboxRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("bookkeeping_pending");
    expect(rows[0].campaignRecipientId).toBe("cr-1");
    expect(result.outboxId).toBe(rows[0].id);
  });

  it("still deletes the row for a non-campaign send", async () => {
    const sender = fakeSender(OK);
    await sendViaOutbox({
      db: getDb(),
      env: env as unknown as CloudflareBindings,
      sender,
      sentEmailId: "se-1",
      ...baseParams,
    });
    // Unchanged behaviour for transactional and sequence mail.
    expect(await outboxRows()).toHaveLength(0);
  });

  it("leaves a transient campaign failure retryable, not held", async () => {
    const sender = fakeSender(TRANSIENT);
    const result = await sendViaOutbox({
      db: getDb(),
      env: env as unknown as CloudflareBindings,
      sender,
      sentEmailId: "se-1",
      campaignRecipientId: "cr-1",
      ...baseParams,
    });

    expect(result.outcome).toBe("retrying");
    const rows = await outboxRows();
    // Nothing was accepted, so there is no bookkeeping owed — this row must
    // stay in the normal retry lane.
    expect(rows[0].status).toBe("pending");
  });

  it("finalizeOutboxRow removes a held row once bookkeeping is committed", async () => {
    const sender = fakeSender(OK);
    const { outboxId } = await sendViaOutbox({
      db: getDb(),
      env: env as unknown as CloudflareBindings,
      sender,
      sentEmailId: "se-1",
      campaignRecipientId: "cr-1",
      ...baseParams,
    });

    await finalizeOutboxRow(getDb(), outboxId);
    expect(await outboxRows()).toHaveLength(0);
  });
});

describe("bookkeeping_pending is never re-sent", () => {
  async function seedHeldRow() {
    const now = Math.floor(Date.now() / 1000);
    await getDb().insert(sentEmails).values({
      id: "se-1",
      personId: null,
      fromAddress: "me@saasmail.test",
      toAddress: "sub@example.com",
      subject: "Hi",
      bodyHtml: "<p>Hi</p>",
      messageId: "<m1@saasmail.test>",
      status: "sent",
      sentAt: now,
      createdAt: now,
    });
    await getDb()
      .insert(outboxEmails)
      .values({
        id: "ob-1",
        sentEmailId: "se-1",
        sequenceEmailId: null,
        campaignRecipientId: "cr-1",
        fromAddress: "me@saasmail.test",
        toAddress: "sub@example.com",
        subject: "Hi",
        bodyHtml: "<p>Hi</p>",
        transactional: 0,
        status: "bookkeeping_pending",
        attempts: 1,
        // Due, so any status-blind sweep would pick it up.
        nextRetryAt: now - 60,
        createdAt: now,
        updatedAt: now,
      });
  }

  /**
   * The single most dangerous failure mode in this design: the message has
   * already been accepted by the provider, so any path that calls the sender
   * again duplicates a real email to a real subscriber.
   */
  it("attemptOutboxRow refuses to claim it and makes zero provider calls", async () => {
    await seedHeldRow();
    const sender = fakeSender(OK);

    const outcome = await attemptOutboxRow(
      getDb(),
      env as unknown as CloudflareBindings,
      sender,
      "ob-1",
    );

    expect(outcome).toBeNull();
    expect(sender.calls).toHaveLength(0);
    // And the row is left exactly as it was, for the reconciliation sweep.
    const rows = await outboxRows();
    expect(rows[0].status).toBe("bookkeeping_pending");
  });

  it("processOutbox does not pick it up", async () => {
    await seedHeldRow();
    await processOutbox(env as unknown as CloudflareBindings);

    // Still held: the retry processor's claim filters on status = 'pending',
    // so a held row is structurally unreachable from the send path.
    const rows = await outboxRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("bookkeeping_pending");
  });
});

describe("attemptOutboxRow — campaign retry that finally succeeds", () => {
  it("holds the row for bookkeeping rather than deleting it", async () => {
    const now = Math.floor(Date.now() / 1000);
    await getDb()
      .insert(sentEmails)
      .values({
        id: "se-1",
        personId: null,
        fromAddress: "me@saasmail.test",
        toAddress: "sub@example.com",
        subject: "Hi",
        bodyHtml: "<p>Hi</p>",
        messageId: "<m1@saasmail.test>",
        status: "retrying",
        sentAt: now - 100,
        createdAt: now - 100,
      });
    await getDb()
      .insert(outboxEmails)
      .values({
        id: "ob-1",
        sentEmailId: "se-1",
        sequenceEmailId: null,
        campaignRecipientId: "cr-1",
        fromAddress: "me@saasmail.test",
        toAddress: "sub@example.com",
        subject: "Hi",
        bodyHtml: "<p>Hi</p>",
        transactional: 0,
        status: "pending",
        attempts: 1,
        nextRetryAt: now - 60,
        createdAt: now - 100,
        updatedAt: now - 100,
      });

    const sender = fakeSender(OK);
    const outcome = await attemptOutboxRow(
      getDb(),
      env as unknown as CloudflareBindings,
      sender,
      "ob-1",
    );

    expect(outcome).toBe("sent");
    expect(sender.calls).toHaveLength(1);

    // A retry that succeeds still owes the campaign its bookkeeping, so the
    // row is handed to the reconciliation sweep rather than dropped.
    const rows = await outboxRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("bookkeeping_pending");

    // sent_emails is still updated as before.
    const se = await getDb()
      .select()
      .from(sentEmails)
      .where(eq(sentEmails.id, "se-1"));
    expect(se[0].status).toBe("sent");
  });
});
