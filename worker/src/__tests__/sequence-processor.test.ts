import { describe, it, expect, beforeAll, beforeEach } from "vitest";
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
import { eq } from "drizzle-orm";
import { handleScheduled } from "../lib/sequence-processor";

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
