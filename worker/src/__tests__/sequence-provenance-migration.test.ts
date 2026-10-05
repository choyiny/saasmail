import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import migrationSql from "../../../migrations/0039_backfill_sequence_provenance.sql?raw";
import { applyMigrations, cleanDb, getDb } from "./helpers";
import { sequences } from "../db/sequences.schema";
import { sequenceEnrollments } from "../db/sequence-enrollments.schema";
import { sequenceEmails } from "../db/sequence-emails.schema";
import { sentEmails } from "../db/sent-emails.schema";
import { outboxEmails } from "../db/outbox-emails.schema";

async function runBackfillMigration() {
  const statements = migrationSql
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter(Boolean);

  for (const statement of statements) {
    const executable = statement
      .split("\n")
      .filter((line) => !line.trim().startsWith("--"))
      .join("\n")
      .trim();
    if (executable) {
      await env.DB.prepare(executable).run();
    }
  }
}

describe("0039 sequence provenance backfill", () => {
  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDb();
  });

  it("backfills durable links, uses surviving outbox links, and leaves unlinked history null", async () => {
    const db = getDb();

    await db.insert(sequences).values([
      {
        id: "seq-linked",
        name: "Linked",
        steps: "[]",
        createdAt: 1,
        updatedAt: 1,
      },
      {
        id: "seq-outbox",
        name: "Outbox",
        steps: "[]",
        createdAt: 1,
        updatedAt: 1,
      },
      {
        id: "seq-unlinked",
        name: "Unlinked",
        steps: "[]",
        createdAt: 1,
        updatedAt: 1,
      },
    ]);

    await db.insert(sequenceEnrollments).values([
      {
        id: "enr-linked",
        sequenceId: "seq-linked",
        personId: "person-linked",
        status: "completed",
        variables: "{}",
        fromAddress: "sales@saasmail.test",
        enrolledAt: 1,
      },
      {
        id: "enr-outbox",
        sequenceId: "seq-outbox",
        personId: "person-outbox",
        status: "active",
        variables: "{}",
        fromAddress: "sales@saasmail.test",
        enrolledAt: 1,
      },
      {
        id: "enr-unlinked",
        sequenceId: "seq-unlinked",
        personId: "person-unlinked",
        status: "completed",
        variables: "{}",
        fromAddress: "sales@saasmail.test",
        enrolledAt: 1,
      },
    ]);

    await db.insert(sentEmails).values([
      {
        id: "sent-linked",
        fromAddress: "sales@saasmail.test",
        toAddress: "linked@example.com",
        subject: "Linked",
        status: "sent",
        sentAt: 100,
        createdAt: 100,
      },
      {
        id: "sent-outbox",
        fromAddress: "sales@saasmail.test",
        toAddress: "outbox@example.com",
        subject: "Outbox",
        status: "retrying",
        sentAt: 200,
        createdAt: 200,
      },
      {
        id: "sent-unlinked",
        fromAddress: "sales@saasmail.test",
        toAddress: "unlinked@example.com",
        subject: "Unlinked",
        status: "failed",
        sentAt: 300,
        createdAt: 300,
      },
    ]);

    await db.insert(sequenceEmails).values([
      {
        id: "step-linked",
        enrollmentId: "enr-linked",
        stepOrder: 0,
        templateSlug: "linked",
        scheduledAt: 1,
        status: "sent",
        sentAt: 100,
        sentEmailId: "sent-linked",
      },
      {
        id: "step-outbox",
        enrollmentId: "enr-outbox",
        stepOrder: 0,
        templateSlug: "outbox",
        scheduledAt: 1,
        status: "retrying",
      },
      {
        id: "step-unlinked",
        enrollmentId: "enr-unlinked",
        stepOrder: 0,
        templateSlug: "unlinked",
        scheduledAt: 1,
        status: "failed",
      },
    ]);

    await db.insert(outboxEmails).values({
      id: "outbox-history",
      sentEmailId: "sent-outbox",
      sequenceEmailId: "step-outbox",
      fromAddress: "sales@saasmail.test",
      toAddress: "outbox@example.com",
      subject: "Outbox",
      status: "pending",
      attempts: 1,
      nextRetryAt: 400,
      createdAt: 200,
      updatedAt: 200,
    });

    await runBackfillMigration();
    await runBackfillMigration();

    const [linked] = await db
      .select()
      .from(sentEmails)
      .where(eq(sentEmails.id, "sent-linked"));
    expect(linked.sequenceId).toBe("seq-linked");
    expect(linked.sequenceEnrollmentId).toBe("enr-linked");

    const [outboxLinked] = await db
      .select()
      .from(sentEmails)
      .where(eq(sentEmails.id, "sent-outbox"));
    expect(outboxLinked.sequenceId).toBe("seq-outbox");
    expect(outboxLinked.sequenceEnrollmentId).toBe("enr-outbox");

    const [unlinked] = await db
      .select()
      .from(sentEmails)
      .where(eq(sentEmails.id, "sent-unlinked"));
    expect(unlinked.sequenceId).toBeNull();
    expect(unlinked.sequenceEnrollmentId).toBeNull();
  });
});
