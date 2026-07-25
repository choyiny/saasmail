import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import {
  applyMigrations,
  authFetch,
  cleanDb,
  createTestEmail,
  createTestPerson,
  createTestUser,
  getDb,
  buildSendForm,
} from "./helpers";
import { inboxPermissions } from "../db/inbox-permissions.schema";
import { sentEmails } from "../db/sent-emails.schema";
import { emails } from "../db/emails.schema";

const MINE = "mine@x.com";
const OTHER = "other@x.com";

/** Insert a sent email attributable to a given inbox. */
async function insertSentEmail(id: string, fromAddress: string) {
  const now = Math.floor(Date.now() / 1000);
  await getDb()
    .insert(sentEmails)
    .values({
      id,
      personId: "sender-1",
      fromAddress,
      toAddress: "alice@example.com",
      subject: "Outgoing",
      bodyHtml: "<p>Outgoing</p>",
      bodyText: "Outgoing",
      messageId: `${id}@saasmail.test`,
      status: "sent",
      sentAt: now,
      createdAt: now,
    });
}

/**
 * A member scoped to a single inbox. Inbox-permission enforcement is only
 * meaningful for non-admins — `allowed.isAdmin` short-circuits every check.
 */
async function createScopedMember() {
  const { apiKey } = await createTestUser({
    id: "u-member",
    role: "member",
    email: "member@x.com",
  });
  await getDb()
    .insert(inboxPermissions)
    .values({
      userId: "u-member",
      email: MINE,
      createdAt: Math.floor(Date.now() / 1000),
      createdBy: null,
    });
  return apiKey;
}

describe("inbox permission enforcement", () => {
  let apiKey: string;

  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDb();
    apiKey = await createScopedMember();
    await createTestPerson();
    // DemoSender so the reply path completes without hitting Resend.
    (env as any).DEMO_MODE = "1";
  });

  afterEach(() => {
    (env as any).DEMO_MODE = "0";
  });

  describe("DELETE /api/emails/{id}", () => {
    it("refuses to delete a sent email belonging to another inbox", async () => {
      await insertSentEmail("sent-other", OTHER);

      const res = await authFetch("/api/emails/sent-other", {
        apiKey,
        method: "DELETE",
      });
      expect(res.status).toBe(404);

      // The row must survive — this delete is irreversible.
      const rows = await getDb()
        .select()
        .from(sentEmails)
        .where(eq(sentEmails.id, "sent-other"));
      expect(rows).toHaveLength(1);
    });

    it("deletes a sent email belonging to an allowed inbox", async () => {
      await insertSentEmail("sent-mine", MINE);

      const res = await authFetch("/api/emails/sent-mine", {
        apiKey,
        method: "DELETE",
      });
      expect(res.status).toBe(200);

      const rows = await getDb()
        .select()
        .from(sentEmails)
        .where(eq(sentEmails.id, "sent-mine"));
      expect(rows).toHaveLength(0);
    });

    it("refuses to delete a received email addressed to another inbox", async () => {
      await createTestEmail({ id: "rcv-other", recipient: OTHER });

      const res = await authFetch("/api/emails/rcv-other", {
        apiKey,
        method: "DELETE",
      });
      expect(res.status).toBe(404);

      const rows = await getDb()
        .select()
        .from(emails)
        .where(eq(emails.id, "rcv-other"));
      expect(rows).toHaveLength(1);
    });

    it("deletes a received email addressed to an allowed inbox", async () => {
      await createTestEmail({ id: "rcv-mine", recipient: MINE });

      const res = await authFetch("/api/emails/rcv-mine", {
        apiKey,
        method: "DELETE",
      });
      expect(res.status).toBe(200);

      const rows = await getDb()
        .select()
        .from(emails)
        .where(eq(emails.id, "rcv-mine"));
      expect(rows).toHaveLength(0);
    });

    it("still 404s for an id that matches nothing", async () => {
      const res = await authFetch("/api/emails/does-not-exist", {
        apiKey,
        method: "DELETE",
      });
      expect(res.status).toBe(404);
    });
  });

  describe("POST /api/send/reply/{emailId}", () => {
    it("refuses to reply to an email received at another inbox", async () => {
      await createTestEmail({ id: "rcv-other", recipient: OTHER });

      const res = await authFetch("/api/send/reply/rcv-other", {
        apiKey,
        method: "POST",
        body: buildSendForm({
          fromAddress: MINE,
          bodyHtml: "<p>reply</p>",
        }),
      });
      expect(res.status).toBe(403);

      // Nothing may be queued for delivery.
      const rows = await getDb().select().from(sentEmails);
      expect(rows).toHaveLength(0);
    });

    it("allows a reply to an email received at an allowed inbox", async () => {
      await createTestEmail({ id: "rcv-mine", recipient: MINE });

      const res = await authFetch("/api/send/reply/rcv-mine", {
        apiKey,
        method: "POST",
        body: buildSendForm({
          fromAddress: MINE,
          bodyHtml: "<p>reply</p>",
        }),
      });
      expect(res.status).toBe(201);
    });

    it("refuses to reply to a sent email belonging to another inbox", async () => {
      await insertSentEmail("sent-other", OTHER);

      const res = await authFetch("/api/send/reply/sent-other", {
        apiKey,
        method: "POST",
        body: buildSendForm({
          fromAddress: MINE,
          bodyHtml: "<p>reply</p>",
        }),
      });
      expect(res.status).toBe(403);
    });
  });
});
