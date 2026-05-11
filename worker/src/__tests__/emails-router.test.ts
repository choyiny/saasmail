import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import {
  applyMigrations,
  cleanDb,
  createTestUser,
  createTestPerson,
  createTestEmail,
  authFetch,
  getDb,
} from "./helpers";
import { sentEmails } from "../db/sent-emails.schema";
import { senderIdentities } from "../db/sender-identities.schema";
import { people } from "../db/people.schema";
import { emails } from "../db/emails.schema";
import { inboxPermissions } from "../db/inbox-permissions.schema";
import { eq } from "drizzle-orm";

async function grantInbox(userId: string, email: string) {
  await getDb()
    .insert(inboxPermissions)
    .values({
      userId,
      email,
      createdAt: Math.floor(Date.now() / 1000),
      createdBy: null,
    });
}

describe("emails router", () => {
  let apiKey: string;

  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDb();
    ({ apiKey } = await createTestUser());
  });

  describe("GET /api/emails/by-person/:personId", () => {
    it("returns received and sent emails interleaved", async () => {
      const db = getDb();
      await createTestPerson({ id: "s1", email: "a@test.com" });
      await createTestEmail({ id: "e1", personId: "s1" });

      const now = Math.floor(Date.now() / 1000);
      await db.insert(sentEmails).values({
        id: "se1",
        personId: "s1",
        fromAddress: "me@saasmail.test",
        toAddress: "a@test.com",
        subject: "Reply",
        bodyHtml: "<p>Reply</p>",
        bodyText: null,
        resendId: null,
        status: "sent",
        sentAt: now + 10,
        createdAt: now + 10,
      });

      const res = await authFetch("/api/emails/by-person/s1", {
        apiKey,
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { emails: any[]; inboxes: any[] };
      const data = body.emails;
      expect(data).toHaveLength(2);
      // Most recent first — sent email has higher timestamp
      expect(data[0].type).toBe("sent");
      expect(data[1].type).toBe("received");
    });

    it("includes sent replies when filtering by recipient", async () => {
      const db = getDb();
      await createTestPerson({ id: "s1", email: "a@test.com" });
      await createTestEmail({
        id: "e1",
        personId: "s1",
        recipient: "inbox@saasmail.test",
      });

      const now = Math.floor(Date.now() / 1000);
      await db.insert(sentEmails).values({
        id: "se1",
        personId: "s1",
        fromAddress: "inbox@saasmail.test",
        toAddress: "a@test.com",
        subject: "Re: Test Subject",
        bodyHtml: "<p>Reply</p>",
        bodyText: null,
        resendId: null,
        status: "sent",
        sentAt: now + 10,
        createdAt: now + 10,
      });

      // Filter by recipient (inbox address) — sent replies should still appear
      const res = await authFetch(
        "/api/emails/by-person/s1?recipient=inbox@saasmail.test",
        { apiKey },
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { emails: any[]; inboxes: any[] };
      const data = body.emails;
      expect(data).toHaveLength(2);
      expect(data[0].type).toBe("sent");
      expect(data[1].type).toBe("received");
    });

    it("paginates results", async () => {
      await createTestPerson({ id: "s1", email: "a@test.com" });
      for (let i = 0; i < 5; i++) {
        await createTestEmail({
          id: `e${i}`,
          personId: "s1",
          messageId: `msg-${i}@test.com`,
          subject: `Subject ${i}`,
        });
      }

      const res = await authFetch("/api/emails/by-person/s1?limit=2&page=1", {
        apiKey,
      });
      const body = (await res.json()) as { emails: any[]; inboxes: any[] };
      const data = body.emails;
      expect(data).toHaveLength(2);
    });

    it("searches by subject", async () => {
      await createTestPerson({ id: "s1", email: "a@test.com" });
      await createTestEmail({
        id: "e1",
        personId: "s1",
        subject: "Important Meeting",
      });
      await createTestEmail({
        id: "e2",
        personId: "s1",
        subject: "Lunch",
        messageId: "msg-2@test.com",
      });

      const res = await authFetch("/api/emails/by-person/s1?q=Important", {
        apiKey,
      });
      const body = (await res.json()) as { emails: any[]; inboxes: any[] };
      const data = body.emails;
      expect(data).toHaveLength(1);
      expect(data[0].subject).toBe("Important Meeting");
    });

    it("returns inboxes[] with displayMode for each inbox referenced by emails", async () => {
      const db = getDb();
      await createTestPerson({ id: "s1", email: "a@test.com" });
      await createTestEmail({
        id: "e1",
        personId: "s1",
        recipient: "support@saasmail.test",
      });

      const now = Math.floor(Date.now() / 1000);
      await db.insert(sentEmails).values({
        id: "se1",
        personId: "s1",
        fromAddress: "sales@saasmail.test",
        toAddress: "a@test.com",
        subject: "Hi",
        bodyHtml: "<p>Hi</p>",
        bodyText: null,
        resendId: null,
        status: "sent",
        sentAt: now + 10,
        createdAt: now + 10,
      });

      // Set support@ to thread mode (override the new default); sales@ has
      // no row so it falls back to the default ("chat").
      await db.insert(senderIdentities).values({
        email: "support@saasmail.test",
        displayName: null,
        displayMode: "thread",
        createdAt: now,
        updatedAt: now,
      });

      const res = await authFetch("/api/emails/by-person/s1", { apiKey });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        emails: any[];
        inboxes: Array<{
          email: string;
          displayName: string | null;
          displayMode: "thread" | "chat";
        }>;
      };
      const byEmail = Object.fromEntries(body.inboxes.map((i) => [i.email, i]));
      expect(byEmail["support@saasmail.test"]?.displayMode).toBe("thread");
      expect(byEmail["sales@saasmail.test"]?.displayMode).toBe("chat");
    });
  });

  describe("GET /api/emails/:id", () => {
    it("returns email with attachments", async () => {
      await createTestPerson({ id: "s1", email: "a@test.com" });
      await createTestEmail({ id: "e1", personId: "s1" });

      const res = await authFetch("/api/emails/e1", { apiKey });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.id).toBe("e1");
      expect(data.type).toBe("received");
      expect(data.attachments).toEqual([]);
    });

    it("returns 404 for missing email", async () => {
      const res = await authFetch("/api/emails/nonexistent", { apiKey });
      expect(res.status).toBe(404);
    });

    it("returns a sent email when the id belongs to the sent_emails table", async () => {
      // Reproduces the Reply-on-our-own-message bug: thread mode lets you
      // click Reply on any visible bubble, including our own sent
      // replies. The lookup must transparently fall back to sent_emails
      // so the composer can render its "what you're replying to" panel.
      const db = getDb();
      await createTestPerson({ id: "s1", email: "a@test.com" });
      const now = Math.floor(Date.now() / 1000);
      await db.insert(sentEmails).values({
        id: "se-thread",
        personId: "s1",
        fromAddress: "inbox@saasmail.test",
        toAddress: "a@test.com",
        subject: "Re: Feature request",
        bodyHtml: "<p>thanks for the suggestion</p>",
        bodyText: "thanks for the suggestion",
        resendId: null,
        status: "sent",
        sentAt: now,
        createdAt: now,
      });

      const res = await authFetch("/api/emails/se-thread", { apiKey });
      expect(res.status).toBe(200);
      const data = (await res.json()) as any;
      expect(data.id).toBe("se-thread");
      expect(data.type).toBe("sent");
      expect(data.fromAddress).toBe("inbox@saasmail.test");
      expect(data.toAddress).toBe("a@test.com");
      expect(data.subject).toBe("Re: Feature request");
      expect(data.recipient).toBeNull();
      expect(data.isRead).toBeNull();
      expect(data.cc).toEqual([]);
    });

    it("returns 404 when a non-admin tries to fetch a sent email from an inbox they don't own", async () => {
      // Negative-path complement to the happy case above. The
      // sent_emails fallback in getEmailRoute applies the same
      // ownership check as the reply route — only surface a sent row
      // to a caller who still owns the inbox that sent it. Guards
      // against id-guessing a teammate's outgoing message.
      const { apiKey, userId } = await createTestUser({
        id: "u-getsent-1",
        role: "member",
        email: "member-getsent@x.com",
      });
      await grantInbox(userId, "a@x.com");
      await createTestPerson({
        id: "p-getsent-1",
        email: "target@external.com",
      });
      const db = getDb();
      const now = Math.floor(Date.now() / 1000);
      await db.insert(sentEmails).values({
        id: "se-other-inbox-get",
        personId: "p-getsent-1",
        // fromAddress belongs to a different inbox the caller does NOT have
        // permission for. They must not be able to see it via id-guess.
        fromAddress: "b@x.com",
        toAddress: "target@external.com",
        subject: "Other user's outgoing",
        bodyHtml: "<p>private</p>",
        bodyText: null,
        messageId: "<orig@b.test>",
        resendId: "r-other-2",
        status: "sent",
        sentAt: now,
        createdAt: now,
      });

      const res = await authFetch("/api/emails/se-other-inbox-get", {
        apiKey,
      });
      expect(res.status).toBe(404);
    });
  });

  describe("PATCH /api/emails/:id", () => {
    it("marks email as read and decrements sender unread count", async () => {
      await createTestPerson({
        id: "s1",
        email: "a@test.com",
        unreadCount: 1,
      });
      await createTestEmail({ id: "e1", personId: "s1", isRead: 0 });

      const res = await authFetch("/api/emails/e1", {
        apiKey,
        method: "PATCH",
        body: JSON.stringify({ isRead: true }),
      });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.success).toBe(true);

      // Verify the sender unread count was decremented
      const db = getDb();
      const senderRow = await db
        .select()
        .from(people)
        .where(eq(people.id, "s1"))
        .limit(1);
      expect(senderRow[0].unreadCount).toBe(0);
    });

    it("marks email as unread and increments sender unread count", async () => {
      await createTestPerson({
        id: "s1",
        email: "a@test.com",
        unreadCount: 0,
      });
      await createTestEmail({ id: "e1", personId: "s1", isRead: 1 });

      const res = await authFetch("/api/emails/e1", {
        apiKey,
        method: "PATCH",
        body: JSON.stringify({ isRead: false }),
      });
      expect(res.status).toBe(200);

      const db = getDb();
      const senderRow = await db
        .select()
        .from(people)
        .where(eq(people.id, "s1"))
        .limit(1);
      expect(senderRow[0].unreadCount).toBe(1);
    });

    it("does not change unread count when state is same", async () => {
      await createTestPerson({
        id: "s1",
        email: "a@test.com",
        unreadCount: 1,
      });
      await createTestEmail({ id: "e1", personId: "s1", isRead: 0 });

      await authFetch("/api/emails/e1", {
        apiKey,
        method: "PATCH",
        body: JSON.stringify({ isRead: false }),
      });

      const db = getDb();
      const senderRow = await db
        .select()
        .from(people)
        .where(eq(people.id, "s1"))
        .limit(1);
      expect(senderRow[0].unreadCount).toBe(1);
    });

    it("returns 404 for missing email", async () => {
      const res = await authFetch("/api/emails/nonexistent", {
        apiKey,
        method: "PATCH",
        body: JSON.stringify({ isRead: true }),
      });
      expect(res.status).toBe(404);
    });
  });

  // Note: PATCH /api/emails/bulk is unreachable because PATCH /{id} is
  // registered first and "bulk" matches as an {id} param. Skipping tests
  // for this endpoint as it's a known routing issue.
});

describe("reply stores generated message-id", () => {
  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDb();
  });

  it("persists a <...@domain> message_id on /reply/{id} for a received email", async () => {
    const { apiKey, userId } = await createTestUser({
      id: "u-reply",
      role: "admin",
      email: "admin@x.com",
    });
    await grantInbox(userId, "a@x.com");
    await createTestPerson({ id: "p-r", email: "person@external.com" });
    await createTestEmail({
      id: "e-r",
      personId: "p-r",
      recipient: "a@x.com",
      messageId: "<orig@external>",
    });
    const res = await authFetch("/api/send/reply/e-r", {
      apiKey,
      method: "POST",
      body: JSON.stringify({
        fromAddress: "a@x.com",
        bodyHtml: "<p>reply</p>",
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string };
    const db = getDb();
    const row = await db
      .select()
      .from(sentEmails)
      .where(eq(sentEmails.id, body.id))
      .get();
    expect(row?.messageId).toMatch(/^<[A-Za-z0-9_-]+@x\.com>$/);
    expect(row?.inReplyTo).toBe("<orig@external>");
  });
});

describe("send stores generated message-id", () => {
  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDb();
  });

  it("persists a <...@domain> message_id on /send", async () => {
    const { apiKey, userId } = await createTestUser({
      id: "u-send",
      role: "admin",
      email: "admin@x.com",
    });
    await grantInbox(userId, "a@x.com");
    const res = await authFetch("/api/send", {
      apiKey,
      method: "POST",
      body: JSON.stringify({
        to: "target@external.com",
        fromAddress: "a@x.com",
        subject: "hello",
        bodyHtml: "<p>hi</p>",
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string };
    const db = getDb();
    const row = await db
      .select()
      .from(sentEmails)
      .where(eq(sentEmails.id, body.id))
      .get();
    expect(row?.messageId).toMatch(/^<[A-Za-z0-9_-]+@x\.com>$/);
  });

  describe("reply to own sent email", () => {
    it("replies to a sent email id using its to_address and message_id", async () => {
      const { apiKey, userId } = await createTestUser({
        id: "u-rso",
        role: "admin",
        email: "admin@x.com",
      });
      await grantInbox(userId, "a@x.com");
      await createTestPerson({ id: "p-rso", email: "target@external.com" });
      const db = getDb();
      const now = Math.floor(Date.now() / 1000);
      // Seed a prior sent email with a known message_id.
      await db.insert(sentEmails).values({
        id: "sent-1",
        personId: "p-rso",
        fromAddress: "a@x.com",
        toAddress: "target@external.com",
        subject: "Original outreach",
        bodyHtml: "<p>hi</p>",
        bodyText: null,
        messageId: "<prior@x.com>",
        resendId: "r-1",
        status: "sent",
        sentAt: now,
        createdAt: now,
      });
      const res = await authFetch("/api/send/reply/sent-1", {
        apiKey,
        method: "POST",
        body: JSON.stringify({
          fromAddress: "a@x.com",
          bodyHtml: "<p>follow up</p>",
        }),
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as { id: string };
      const row = await db
        .select()
        .from(sentEmails)
        .where(eq(sentEmails.id, body.id))
        .get();
      expect(row?.toAddress).toBe("target@external.com");
      expect(row?.inReplyTo).toBe("<prior@x.com>");
      expect(row?.subject).toBe("Re: Original outreach");
      expect(row?.personId).toBe("p-rso");
    });

    it("replies to a sent email with null message_id (legacy row) and omits in_reply_to", async () => {
      const { apiKey, userId } = await createTestUser({
        id: "u-rso2",
        role: "admin",
        email: "admin@x.com",
      });
      await grantInbox(userId, "a@x.com");
      await createTestPerson({ id: "p-rso2", email: "target2@external.com" });
      const db = getDb();
      const now = Math.floor(Date.now() / 1000);
      await db.insert(sentEmails).values({
        id: "sent-legacy",
        personId: "p-rso2",
        fromAddress: "a@x.com",
        toAddress: "target2@external.com",
        subject: "Legacy outreach",
        bodyHtml: "<p>hi</p>",
        bodyText: null,
        messageId: null,
        resendId: "r-legacy",
        status: "sent",
        sentAt: now,
        createdAt: now,
      });
      const res = await authFetch("/api/send/reply/sent-legacy", {
        apiKey,
        method: "POST",
        body: JSON.stringify({
          fromAddress: "a@x.com",
          bodyHtml: "<p>follow up</p>",
        }),
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as { id: string };
      const row = await db
        .select()
        .from(sentEmails)
        .where(eq(sentEmails.id, body.id))
        .get();
      expect(row?.inReplyTo).toBeNull();
      expect(row?.toAddress).toBe("target2@external.com");
    });

    it("forbids reply when caller does not own the original sent email's inbox", async () => {
      // Non-admin member user has access to a@x.com only. A sent row exists
      // that was originally sent from b@x.com (another user's inbox). Even if
      // the caller's new fromAddress is a@x.com (allowed), they must not be
      // able to thread a reply onto the other user's outgoing message.
      const { apiKey, userId } = await createTestUser({
        id: "u-rso4",
        role: "member",
        email: "member@x.com",
      });
      await grantInbox(userId, "a@x.com");
      await createTestPerson({ id: "p-rso4", email: "target4@external.com" });
      const db = getDb();
      const now = Math.floor(Date.now() / 1000);
      await db.insert(sentEmails).values({
        id: "sent-other-inbox",
        personId: "p-rso4",
        fromAddress: "b@x.com",
        toAddress: "target4@external.com",
        subject: "Not your outreach",
        bodyHtml: "<p>hi</p>",
        bodyText: null,
        messageId: "<orig@b.test>",
        resendId: "r-other",
        status: "sent",
        sentAt: now,
        createdAt: now,
      });
      const res = await authFetch("/api/send/reply/sent-other-inbox", {
        apiKey,
        method: "POST",
        body: JSON.stringify({
          fromAddress: "a@x.com",
          bodyHtml: "<p>follow up</p>",
        }),
      });
      expect(res.status).toBe(403);
    });

    it("returns 404 when id matches neither emails nor sent_emails", async () => {
      const { apiKey, userId } = await createTestUser({
        id: "u-rso3",
        role: "admin",
        email: "admin@x.com",
      });
      await grantInbox(userId, "a@x.com");
      const res = await authFetch("/api/send/reply/does-not-exist", {
        apiKey,
        method: "POST",
        body: JSON.stringify({
          fromAddress: "a@x.com",
          bodyHtml: "<p>follow up</p>",
        }),
      });
      expect(res.status).toBe(404);
    });
  });
});
