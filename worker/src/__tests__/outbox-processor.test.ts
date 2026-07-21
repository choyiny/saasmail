import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import {
  applyMigrations,
  cleanDb,
  createTestUser,
  createTestPerson,
  getDb,
} from "./helpers";
import { outboxEmails } from "../db/outbox-emails.schema";
import { sentEmails } from "../db/sent-emails.schema";
import { sequenceEmails } from "../db/sequence-emails.schema";
import { sequenceEnrollments } from "../db/sequence-enrollments.schema";
import { sequences } from "../db/sequences.schema";
import { suppressions } from "../db/suppressions.schema";
import { attemptOutboxRow, MAX_OUTBOX_ATTEMPTS } from "../lib/outbox";
import type {
  EmailSender,
  SendEmailParams,
  SendEmailResult,
} from "../lib/email-sender";

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

const OK: SendEmailResult = { id: "prov-2", error: null };
const TRANSIENT: SendEmailResult = {
  id: null,
  error: { message: "quota exceeded", transient: true },
};

/** Insert a due pending outbox row + its retrying sent_emails row. */
async function seedOutboxRow(
  opts: { attempts?: number; sequenceEmailId?: string | null } = {},
) {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  await db.insert(sentEmails).values({
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
  await db.insert(outboxEmails).values({
    id: "ob-1",
    sentEmailId: "se-1",
    sequenceEmailId: opts.sequenceEmailId ?? null,
    fromAddress: "me@saasmail.test",
    toAddress: "to@example.com",
    subject: "Hi",
    bodyHtml: "<p>Hi</p>",
    headers: JSON.stringify({ "Message-ID": "<mid-1@saasmail.test>" }),
    transactional: 1,
    status: "pending",
    attempts: opts.attempts ?? 1,
    lastError: "quota exceeded",
    nextRetryAt: now - 10,
    createdAt: now - 100,
    updatedAt: now - 100,
  });
}

describe("attemptOutboxRow", () => {
  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDb();
    await createTestUser();
  });

  it("resolves sent_emails and deletes the row on success", async () => {
    await seedOutboxRow();
    const db = getDb();
    const sender = fakeSender(OK);
    const outcome = await attemptOutboxRow(
      db,
      env as unknown as CloudflareBindings,
      sender,
      "ob-1",
    );
    expect(outcome).toBe("sent");
    // The retry reused the original Message-ID (idempotency).
    expect(sender.calls[0].headers?.["Message-ID"]).toBe(
      "<mid-1@saasmail.test>",
    );
    const sent = await db
      .select()
      .from(sentEmails)
      .where(eq(sentEmails.id, "se-1"));
    expect(sent[0].status).toBe("sent");
    expect(sent[0].resendId).toBe("prov-2");
    expect(await db.select().from(outboxEmails)).toHaveLength(0);
  });

  it("increments attempts and stays pending on transient failure", async () => {
    await seedOutboxRow({ attempts: 1 });
    const db = getDb();
    const outcome = await attemptOutboxRow(
      db,
      env as unknown as CloudflareBindings,
      fakeSender(TRANSIENT),
      "ob-1",
    );
    expect(outcome).toBe("retrying");
    const rows = await db.select().from(outboxEmails);
    expect(rows[0].status).toBe("pending");
    expect(rows[0].attempts).toBe(2);
    const sent = await db
      .select()
      .from(sentEmails)
      .where(eq(sentEmails.id, "se-1"));
    expect(sent[0].status).toBe("retrying");
  });

  it("terminally fails after MAX_OUTBOX_ATTEMPTS", async () => {
    await seedOutboxRow({ attempts: MAX_OUTBOX_ATTEMPTS - 1 });
    const db = getDb();
    const outcome = await attemptOutboxRow(
      db,
      env as unknown as CloudflareBindings,
      fakeSender(TRANSIENT),
      "ob-1",
    );
    expect(outcome).toBe("failed");
    const rows = await db.select().from(outboxEmails);
    expect(rows[0].status).toBe("failed");
    expect(rows[0].attempts).toBe(MAX_OUTBOX_ATTEMPTS);
    const sent = await db
      .select()
      .from(sentEmails)
      .where(eq(sentEmails.id, "se-1"));
    expect(sent[0].status).toBe("failed");
  });

  it("returns null for a row that is not due (claim race)", async () => {
    await seedOutboxRow();
    const db = getDb();
    const future = Math.floor(Date.now() / 1000) + 3600;
    await db
      .update(outboxEmails)
      .set({ nextRetryAt: future })
      .where(eq(outboxEmails.id, "ob-1"));
    const outcome = await attemptOutboxRow(
      db,
      env as unknown as CloudflareBindings,
      fakeSender(OK),
      "ob-1",
    );
    expect(outcome).toBeNull();
  });

  it("treats mid-retry suppression as terminal", async () => {
    await seedOutboxRow();
    const db = getDb();
    const now = Math.floor(Date.now() / 1000);
    // Make the stored send non-transactional so suppression applies.
    await db
      .update(outboxEmails)
      .set({ transactional: 0 })
      .where(eq(outboxEmails.id, "ob-1"));
    await db.insert(suppressions).values({
      id: "sup-1",
      email: "to@example.com",
      reason: "unsubscribed",
      createdAt: now,
    });
    const sender = fakeSender(OK);
    const outcome = await attemptOutboxRow(
      db,
      env as unknown as CloudflareBindings,
      sender,
      "ob-1",
    );
    expect(outcome).toBe("suppressed");
    expect(sender.calls).toHaveLength(0);
    expect(await db.select().from(outboxEmails)).toHaveLength(0);
    const sent = await db
      .select()
      .from(sentEmails)
      .where(eq(sentEmails.id, "se-1"));
    expect(sent[0].status).toBe("failed");
  });

  it("flips a failed sent email back to retrying on a transient re-attempt", async () => {
    await seedOutboxRow();
    const db = getDb();
    await db
      .update(sentEmails)
      .set({ status: "failed" })
      .where(eq(sentEmails.id, "se-1"));
    const outcome = await attemptOutboxRow(
      db,
      env as unknown as CloudflareBindings,
      fakeSender(TRANSIENT),
      "ob-1",
    );
    expect(outcome).toBe("retrying");
    const sent = await db
      .select()
      .from(sentEmails)
      .where(eq(sentEmails.id, "se-1"));
    expect(sent[0].status).toBe("retrying");
  });

  it("resolves the sequence step and completes the enrollment", async () => {
    const db = getDb();
    const now = Math.floor(Date.now() / 1000);
    await createTestPerson({ id: "p-1", email: "to@example.com" });
    await db.insert(sequences).values({
      id: "seq-1",
      name: "Test",
      steps: "[]",
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(sequenceEnrollments).values({
      id: "enr-1",
      sequenceId: "seq-1",
      personId: "p-1",
      status: "active",
      variables: "{}",
      fromAddress: "me@saasmail.test",
      enrolledAt: now,
    });
    await db.insert(sequenceEmails).values({
      id: "step-1",
      enrollmentId: "enr-1",
      stepOrder: 1,
      templateSlug: "welcome",
      scheduledAt: now - 100,
      status: "retrying",
    });
    await seedOutboxRow({ sequenceEmailId: "step-1" });

    const outcome = await attemptOutboxRow(
      db,
      env as unknown as CloudflareBindings,
      fakeSender(OK),
      "ob-1",
    );
    expect(outcome).toBe("sent");
    const step = await db
      .select()
      .from(sequenceEmails)
      .where(eq(sequenceEmails.id, "step-1"));
    expect(step[0].status).toBe("sent");
    expect(step[0].sentEmailId).toBe("se-1");
    const enr = await db
      .select()
      .from(sequenceEnrollments)
      .where(eq(sequenceEnrollments.id, "enr-1"));
    expect(enr[0].status).toBe("completed");
  });
});
