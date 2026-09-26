import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import {
  applyMigrations,
  cleanDb,
  createTestEmail,
  createTestPerson,
  createTestSentEmail,
  createTestUser,
  getDb,
} from "./helpers";
import { emails } from "../db/emails.schema";
import { sentEmails } from "../db/sent-emails.schema";
import { jmapChanges } from "../db/jmap-changes.schema";
import { mailboxes } from "../db/mailboxes.schema";
import { mailboxMessageState } from "../db/mailbox-message-state.schema";
import { messageMailboxes } from "../db/message-mailboxes.schema";
import { messageUserState } from "../db/message-user-state.schema";
import { inboxScopeSql } from "../lib/inbox-permissions";
import {
  pruneJmapChanges,
  pruneJmapChangesCandidatesSql,
} from "../jmap/changes";
import { currentJmapSeqQueries } from "../jmap/state";

describe("JMAP change log", () => {
  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDb();
  });

  it("logs canonical received and sent ids for create, update and delete", async () => {
    const db = getDb();
    await createTestPerson({
      id: "jmap-change-person",
      email: "person@example.com",
    });

    await createTestEmail({
      id: "jmap-change-received",
      personId: "jmap-change-person",
      recipient: "support@example.com",
      messageId: "jmap-change-received@example.com",
    });
    await db
      .update(emails)
      .set({ subject: "updated" })
      .where(eq(emails.id, "jmap-change-received"));
    await db.delete(emails).where(eq(emails.id, "jmap-change-received"));

    await createTestSentEmail({
      id: "jmap-change-sent",
      personId: null,
      fromAddress: "sales@example.com",
      toAddress: "person@example.com",
    });
    await db
      .update(sentEmails)
      .set({ subject: "updated" })
      .where(eq(sentEmails.id, "jmap-change-sent"));
    await db.delete(sentEmails).where(eq(sentEmails.id, "jmap-change-sent"));

    const rows = await db.select().from(jmapChanges).orderBy(jmapChanges.seq);
    expect(rows.map((row) => [row.objectId, row.inbox, row.op])).toEqual([
      ["received:jmap-change-received", "support@example.com", "c"],
      ["received:jmap-change-received", "support@example.com", "u"],
      ["received:jmap-change-received", "support@example.com", "d"],
      ["sent:jmap-change-sent", "sales@example.com", "c"],
      ["sent:jmap-change-sent", "sales@example.com", "u"],
      ["sent:jmap-change-sent", "sales@example.com", "d"],
    ]);
  });

  it("logs personal and shared state changes against the message inbox", async () => {
    const db = getDb();
    const { userId } = await createTestUser({ id: "jmap-state-user" });
    await createTestPerson({
      id: "jmap-state-person",
      email: "state@example.com",
    });
    await createTestEmail({
      id: "jmap-state-message",
      personId: "jmap-state-person",
      recipient: "state-inbox@example.com",
      messageId: "jmap-state-message@example.com",
    });
    await db.insert(mailboxes).values({
      id: "jmap-state-folder",
      inbox: "state-inbox@example.com",
      name: "Folder",
      role: null,
      parentId: null,
      sortOrder: 0,
      createdBy: userId,
      createdAt: 1,
      updatedAt: 1,
    });
    await db.delete(jmapChanges);

    await db.insert(messageUserState).values({
      userId,
      messageKind: "received",
      messageId: "jmap-state-message",
      seenAt: 1,
      starredAt: null,
      updatedAt: 1,
    });
    await db
      .update(messageUserState)
      .set({ starredAt: 2, updatedAt: 2 })
      .where(eq(messageUserState.messageId, "jmap-state-message"));
    await db
      .delete(messageUserState)
      .where(eq(messageUserState.messageId, "jmap-state-message"));

    await db.insert(mailboxMessageState).values({
      inbox: "state-inbox@example.com",
      messageKind: "received",
      messageId: "jmap-state-message",
      archivedAt: null,
      spamAt: null,
      trashedAt: null,
      updatedBy: userId,
      updatedAt: 1,
    });
    await db
      .update(mailboxMessageState)
      .set({ archivedAt: 2, updatedAt: 2 })
      .where(eq(mailboxMessageState.messageId, "jmap-state-message"));
    await db
      .delete(mailboxMessageState)
      .where(eq(mailboxMessageState.messageId, "jmap-state-message"));

    await db.insert(messageMailboxes).values({
      messageKind: "received",
      messageId: "jmap-state-message",
      mailboxId: "jmap-state-folder",
      addedBy: userId,
      addedAt: 1,
    });
    await db
      .update(messageMailboxes)
      .set({ addedAt: 2 })
      .where(eq(messageMailboxes.messageId, "jmap-state-message"));
    await db
      .delete(messageMailboxes)
      .where(eq(messageMailboxes.messageId, "jmap-state-message"));

    const rows = await db.select().from(jmapChanges).orderBy(jmapChanges.seq);
    expect(rows).toHaveLength(9);
    expect(
      rows.every((row) => row.objectId === "received:jmap-state-message"),
    ).toBe(true);
    expect(rows.every((row) => row.inbox === "state-inbox@example.com")).toBe(
      true,
    );
    expect(rows.every((row) => row.op === "u")).toBe(true);
    expect(rows.slice(0, 3).every((row) => row.userId === userId)).toBe(true);
    expect(rows.slice(3).every((row) => row.userId === null)).toBe(true);
  });

  it("logs mailbox lifecycle changes and stores scope-compatible inbox values", async () => {
    const db = getDb();
    await db.insert(mailboxes).values({
      id: "jmap-folder",
      inbox: "mine@example.com",
      name: "Folder",
      role: null,
      parentId: null,
      sortOrder: 0,
      createdBy: null,
      createdAt: 1,
      updatedAt: 1,
    });
    await db
      .update(mailboxes)
      .set({ name: "Renamed", updatedAt: 2 })
      .where(eq(mailboxes.id, "jmap-folder"));
    await db.delete(mailboxes).where(eq(mailboxes.id, "jmap-folder"));

    const scoped = await db.all<{ object_id: string; op: string }>(sql`
      SELECT jc.object_id, jc.op
      FROM jmap_changes jc
      WHERE 1 = 1
      ${inboxScopeSql(
        { isAdmin: false, inboxes: ["mine@example.com"] },
        sql`jc.inbox`,
      )}
      ORDER BY jc.seq
    `);
    expect(scoped).toEqual([
      { object_id: "mbx:jmap-folder", op: "c" },
      { object_id: "mbx:jmap-folder", op: "u" },
      { object_id: "mbx:jmap-folder", op: "d" },
    ]);
  });

  it("does not log state cleanup after the underlying message is gone", async () => {
    const db = getDb();
    const { userId } = await createTestUser({ id: "jmap-delete-user" });
    await createTestPerson({
      id: "jmap-delete-person",
      email: "delete@example.com",
    });
    await createTestEmail({
      id: "jmap-delete-message",
      personId: "jmap-delete-person",
      recipient: "delete-inbox@example.com",
      messageId: "jmap-delete-message@example.com",
    });
    await db.insert(messageUserState).values({
      userId,
      messageKind: "received",
      messageId: "jmap-delete-message",
      seenAt: 1,
      starredAt: null,
      updatedAt: 1,
    });
    await db.delete(jmapChanges);

    await db.delete(emails).where(eq(emails.id, "jmap-delete-message"));
    await db
      .delete(messageUserState)
      .where(eq(messageUserState.messageId, "jmap-delete-message"));

    const rows = await db.select().from(jmapChanges);
    expect(rows.map((row) => [row.objectId, row.op])).toEqual([
      ["received:jmap-delete-message", "d"],
    ]);
  });

  it("uses indexed state queries without scanning jmap_changes", async () => {
    const queries = currentJmapSeqQueries(
      {
        isAdmin: false,
        inboxes: Array.from(
          { length: 41 },
          (_, index) => `inbox-${index}@example.com`,
        ),
      },
      "plan-user",
    );
    expect(queries).toHaveLength(3);

    for (const query of queries) {
      const plan = await getDb().all<{ detail: string }>(
        sql`EXPLAIN QUERY PLAN ${query}`,
      );
      expect(
        plan.some((row) => /\bSCAN jmap_changes\b/i.test(row.detail)),
      ).toBe(false);
    }
  });

  it("uses the created_at index for prune candidates", async () => {
    const plan = await getDb().all<{ detail: string }>(
      sql`EXPLAIN QUERY PLAN ${pruneJmapChangesCandidatesSql(1_000_000)}`,
    );
    expect(
      plan.some((row) =>
        /USING (?:COVERING )?INDEX jmap_changes_created_at_idx/i.test(
          row.detail,
        ),
      ),
    ).toBe(true);
    expect(plan.some((row) => /\bSCAN jmap_changes\b/i.test(row.detail))).toBe(
      false,
    );
  });

  it("prunes only changes older than thirty days", async () => {
    const db = getDb();
    const now = 4_000_000;
    await db.insert(jmapChanges).values([
      {
        objectType: "email",
        objectId: "received:old",
        inbox: "mine@example.com",
        userId: null,
        op: "u",
        createdAt: now - 30 * 24 * 60 * 60 - 1,
      },
      {
        objectType: "email",
        objectId: "received:new",
        inbox: "mine@example.com",
        userId: null,
        op: "u",
        createdAt: now - 30 * 24 * 60 * 60,
      },
    ]);

    await pruneJmapChanges(db, now);

    const rows = await db
      .select({ objectId: jmapChanges.objectId })
      .from(jmapChanges);
    expect(rows).toEqual([{ objectId: "received:new" }]);
  });
});
