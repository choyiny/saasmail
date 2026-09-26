import { describe, expect, it, beforeAll, beforeEach } from "vitest";
import { eq, sql } from "drizzle-orm";
import { applyMigrations, cleanDb, createTestPerson, getDb } from "./helpers";
import { attachments } from "../db/attachments.schema";
import { blocklist } from "../db/blocklist.schema";
import { emails } from "../db/emails.schema";
import { sentEmails } from "../db/sent-emails.schema";
import { campaignRecipients } from "../db/campaign-recipients.schema";
import { outboxEmails } from "../db/outbox-emails.schema";
import { sequenceEmails } from "../db/sequence-emails.schema";
import { InvalidCursorError } from "../lib/messages/cursor";
import { buildMessageQuerySql, queryMessages } from "../lib/messages/query";

describe("queryMessages", () => {
  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDb();
  });

  async function seedPair() {
    const db = getDb();
    await createTestPerson({
      id: "person-1",
      email: "alice@example.com",
      name: "Alice",
    });

    await db.insert(emails).values({
      id: "recv-1",
      personId: "person-1",
      recipient: "support@saasmail.test",
      subject: "Invoice received",
      bodyHtml: "<p>secret inbound body</p>",
      bodyText: "secret inbound body",
      rawHeaders: "{}",
      messageId: "recv-1@example.com",
      isRead: 0,
      conversationId: "conv-1",
      receivedAt: 300,
      createdAt: 300,
    });

    await db.insert(sentEmails).values({
      id: "sent-1",
      personId: "person-1",
      fromAddress: "support@saasmail.test",
      toAddress: "alice@example.com",
      subject: "Invoice sent",
      bodyHtml: "<p>secret outbound body</p>",
      bodyText: "secret outbound body",
      messageId: "sent-1@example.com",
      status: "sent",
      conversationId: "conv-1",
      campaignId: "campaign-1",
      sentAt: 200,
      createdAt: 200,
    });
  }

  it("rejects messageRefs above the per-statement binding cap", async () => {
    await expect(
      queryMessages(
        getDb(),
        { isAdmin: true },
        {
          messageRefs: Array.from({ length: 41 }, (_, index) => ({
            kind: "received" as const,
            id: `recv-${index}`,
          })),
        },
      ),
    ).rejects.toThrow("messageRefs is limited to 40");
  });

  it("rejects threadKeys above the per-statement binding cap", async () => {
    await expect(
      queryMessages(
        getDb(),
        { isAdmin: true },
        {
          threadKeys: Array.from(
            { length: 21 },
            (_, index) => `thread-${index}`,
          ),
        },
      ),
    ).rejects.toThrow("threadKeys is limited to 20");
  });

  it("merges both directions and scopes canonical inbox addresses correctly", async () => {
    await seedPair();

    const page = await queryMessages(
      getDb(),
      { isAdmin: false, inboxes: ["support@saasmail.test"] },
      { limit: 10 },
    );

    expect(page.messages.map((message) => message.ref)).toEqual([
      { kind: "received", id: "recv-1" },
      { kind: "sent", id: "sent-1" },
    ]);
    expect(page.messages[0].from).toEqual({
      email: "alice@example.com",
      name: "Alice",
    });
    expect(page.messages[1].to.name).toBe("Alice");
  });

  it("uses inbox/timestamp indexes for the real inbox-scoped query", async () => {
    const db = getDb();
    const built = buildMessageQuerySql(
      { isAdmin: false, inboxes: ["support@saasmail.test"] },
      { inboxes: ["support@saasmail.test"], limit: 10 },
    );
    expect(built).not.toBeNull();

    const plan = await db.all<{ detail: string }>(
      sql`EXPLAIN QUERY PLAN ${built!.statement}`,
    );
    const details = plan.map((row) => row.detail).join("\n");

    expect(details).toContain("emails_recipient_received_idx");
    expect(details).toContain("sent_emails_from_sent_idx");
    expect(details).not.toMatch(/\bSCAN emails\b/i);
    expect(details).not.toMatch(/\bSCAN sent_emails\b/i);
  });

  it("silently excludes explicitly unauthorized inboxes", async () => {
    await seedPair();

    const page = await queryMessages(
      getDb(),
      { isAdmin: false, inboxes: ["support@saasmail.test"] },
      { inboxes: ["billing@saasmail.test"] },
    );

    expect(page.messages).toEqual([]);
  });

  it("keeps subject-only and full-text search semantics distinct", async () => {
    await seedPair();
    const db = getDb();

    const subjectOnly = await queryMessages(
      db,
      { isAdmin: true },
      { search: "secret", searchMode: "subject" },
    );
    expect(subjectOnly.messages).toEqual([]);

    const fulltext = await queryMessages(
      db,
      { isAdmin: true },
      { search: "secret", searchMode: "fulltext" },
    );
    expect(fulltext.messages.map((message) => message.ref.id)).toEqual([
      "recv-1",
      "sent-1",
    ]);
  });

  it("makes blocklist filtering opt-in", async () => {
    await seedPair();
    const db = getDb();
    await db.insert(blocklist).values({
      id: "block-1",
      type: "email",
      value: "alice@example.com",
      note: null,
      createdBy: null,
      createdAt: 1,
    });

    const ordinary = await queryMessages(db, { isAdmin: true }, {});
    expect(ordinary.messages).toHaveLength(2);

    const filtered = await queryMessages(
      db,
      { isAdmin: true },
      { excludeBlocked: true },
    );
    expect(filtered.messages).toEqual([]);
  });

  it("enriches attachment counts and arrays for both message kinds", async () => {
    await seedPair();
    const db = getDb();
    await db.insert(attachments).values([
      {
        id: "att-in",
        emailId: "recv-1",
        kind: "inbound",
        filename: "in.txt",
        contentType: "text/plain",
        size: 1,
        r2Key: "in",
        contentId: null,
        createdAt: 1,
      },
      {
        id: "att-out",
        emailId: "sent-1",
        kind: "sent",
        filename: "out.txt",
        contentType: "text/plain",
        size: 1,
        r2Key: "out",
        contentId: null,
        createdAt: 1,
      },
    ]);

    const page = await queryMessages(
      db,
      { isAdmin: true },
      {
        withAttachmentCounts: true,
        withAttachments: true,
      },
    );

    expect(page.messages[0].attachmentCount).toBe(1);
    expect(page.messages[0].attachments?.[0].id).toBe("att-in");
    expect(page.messages[1].attachmentCount).toBe(1);
    expect(page.messages[1].attachments?.[0].id).toBe("att-out");
  });

  it("keeps nullable-person campaign sends in inbox scope but not person scope", async () => {
    const db = getDb();
    await db.insert(sentEmails).values({
      id: "campaign-send",
      personId: null,
      fromAddress: "marketing@saasmail.test",
      toAddress: "subscriber@example.com",
      subject: "Newsletter",
      bodyHtml: "<p>Hello</p>",
      bodyText: "Hello",
      status: "sent",
      campaignId: "campaign-1",
      sentAt: 100,
      createdAt: 100,
    });

    const inboxPage = await queryMessages(
      db,
      { isAdmin: true },
      { inboxes: ["marketing@saasmail.test"] },
    );
    expect(inboxPage.messages.map((message) => message.ref.id)).toEqual([
      "campaign-send",
    ]);

    const personPage = await queryMessages(
      db,
      { isAdmin: true },
      { personId: "missing-person" },
    );
    expect(personPage.messages).toEqual([]);
  });

  it("orders equal-second messages by id then kind", async () => {
    const db = getDb();
    await createTestPerson({ id: "tie-person" });
    await db.insert(emails).values({
      id: "same-id",
      personId: "tie-person",
      recipient: "inbox@saasmail.test",
      subject: "Received",
      bodyText: "Received",
      rawHeaders: "{}",
      messageId: "tie-received@example.com",
      isRead: 0,
      receivedAt: 100,
      createdAt: 100,
    });
    await db.insert(sentEmails).values([
      {
        id: "z-id",
        personId: "tie-person",
        fromAddress: "inbox@saasmail.test",
        toAddress: "alice@example.com",
        subject: "Z",
        status: "sent",
        sentAt: 100,
        createdAt: 100,
      },
      {
        id: "same-id",
        personId: "tie-person",
        fromAddress: "inbox@saasmail.test",
        toAddress: "alice@example.com",
        subject: "Same",
        status: "sent",
        sentAt: 100,
        createdAt: 100,
      },
    ]);

    const page = await queryMessages(db, { isAdmin: true }, {});
    expect(page.messages.map((message) => message.ref)).toEqual([
      { kind: "sent", id: "z-id" },
      { kind: "received", id: "same-id" },
      { kind: "sent", id: "same-id" },
    ]);

    const [sent] = await db
      .select()
      .from(sentEmails)
      .where(eq(sentEmails.id, "same-id"));
    expect(sent.id).toBe("same-id");
  });
  it("paginates with an opaque cursor without duplicates or gaps", async () => {
    const db = getDb();
    await createTestPerson({ id: "cursor-person" });

    for (const [id, timestamp] of [
      ["a", 400],
      ["b", 300],
      ["c", 200],
      ["d", 100],
    ] as const) {
      await db.insert(emails).values({
        id,
        personId: "cursor-person",
        recipient: "inbox@saasmail.test",
        subject: id,
        bodyText: id,
        rawHeaders: "{}",
        messageId: `${id}@example.com`,
        isRead: 0,
        receivedAt: timestamp,
        createdAt: timestamp,
      });
    }

    const first = await queryMessages(db, { isAdmin: true }, { limit: 2 });
    expect(first.messages.map((message) => message.ref.id)).toEqual(["a", "b"]);
    expect(first.hasMore).toBe(true);
    expect(first.nextCursor).not.toBeNull();

    await db.insert(emails).values({
      id: "newer",
      personId: "cursor-person",
      recipient: "inbox@saasmail.test",
      subject: "newer",
      bodyText: "newer",
      rawHeaders: "{}",
      messageId: "newer@example.com",
      isRead: 0,
      receivedAt: 500,
      createdAt: 500,
    });

    const second = await queryMessages(
      db,
      { isAdmin: true },
      { limit: 2, cursor: first.nextCursor! },
    );
    expect(second.messages.map((message) => message.ref.id)).toEqual([
      "c",
      "d",
    ]);
    expect(second.hasMore).toBe(false);
    expect(second.nextCursor).toBeNull();
  });

  it("supports ascending cursor pagination", async () => {
    const db = getDb();
    await createTestPerson({ id: "asc-person" });
    for (const [id, timestamp] of [
      ["a", 100],
      ["b", 200],
      ["c", 300],
    ] as const) {
      await db.insert(emails).values({
        id,
        personId: "asc-person",
        recipient: "inbox@saasmail.test",
        subject: id,
        bodyText: id,
        rawHeaders: "{}",
        messageId: `asc-${id}@example.com`,
        isRead: 0,
        receivedAt: timestamp,
        createdAt: timestamp,
      });
    }

    const first = await queryMessages(
      db,
      { isAdmin: true },
      { limit: 2, order: "asc" },
    );
    const second = await queryMessages(
      db,
      { isAdmin: true },
      { limit: 2, order: "asc", cursor: first.nextCursor! },
    );

    expect(first.messages.map((message) => message.ref.id)).toEqual(["a", "b"]);
    expect(second.messages.map((message) => message.ref.id)).toEqual(["c"]);
  });

  it("rejects malformed and version-mismatched cursors", async () => {
    await expect(
      queryMessages(getDb(), { isAdmin: true }, { cursor: "not-a-cursor" }),
    ).rejects.toBeInstanceOf(InvalidCursorError);

    const wrongVersion = btoa(
      JSON.stringify({ v: 2, occurredAt: 1, id: "x", kind: "received" }),
    ).replace(/=/g, "");

    await expect(
      queryMessages(getDb(), { isAdmin: true }, { cursor: wrongVersion }),
    ).rejects.toBeInstanceOf(InvalidCursorError);
  });

  it("rejects supplying cursor and offset together", async () => {
    await expect(
      queryMessages(
        getDb(),
        { isAdmin: true },
        { cursor: "anything", offset: 1 },
      ),
    ).rejects.toThrow("cursor or offset");
  });
  it("never turns delivery ledgers or outbox rows into duplicate messages", async () => {
    const db = getDb();

    await db.insert(sentEmails).values([
      {
        id: "campaign-visible",
        personId: null,
        fromAddress: "marketing@saasmail.test",
        toAddress: "subscriber@example.com",
        subject: "Campaign",
        bodyText: "Campaign body",
        status: "sent",
        campaignId: "campaign-1",
        sentAt: 300,
        createdAt: 300,
      },
      {
        id: "sequence-visible",
        personId: null,
        fromAddress: "sales@saasmail.test",
        toAddress: "lead@example.com",
        subject: "Sequence",
        bodyText: "Sequence body",
        status: "sent",
        sequenceId: "sequence-1",
        sequenceEnrollmentId: "enrollment-1",
        sentAt: 200,
        createdAt: 200,
      },
    ]);

    await db.insert(campaignRecipients).values({
      id: "campaign-ledger",
      campaignId: "campaign-1",
      contactId: "contact-1",
      email: "subscriber@example.com",
      status: "sent",
      idempotencyKey: "campaign-1:contact-1",
      sentEmailId: "campaign-visible",
      queuedAt: 100,
      processedAt: 301,
    });

    await db.insert(sequenceEmails).values({
      id: "sequence-ledger",
      enrollmentId: "enrollment-1",
      stepOrder: 0,
      templateSlug: "follow-up",
      scheduledAt: 100,
      status: "sent",
      sentAt: 200,
      sentEmailId: "sequence-visible",
    });

    await db.insert(outboxEmails).values({
      id: "pending-outbox",
      sentEmailId: "not-yet-visible",
      sequenceEmailId: "sequence-pending",
      fromAddress: "sales@saasmail.test",
      toAddress: "pending@example.com",
      subject: "Pending",
      bodyText: "Pending body",
      status: "pending",
      attempts: 0,
      createdAt: 400,
      updatedAt: 400,
    });

    const page = await queryMessages(db, { isAdmin: true }, { limit: 10 });

    expect(page.messages.map((message) => message.ref.id)).toEqual([
      "campaign-visible",
      "sequence-visible",
    ]);
    const sequenceMessage = page.messages.find(
      (message) => message.ref.id === "sequence-visible",
    );
    expect(sequenceMessage?.source.sequenceId).toBe("sequence-1");
    expect(sequenceMessage?.source.sequenceEnrollmentId).toBe("enrollment-1");
  });

  it("supports offsets beyond the search wrapper's 500-row ceiling", async () => {
    const db = getDb();
    const rows = Array.from({ length: 505 }, (_, index) => ({
      id: `deep-${String(index).padStart(3, "0")}`,
      personId: null,
      fromAddress: "archive@saasmail.test",
      toAddress: "someone@example.com",
      subject: "Archived",
      status: "sent",
      sentAt: index + 1,
      createdAt: index + 1,
    }));

    for (let start = 0; start < rows.length; start += 10) {
      await db.insert(sentEmails).values(rows.slice(start, start + 10));
    }

    const page = await queryMessages(
      db,
      { isAdmin: true },
      { inboxes: ["archive@saasmail.test"], offset: 500, limit: 5 },
    );

    expect(page.messages).toHaveLength(5);
    expect(page.messages.map((message) => message.occurredAt)).toEqual([
      5, 4, 3, 2, 1,
    ]);
  });
  it("accepts result limits above 100 and batches attachment enrichment safely", async () => {
    const db = getDb();
    const messageRows = Array.from({ length: 125 }, (_, index) => ({
      id: `wide-${String(index).padStart(3, "0")}`,
      personId: null,
      fromAddress: "wide@saasmail.test",
      toAddress: "someone@example.com",
      subject: "Wide result",
      status: "sent",
      sentAt: index + 1,
      createdAt: index + 1,
    }));

    for (let start = 0; start < messageRows.length; start += 10) {
      await db.insert(sentEmails).values(messageRows.slice(start, start + 10));
    }

    const page = await queryMessages(
      db,
      { isAdmin: true },
      {
        inboxes: ["wide@saasmail.test"],
        limit: 125,
        withAttachmentCounts: true,
        withAttachments: true,
      },
    );

    expect(page.messages).toHaveLength(125);
    expect(page.hasMore).toBe(false);
    expect(page.nextCursor).toBeNull();
    expect(
      page.messages.every((message) => message.attachmentCount === 0),
    ).toBe(true);
  });
});
