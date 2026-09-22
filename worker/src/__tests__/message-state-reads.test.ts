import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
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
import { inboxPermissions } from "../db/inbox-permissions.schema";
import { messageUserState } from "../db/message-user-state.schema";
import {
  InvalidQueryError,
  buildMessageQuerySql,
  queryMessages,
} from "../lib/messages/query";
import {
  createMailbox,
  setMailboxMembership,
  setMailboxState,
  setUserState,
} from "../lib/messages/state";
import { listPersonEmails } from "../lib/queries/emails";

const INBOX = "support@saasmail.test";

describe("message state reads", () => {
  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDb();
  });

  async function seedReceived(id: string, isRead = 0) {
    await createTestPerson({
      id: `person-${id}`,
      email: `${id}@example.com`,
    });
    return createTestEmail({
      id,
      personId: `person-${id}`,
      recipient: INBOX,
      messageId: `${id}@example.com`,
      isRead,
    });
  }

  it("implements every system folder definition and keeps neutral reads neutral", async () => {
    const { userId } = await createTestUser({
      id: "folder-admin",
      email: "folder-admin@example.com",
    });
    const db = getDb();

    await seedReceived("inbox-message");
    await seedReceived("archive-message");
    await seedReceived("junk-message");
    await seedReceived("trash-message");
    await createTestSentEmail({
      id: "sent-message",
      fromAddress: INBOX,
      toAddress: "sent@example.com",
    });
    await createTestSentEmail({
      id: "sent-trash",
      fromAddress: INBOX,
      toAddress: "trash@example.com",
    });

    await setMailboxState(
      db,
      { isAdmin: true },
      userId,
      [{ kind: "received", id: "archive-message" }],
      { archived: true },
    );
    await setMailboxState(
      db,
      { isAdmin: true },
      userId,
      [{ kind: "received", id: "junk-message" }],
      { spam: true },
    );
    await setMailboxState(
      db,
      { isAdmin: true },
      userId,
      [
        { kind: "received", id: "trash-message" },
        { kind: "sent", id: "sent-trash" },
      ],
      { trashed: true },
    );

    const refs = async (
      folder?: "inbox" | "sent" | "archive" | "junk" | "trash",
    ) =>
      (
        await queryMessages(
          db,
          { isAdmin: true },
          folder ? { folder, inboxes: [INBOX] } : { inboxes: [INBOX] },
        )
      ).messages.map((message) => `${message.ref.kind}:${message.ref.id}`);

    expect(await refs("inbox")).toEqual(["received:inbox-message"]);
    expect(await refs("archive")).toEqual(["received:archive-message"]);
    expect(await refs("junk")).toEqual(["received:junk-message"]);
    expect((await refs("trash")).sort()).toEqual(
      ["received:trash-message", "sent:sent-trash"].sort(),
    );
    expect(await refs("sent")).toContain("sent:sent-message");
    expect(await refs()).toContain("received:trash-message");
  });

  it("moves a trashed spam message back to junk when un-trashed", async () => {
    const { userId } = await createTestUser({
      id: "junk-admin",
      email: "junk-admin@example.com",
    });
    await seedReceived("junk-trash");
    const db = getDb();
    const ref = [{ kind: "received" as const, id: "junk-trash" }];

    await setMailboxState(db, { isAdmin: true }, userId, ref, {
      spam: true,
      trashed: true,
    });
    expect(
      (
        await queryMessages(db, { isAdmin: true }, { folder: "trash" })
      ).messages.map((message) => message.ref.id),
    ).toContain("junk-trash");
    expect(
      (await queryMessages(db, { isAdmin: true }, { folder: "junk" })).messages,
    ).toEqual([]);

    await setMailboxState(db, { isAdmin: true }, userId, ref, {
      trashed: false,
    });
    expect(
      (
        await queryMessages(db, { isAdmin: true }, { folder: "junk" })
      ).messages.map((message) => message.ref.id),
    ).toContain("junk-trash");
  });

  it("uses the seen bootstrap and never treats sent mail as unseen", async () => {
    const { userId } = await createTestUser({
      id: "seen-viewer",
      email: "seen-viewer@example.com",
    });
    await seedReceived("legacy-unread", 0);
    await seedReceived("row-unseen", 1);
    await seedReceived("row-seen", 0);
    await createTestSentEmail({
      id: "sent-never-unseen",
      fromAddress: INBOX,
      toAddress: "sent@example.com",
    });

    const db = getDb();
    await db.insert(messageUserState).values([
      {
        userId,
        messageKind: "received",
        messageId: "row-unseen",
        seenAt: null,
        starredAt: null,
        updatedAt: 1,
      },
      {
        userId,
        messageKind: "received",
        messageId: "row-seen",
        seenAt: 1,
        starredAt: null,
        updatedAt: 1,
      },
    ]);

    const page = await queryMessages(
      db,
      { isAdmin: true },
      {
        viewer: { userId },
        unseen: true,
        withState: true,
      },
    );
    expect(page.messages.map((message) => message.ref.id).sort()).toEqual(
      ["legacy-unread", "row-unseen"].sort(),
    );
    expect(
      page.messages.every((message) => message.ref.kind === "received"),
    ).toBe(true);
    expect(
      page.messages.every((message) => message.state?.seen === false),
    ).toBe(true);
  });

  it("rejects starred and unseen filters without a viewer", async () => {
    await expect(
      queryMessages(getDb(), { isAdmin: true }, { starred: true }),
    ).rejects.toBeInstanceOf(InvalidQueryError);
    await expect(
      queryMessages(getDb(), { isAdmin: true }, { unseen: true }),
    ).rejects.toBeInstanceOf(InvalidQueryError);
  });

  it("keeps personal stars private between viewers", async () => {
    const a = await createTestUser({
      id: "star-a",
      email: "star-a@example.com",
    });
    const b = await createTestUser({
      id: "star-b",
      email: "star-b@example.com",
    });
    await seedReceived("star-message");
    await setUserState(
      getDb(),
      a.userId,
      [{ kind: "received", id: "star-message" }],
      { starred: true },
    );

    const aPage = await queryMessages(
      getDb(),
      { isAdmin: true },
      {
        viewer: { userId: a.userId },
        starred: true,
      },
    );
    const bPage = await queryMessages(
      getDb(),
      { isAdmin: true },
      {
        viewer: { userId: b.userId },
        starred: true,
      },
    );
    expect(aPage.messages.map((message) => message.ref.id)).toEqual([
      "star-message",
    ]);
    expect(bPage.messages).toEqual([]);
  });

  it("returns state and mailbox ids without changing no-viewer seen fallback", async () => {
    const { userId } = await createTestUser({
      id: "state-viewer",
      email: "state-viewer@example.com",
    });
    await seedReceived("stateful", 1);
    const db = getDb();
    const mailbox = await createMailbox(db, { isAdmin: true }, userId, {
      inbox: INBOX,
      name: "Projects",
    });
    await setMailboxMembership(
      db,
      { isAdmin: true },
      userId,
      [{ kind: "received", id: "stateful" }],
      { add: [mailbox.id] },
    );

    const page = await queryMessages(
      db,
      { isAdmin: true },
      { withState: true },
    );
    const message = page.messages.find((item) => item.ref.id === "stateful");
    expect(message?.state).toMatchObject({
      seen: true,
      starredAt: null,
      archivedAt: null,
      spamAt: null,
      trashedAt: null,
      mailboxIds: [mailbox.id],
    });
  });

  it("filters custom mailboxes and silently returns nothing outside allowed inboxes", async () => {
    const admin = await createTestUser({
      id: "mailbox-admin",
      email: "mailbox-admin@example.com",
    });
    const member = await createTestUser({
      id: "mailbox-member",
      role: "member",
      email: "mailbox-member@example.com",
    });
    await seedReceived("custom-message");
    await getDb().insert(inboxPermissions).values({
      userId: member.userId,
      email: "other@saasmail.test",
      createdAt: 1,
      createdBy: null,
    });
    const mailbox = await createMailbox(
      getDb(),
      { isAdmin: true },
      admin.userId,
      { inbox: INBOX, name: "Custom" },
    );
    await setMailboxMembership(
      getDb(),
      { isAdmin: true },
      admin.userId,
      [{ kind: "received", id: "custom-message" }],
      { add: [mailbox.id] },
    );

    const adminPage = await queryMessages(
      getDb(),
      { isAdmin: true },
      {
        folder: { mailboxId: mailbox.id },
      },
    );
    expect(adminPage.messages.map((message) => message.ref.id)).toEqual([
      "custom-message",
    ]);

    const memberPage = await queryMessages(
      getDb(),
      { isAdmin: false, inboxes: ["other@saasmail.test"] },
      { folder: { mailboxId: mailbox.id } },
    );
    expect(memberPage.messages).toEqual([]);
  });

  it("person timelines hide trash and spam but keep archived mail", async () => {
    const { userId } = await createTestUser({
      id: "timeline-admin",
      email: "timeline-admin@example.com",
    });
    await createTestPerson({
      id: "timeline-person",
      email: "timeline@example.com",
    });
    for (const id of [
      "timeline-normal",
      "timeline-archive",
      "timeline-spam",
      "timeline-trash",
    ]) {
      await createTestEmail({
        id,
        personId: "timeline-person",
        recipient: INBOX,
        messageId: `${id}@example.com`,
      });
    }
    const db = getDb();
    await setMailboxState(
      db,
      { isAdmin: true },
      userId,
      [{ kind: "received", id: "timeline-archive" }],
      { archived: true },
    );
    await setMailboxState(
      db,
      { isAdmin: true },
      userId,
      [{ kind: "received", id: "timeline-spam" }],
      { spam: true },
    );
    await setMailboxState(
      db,
      { isAdmin: true },
      userId,
      [{ kind: "received", id: "timeline-trash" }],
      { trashed: true },
    );

    const result = await listPersonEmails(
      db,
      "timeline-person",
      { page: 1, limit: 20 },
      { isAdmin: true },
    );
    expect(result.emails.map((email) => email.id).sort()).toEqual(
      ["timeline-normal", "timeline-archive"].sort(),
    );
  });

  it("can exclude campaign sends and include them again explicitly", async () => {
    await createTestSentEmail({
      id: "ordinary-send",
      fromAddress: INBOX,
      toAddress: "ordinary@example.com",
    });
    await createTestSentEmail({
      id: "campaign-send",
      fromAddress: INBOX,
      toAddress: "campaign@example.com",
      campaignId: "campaign-1",
    });

    const hidden = await queryMessages(
      getDb(),
      { isAdmin: true },
      {
        folder: "sent",
        excludeCampaignSends: true,
      },
    );
    expect(hidden.messages.map((message) => message.ref.id)).toEqual([
      "ordinary-send",
    ]);

    const included = await queryMessages(
      getDb(),
      { isAdmin: true },
      {
        folder: "sent",
        excludeCampaignSends: false,
      },
    );
    expect(included.messages.map((message) => message.ref.id).sort()).toEqual(
      ["ordinary-send", "campaign-send"].sort(),
    );
  });

  it("paginates folder=inbox across timestamp ties", async () => {
    await createTestPerson({ id: "tie-person", email: "tie@example.com" });
    const db = getDb();
    await db.insert(emails).values(
      ["a", "b", "c"].map((id) => ({
        id,
        personId: "tie-person",
        recipient: INBOX,
        subject: id,
        bodyHtml: null,
        bodyText: id,
        rawHeaders: "{}",
        messageId: `tie-${id}@example.com`,
        isRead: 0,
        conversationId: null,
        cc: null,
        receivedAt: 100,
        createdAt: 100,
      })),
    );

    const first = await queryMessages(
      db,
      { isAdmin: true },
      {
        folder: "inbox",
        inboxes: [INBOX],
        limit: 2,
      },
    );
    const second = await queryMessages(
      db,
      { isAdmin: true },
      {
        folder: "inbox",
        inboxes: [INBOX],
        limit: 2,
        cursor: first.nextCursor!,
      },
    );
    expect(first.messages.map((message) => message.ref.id)).toEqual(["c", "b"]);
    expect(second.messages.map((message) => message.ref.id)).toEqual(["a"]);
  });

  it("keeps the inbox-folder plan index-backed", async () => {
    const built = buildMessageQuerySql(
      { isAdmin: false, inboxes: [INBOX] },
      { inboxes: [INBOX], folder: "inbox", limit: 10 },
    );
    expect(built).not.toBeNull();
    const plan = await getDb().all<{ detail: string }>(
      sql`EXPLAIN QUERY PLAN ${built!.statement}`,
    );
    const details = plan.map((row) => row.detail).join("\n");
    expect(details).toContain("emails_recipient_received_idx");
    expect(details).not.toMatch(/\bSCAN emails\b/i);
  });

  it("keeps sent state seen even when a personal row exists", async () => {
    const { userId } = await createTestUser({
      id: "sent-viewer",
      email: "sent-viewer@example.com",
    });
    await createTestSentEmail({
      id: "sent-state",
      fromAddress: INBOX,
      toAddress: "sent@example.com",
    });
    await getDb().insert(messageUserState).values({
      userId,
      messageKind: "sent",
      messageId: "sent-state",
      seenAt: null,
      starredAt: 1,
      updatedAt: 1,
    });

    const page = await queryMessages(
      getDb(),
      { isAdmin: true },
      {
        viewer: { userId },
        withState: true,
        folder: "sent",
      },
    );
    expect(page.messages[0].state?.seen).toBe(true);
  });
});
