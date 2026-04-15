import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import {
  applyMigrations,
  cleanDb,
  createTestUser,
  createTestSender,
  createTestTemplate,
  getDb,
  authFetch,
} from "./helpers";
import { sequenceEnrollments } from "../db/sequence-enrollments.schema";
import { sequenceEmails } from "../db/sequence-emails.schema";
import { eq } from "drizzle-orm";
import { cancelSequencesForSender } from "../lib/cancel-sequence";

describe("cancelSequencesForSender", () => {
  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDb();
    await createTestUser();
  });

  it("cancels active enrollments and pending/queued emails", async () => {
    const db = getDb();
    await createTestSender({ id: "s1", email: "a@test.com" });
    await createTestTemplate({ slug: "welcome" });

    // Create a sequence and enrollment directly
    const now = Math.floor(Date.now() / 1000);

    await db.insert((await import("../db/sequences.schema")).sequences).values({
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
      senderId: "s1",
      status: "active",
      variables: "{}",
      enrolledAt: now,
    });

    await db.insert(sequenceEmails).values([
      {
        id: "se-1",
        enrollmentId: "enr-1",
        stepOrder: 1,
        templateSlug: "welcome",
        scheduledAt: now + 3600,
        status: "pending",
      },
      {
        id: "se-2",
        enrollmentId: "enr-1",
        stepOrder: 2,
        templateSlug: "welcome",
        scheduledAt: now + 7200,
        status: "queued",
      },
    ]);

    await cancelSequencesForSender(db, "s1");

    const enrollment = await db
      .select()
      .from(sequenceEnrollments)
      .where(eq(sequenceEnrollments.id, "enr-1"))
      .limit(1);
    expect(enrollment[0].status).toBe("cancelled");
    expect(enrollment[0].cancelledAt).toBeDefined();

    const emailRows = await db
      .select()
      .from(sequenceEmails)
      .where(eq(sequenceEmails.enrollmentId, "enr-1"));
    for (const row of emailRows) {
      expect(row.status).toBe("cancelled");
    }
  });

  it("does nothing when no active enrollments", async () => {
    const db = getDb();
    await cancelSequencesForSender(db, "nonexistent-sender");
    // No error thrown
  });

  it("does not cancel already-sent emails", async () => {
    const db = getDb();
    await createTestSender({ id: "s1", email: "a@test.com" });
    await createTestTemplate({ slug: "welcome" });
    const now = Math.floor(Date.now() / 1000);

    await db.insert((await import("../db/sequences.schema")).sequences).values({
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
      senderId: "s1",
      status: "active",
      variables: "{}",
      enrolledAt: now,
    });

    await db.insert(sequenceEmails).values({
      id: "se-1",
      enrollmentId: "enr-1",
      stepOrder: 1,
      templateSlug: "welcome",
      scheduledAt: now - 3600,
      status: "sent",
      sentAt: now - 1800,
    });

    await cancelSequencesForSender(db, "s1");

    const emailRow = await db
      .select()
      .from(sequenceEmails)
      .where(eq(sequenceEmails.id, "se-1"))
      .limit(1);
    expect(emailRow[0].status).toBe("sent");
  });
});
