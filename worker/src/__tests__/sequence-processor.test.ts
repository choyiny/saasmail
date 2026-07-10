import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { env } from "cloudflare:workers";
import {
  applyMigrations,
  cleanDb,
  createTestUser,
  createTestPerson,
  createTestTemplate,
  getDb,
} from "./helpers";
import { sequences } from "../db/sequences.schema";
import { sequenceEnrollments } from "../db/sequence-enrollments.schema";
import { sequenceEmails } from "../db/sequence-emails.schema";
import { sentEmails } from "../db/sent-emails.schema";
import { suppressions } from "../db/suppressions.schema";
import { outboxEmails } from "../db/outbox-emails.schema";
import { eq } from "drizzle-orm";
import {
  handleScheduled,
  processSequenceEmail,
} from "../lib/sequence-processor";
import type { EmailSender, SendEmailParams } from "../lib/email-sender";

describe("sequence processor - handleScheduled", () => {
  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDb();
    await createTestUser();
  });

  it("queues due pending emails and pushes to queue", async () => {
    const db = getDb();
    const now = Math.floor(Date.now() / 1000);

    await createTestPerson({ id: "s1", email: "a@test.com" });
    await createTestTemplate({ slug: "welcome" });

    await db.insert(sequences).values({
      id: "seq-1",
      name: "Test",
      steps: JSON.stringify([
        { order: 1, templateSlug: "welcome", delayHours: 0 },
      ]),
      createdAt: now,
      updatedAt: now,
    });

    await db.insert(sequenceEnrollments).values({
      id: "enr-1",
      sequenceId: "seq-1",
      personId: "s1",
      status: "active",
      variables: "{}",
      fromAddress: "test@test.com",
      enrolledAt: now,
    });

    // Due email (scheduledAt in the past)
    await db.insert(sequenceEmails).values({
      id: "se-1",
      enrollmentId: "enr-1",
      stepOrder: 1,
      templateSlug: "welcome",
      scheduledAt: now - 100,
      status: "pending",
    });

    await handleScheduled(env as unknown as CloudflareBindings);

    // Verify status changed to queued
    const emailRow = await db
      .select()
      .from(sequenceEmails)
      .where(eq(sequenceEmails.id, "se-1"))
      .limit(1);
    expect(emailRow[0].status).toBe("queued");
  });

  it("does not queue future pending emails", async () => {
    const db = getDb();
    const now = Math.floor(Date.now() / 1000);

    await createTestPerson({ id: "s1", email: "a@test.com" });
    await createTestTemplate({ slug: "welcome" });

    await db.insert(sequences).values({
      id: "seq-1",
      name: "Test",
      steps: JSON.stringify([
        { order: 1, templateSlug: "welcome", delayHours: 0 },
      ]),
      createdAt: now,
      updatedAt: now,
    });

    await db.insert(sequenceEnrollments).values({
      id: "enr-1",
      sequenceId: "seq-1",
      personId: "s1",
      status: "active",
      variables: "{}",
      fromAddress: "test@test.com",
      enrolledAt: now,
    });

    // Future email
    await db.insert(sequenceEmails).values({
      id: "se-1",
      enrollmentId: "enr-1",
      stepOrder: 1,
      templateSlug: "welcome",
      scheduledAt: now + 99999,
      status: "pending",
    });

    await handleScheduled(env as unknown as CloudflareBindings);

    const emailRow = await db
      .select()
      .from(sequenceEmails)
      .where(eq(sequenceEmails.id, "se-1"))
      .limit(1);
    expect(emailRow[0].status).toBe("pending");
  });

  it("does nothing when no pending emails", async () => {
    // Should not throw
    await handleScheduled(env as unknown as CloudflareBindings);
  });
});

describe("sequence processor - processSequenceEmail suppression", () => {
  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDb();
    await createTestUser();
  });

  it(
    "marks the row as suppressed without calling the transport when " +
      "the recipient is on the suppression list",
    async () => {
      const db = getDb();
      const now = Math.floor(Date.now() / 1000);

      await createTestPerson({ id: "p1", email: "suppressed@test.com" });
      await createTestTemplate({ slug: "welcome" });

      // Suppress the recipient
      await db.insert(suppressions).values({
        id: "sup-1",
        email: "suppressed@test.com",
        reason: "unsubscribe",
        source: "test",
        note: null,
        createdAt: now,
      });

      await db.insert(sequences).values({
        id: "seq-1",
        name: "Test",
        steps: JSON.stringify([
          { order: 1, templateSlug: "welcome", delayHours: 0 },
        ]),
        createdAt: now,
        updatedAt: now,
      });

      await db.insert(sequenceEnrollments).values({
        id: "enr-1",
        sequenceId: "seq-1",
        personId: "p1",
        status: "active",
        variables: "{}",
        fromAddress: "test@test.com",
        enrolledAt: now,
      });

      await db.insert(sequenceEmails).values({
        id: "se-1",
        enrollmentId: "enr-1",
        stepOrder: 1,
        templateSlug: "welcome",
        scheduledAt: now - 100,
        status: "queued",
      });

      const fakeSender: EmailSender = {
        provider: "none",
        maxAttachmentBytes: () => 25_000_000,
        send: vi.fn(async (_params: SendEmailParams) => ({
          id: "should-not-be-called",
          error: null,
        })),
      };

      await processSequenceEmail(
        db,
        fakeSender,
        env as unknown as CloudflareBindings,
        "se-1",
      );

      // Transport must NOT have been called
      expect(fakeSender.send).not.toHaveBeenCalled();

      // sequence_emails row should be in `suppressed` state. sentAt is
      // intentionally NOT written — the transport was never called.
      const row = await db
        .select()
        .from(sequenceEmails)
        .where(eq(sequenceEmails.id, "se-1"))
        .limit(1);
      expect(row[0].status).toBe("suppressed");
      expect(row[0].sentAt).toBeNull();

      // No sent_emails row should have been written
      const sentRows = await db.select().from(sentEmails);
      expect(sentRows).toHaveLength(0);

      // Enrollment should be completed (no remaining steps)
      const enrollmentRow = await db
        .select()
        .from(sequenceEnrollments)
        .where(eq(sequenceEnrollments.id, "enr-1"))
        .limit(1);
      expect(enrollmentRow[0].status).toBe("completed");
    },
  );

  it("still sends to non-suppressed recipients via the helper", async () => {
    const db = getDb();
    const now = Math.floor(Date.now() / 1000);

    await createTestPerson({ id: "p1", email: "ok@test.com" });
    await createTestTemplate({ slug: "welcome" });

    await db.insert(sequences).values({
      id: "seq-1",
      name: "Test",
      steps: JSON.stringify([
        { order: 1, templateSlug: "welcome", delayHours: 0 },
      ]),
      createdAt: now,
      updatedAt: now,
    });

    await db.insert(sequenceEnrollments).values({
      id: "enr-1",
      sequenceId: "seq-1",
      personId: "p1",
      status: "active",
      variables: "{}",
      fromAddress: "test@test.com",
      enrolledAt: now,
    });

    await db.insert(sequenceEmails).values({
      id: "se-1",
      enrollmentId: "enr-1",
      stepOrder: 1,
      templateSlug: "welcome",
      scheduledAt: now - 100,
      status: "queued",
    });

    const fakeSender: EmailSender = {
      provider: "none",
      maxAttachmentBytes: () => 25_000_000,
      send: vi.fn(async (_params: SendEmailParams) => ({
        id: "fake-resend-id",
        error: null,
      })),
    };

    await processSequenceEmail(
      db,
      fakeSender,
      env as unknown as CloudflareBindings,
      "se-1",
    );

    expect(fakeSender.send).toHaveBeenCalledTimes(1);

    const row = await db
      .select()
      .from(sequenceEmails)
      .where(eq(sequenceEmails.id, "se-1"))
      .limit(1);
    expect(row[0].status).toBe("sent");
    expect(row[0].sentEmailId).not.toBeNull();

    const sentRows = await db.select().from(sentEmails);
    expect(sentRows).toHaveLength(1);
    expect(sentRows[0].toAddress).toBe("ok@test.com");
  });
});

describe("sequence processor - processSequenceEmail outbox", () => {
  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDb();
    await createTestUser();
  });

  it("hands a transient provider failure to the outbox", async () => {
    const db = getDb();
    const now = Math.floor(Date.now() / 1000);
    await createTestPerson({ id: "p1", email: "a@test.com" });
    await createTestTemplate({ slug: "welcome" });
    await db.insert(sequences).values({
      id: "seq-1",
      name: "Test",
      steps: JSON.stringify([
        { order: 1, templateSlug: "welcome", delayHours: 0 },
      ]),
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(sequenceEnrollments).values({
      id: "enr-1",
      sequenceId: "seq-1",
      personId: "p1",
      status: "active",
      variables: "{}",
      fromAddress: "me@saasmail.test",
      enrolledAt: now,
    });
    await db.insert(sequenceEmails).values({
      id: "se-1",
      enrollmentId: "enr-1",
      stepOrder: 1,
      templateSlug: "welcome",
      scheduledAt: now - 100,
      status: "queued",
    });

    const transientSender: EmailSender = {
      provider: "none",
      async send(_p: SendEmailParams) {
        return {
          id: null,
          error: { message: "quota exceeded", transient: true },
        };
      },
      maxAttachmentBytes: () => 25 * 1024 * 1024,
    };

    // Must resolve without throwing — the queue consumer ACKs on return.
    await processSequenceEmail(
      db,
      transientSender,
      env as unknown as CloudflareBindings,
      "se-1",
    );

    const step = await db
      .select()
      .from(sequenceEmails)
      .where(eq(sequenceEmails.id, "se-1"));
    expect(step[0].status).toBe("retrying");

    const sent = await db.select().from(sentEmails);
    expect(sent).toHaveLength(1);
    expect(sent[0].status).toBe("retrying");

    const outbox = await db.select().from(outboxEmails);
    expect(outbox).toHaveLength(1);
    expect(outbox[0].status).toBe("pending");
    expect(outbox[0].sequenceEmailId).toBe("se-1");
    expect(outbox[0].sentEmailId).toBe(sent[0].id);

    // Enrollment must NOT complete while a step is retrying.
    const enr = await db
      .select()
      .from(sequenceEnrollments)
      .where(eq(sequenceEnrollments.id, "enr-1"));
    expect(enr[0].status).toBe("active");
  });

  it("completes the enrollment when the inline send permanently fails", async () => {
    const db = getDb();
    const now = Math.floor(Date.now() / 1000);
    await createTestPerson({ id: "p2", email: "perm@test.com" });
    await createTestTemplate({ slug: "welcome" });
    await db.insert(sequences).values({
      id: "seq-perm",
      name: "Test",
      steps: JSON.stringify([
        { order: 1, templateSlug: "welcome", delayHours: 0 },
      ]),
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(sequenceEnrollments).values({
      id: "enr-perm",
      sequenceId: "seq-perm",
      personId: "p2",
      status: "active",
      variables: "{}",
      fromAddress: "me@saasmail.test",
      enrolledAt: now,
    });
    await db.insert(sequenceEmails).values({
      id: "se-perm",
      enrollmentId: "enr-perm",
      stepOrder: 1,
      templateSlug: "welcome",
      scheduledAt: now - 100,
      status: "queued",
    });

    const permanentSender: EmailSender = {
      provider: "none",
      async send(_p: SendEmailParams) {
        return {
          id: null,
          error: { message: "invalid recipient", transient: false },
        };
      },
      maxAttachmentBytes: () => 25 * 1024 * 1024,
    };

    await processSequenceEmail(
      db,
      permanentSender,
      env as unknown as CloudflareBindings,
      "se-perm",
    );

    const step = await db
      .select()
      .from(sequenceEmails)
      .where(eq(sequenceEmails.id, "se-perm"));
    expect(step[0].status).toBe("failed");

    const sent = await db.select().from(sentEmails);
    expect(sent).toHaveLength(1);
    expect(sent[0].status).toBe("failed");

    const enr = await db
      .select()
      .from(sequenceEnrollments)
      .where(eq(sequenceEnrollments.id, "enr-perm"));
    expect(enr[0].status).toBe("completed");
  });
});

describe("sequence processor - crash-redelivery idempotency", () => {
  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDb();
    await createTestUser();
  });

  it("repairs a crashed delivery by reusing the existing outbox row without calling the sender", async () => {
    const db = getDb();
    const now = Math.floor(Date.now() / 1000);

    await createTestPerson({ id: "p1", email: "a@test.com" });
    await createTestTemplate({ slug: "welcome" });

    await db.insert(sequences).values({
      id: "seq-1",
      name: "Test",
      steps: JSON.stringify([
        { order: 1, templateSlug: "welcome", delayHours: 0 },
      ]),
      createdAt: now,
      updatedAt: now,
    });

    await db.insert(sequenceEnrollments).values({
      id: "enr-1",
      sequenceId: "seq-1",
      personId: "p1",
      status: "active",
      variables: "{}",
      fromAddress: "me@saasmail.test",
      enrolledAt: now,
    });

    await db.insert(sequenceEmails).values({
      id: "se-1",
      enrollmentId: "enr-1",
      stepOrder: 1,
      templateSlug: "welcome",
      scheduledAt: now - 100,
      status: "queued",
    });

    // Seed an existing outbox row as if the first delivery inserted it but
    // crashed before completing the sentEmails insert and step update.
    await db.insert(outboxEmails).values({
      id: "ob-repair-1",
      sentEmailId: "sent-repair-1",
      sequenceEmailId: "se-1",
      fromAddress: "me@saasmail.test",
      toAddress: "a@test.com",
      subject: "Hello",
      bodyHtml: "<p>Hello</p>",
      status: "pending",
      attempts: 1,
      nextRetryAt: now,
      headers: JSON.stringify({ "Message-ID": "<mid-repair@saasmail.test>" }),
      transactional: 0,
      createdAt: now,
      updatedAt: now,
    });

    const throwingSender: EmailSender = {
      provider: "none",
      async send(_p: SendEmailParams) {
        throw new Error("should not be called");
      },
      maxAttachmentBytes: () => 25 * 1024 * 1024,
    };

    // Must not throw — the redelivery guard intercepts and repairs.
    await processSequenceEmail(
      db,
      throwingSender,
      env as unknown as CloudflareBindings,
      "se-1",
    );

    // Step should be flipped to retrying
    const step = await db
      .select()
      .from(sequenceEmails)
      .where(eq(sequenceEmails.id, "se-1"));
    expect(step[0].status).toBe("retrying");

    // sentEmails row should exist with the outbox row's sentEmailId
    const sent = await db
      .select()
      .from(sentEmails)
      .where(eq(sentEmails.id, "sent-repair-1"));
    expect(sent).toHaveLength(1);
    expect(sent[0].status).toBe("retrying");

    // Outbox row should still exist (owned by the outbox processor)
    const outbox = await db.select().from(outboxEmails);
    expect(outbox).toHaveLength(1);
  });
});
