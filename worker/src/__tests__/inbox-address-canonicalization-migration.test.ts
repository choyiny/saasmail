import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import migrationSql from "../../../migrations/0037_canonicalize_inbox_addresses.sql?raw";
import {
  applyMigrations,
  cleanDb,
  createTestPerson,
  createTestUser,
  getDb,
} from "./helpers";
import { emails } from "../db/emails.schema";
import { inboxPermissions } from "../db/inbox-permissions.schema";
import { senderIdentities } from "../db/sender-identities.schema";
import { sentEmails } from "../db/sent-emails.schema";

async function runCanonicalizationMigration() {
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

describe("0037 canonicalize inbox addresses migration", () => {
  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDb();
  });

  it("resolves casing collisions, canonicalizes message inboxes, and is idempotent", async () => {
    const db = getDb();
    await createTestUser({
      id: "migration-user",
      role: "member",
      email: "migration-user@example.com",
    });
    await createTestPerson({
      id: "migration-person",
      email: "sender@example.com",
    });

    await db.insert(inboxPermissions).values([
      {
        userId: "migration-user",
        email: "Support@X.COM",
        createdAt: 100,
        createdBy: null,
      },
      {
        userId: "migration-user",
        email: "support@x.com",
        createdAt: 200,
        createdBy: null,
      },
    ]);

    await db.insert(senderIdentities).values([
      {
        email: "Support@X.COM",
        displayName: "Older",
        displayMode: "chat",
        createdAt: 100,
        updatedAt: 100,
      },
      {
        email: "support@x.com",
        displayName: "Newer",
        displayMode: "thread",
        createdAt: 200,
        updatedAt: 200,
      },
    ]);

    await db.insert(emails).values({
      id: "migration-received",
      personId: "migration-person",
      recipient: " Support@X.COM ",
      subject: "Received",
      bodyText: "Received",
      rawHeaders: "{}",
      messageId: "migration-received@example.com",
      isRead: 0,
      receivedAt: 300,
      createdAt: 300,
    });

    await db.insert(sentEmails).values({
      id: "migration-sent",
      personId: "migration-person",
      fromAddress: " Support@X.COM ",
      toAddress: "recipient@example.com",
      subject: "Sent",
      bodyText: "Sent",
      status: "sent",
      sentAt: 400,
      createdAt: 400,
    });

    await runCanonicalizationMigration();
    await runCanonicalizationMigration();

    const permissions = await db
      .select()
      .from(inboxPermissions)
      .where(eq(inboxPermissions.userId, "migration-user"));
    expect(permissions).toHaveLength(1);
    expect(permissions[0].email).toBe("support@x.com");

    const identities = await db.select().from(senderIdentities);
    expect(identities).toHaveLength(1);
    expect(identities[0]).toMatchObject({
      email: "support@x.com",
      displayName: "Newer",
      displayMode: "thread",
      updatedAt: 200,
    });

    const [received] = await db
      .select()
      .from(emails)
      .where(eq(emails.id, "migration-received"));
    expect(received.recipient).toBe("support@x.com");

    const [sent] = await db
      .select()
      .from(sentEmails)
      .where(eq(sentEmails.id, "migration-sent"));
    expect(sent.fromAddress).toBe("support@x.com");
  });
});
