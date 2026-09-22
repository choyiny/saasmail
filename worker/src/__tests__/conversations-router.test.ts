import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import {
  applyMigrations,
  cleanDb,
  createTestUser,
  createTestPerson,
  authFetch,
  getDb,
  buildSendForm,
} from "./helpers";
import { sentEmails } from "../db/sent-emails.schema";
import { emails } from "../db/emails.schema";
import { inboxPermissions } from "../db/inbox-permissions.schema";

describe("conversations router", () => {
  let apiKey: string;

  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDb();
    ({ apiKey } = await createTestUser());
    // Use DemoSender so /api/send succeeds in tests.
    (env as any).DEMO_MODE = "1";
  });

  afterEach(() => {
    (env as any).DEMO_MODE = "0";
  });

  describe("GET /api/conversations/{id}/emails", () => {
    it("includes sent attachments in the thread response", async () => {
      // 1. Send an email with one attachment.
      const sendRes = await authFetch("/api/send", {
        apiKey,
        method: "POST",
        body: buildSendForm(
          {
            to: "newperson@example.com",
            fromAddress: "me@saasmail.test",
            subject: "Hi with attachment",
            bodyHtml: "<p>see attached</p>",
            cc: [{ email: "other@example.com" }],
          },
          [
            {
              name: "doc.txt",
              type: "text/plain",
              bytes: new Uint8Array([1, 2, 3]),
            },
          ],
        ),
      });
      expect(sendRes.status).toBe(201);
      const sendBody = (await sendRes.json()) as { id: string };

      // 2. Look up conversation id for the sent email.
      const db = getDb();
      const sentRows = await db
        .select()
        .from(sentEmails)
        .where(eq(sentEmails.id, sendBody.id));
      expect(sentRows).toHaveLength(1);
      const convId = sentRows[0].conversationId;
      expect(convId).not.toBeNull();

      // 3. Fetch the conversation thread.
      const res = await authFetch(`/api/conversations/${convId}/emails`, {
        apiKey,
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        emails: Array<{
          id: string;
          type: "received" | "sent";
          attachmentCount: number;
          attachments: Array<{ filename: string }>;
        }>;
      };

      const sentRow = body.emails.find((e) => e.id === sendBody.id);
      expect(sentRow).toBeDefined();
      expect(sentRow!.type).toBe("sent");
      expect(sentRow!.attachments).toHaveLength(1);
      expect(sentRow!.attachments[0].filename).toBe("doc.txt");
      expect(sentRow!.attachmentCount).toBe(1);
    });

    it("resolves fromAddress to the sender person for received emails", async () => {
      const db = getDb();
      const now = Math.floor(Date.now() / 1000);
      await createTestPerson({ id: "p1", email: "external@example.com" });
      await db.insert(emails).values({
        id: "recv-1",
        personId: "p1",
        recipient: "me@saasmail.test",
        subject: "Inbound",
        bodyHtml: "<p>hi</p>",
        bodyText: "hi",
        rawHeaders: "{}",
        messageId: "inbound-1@example.com",
        isRead: 0,
        conversationId: "conv-xyz",
        receivedAt: now,
        createdAt: now,
      });

      const res = await authFetch("/api/conversations/conv-xyz/emails", {
        apiKey,
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        emails: Array<{ id: string; type: string; fromAddress: string | null }>;
      };
      const received = body.emails.find((e) => e.id === "recv-1");
      expect(received).toBeDefined();
      expect(received!.type).toBe("received");
      expect(received!.fromAddress).toBe("external@example.com");
    });

    it("returns conversations longer than 100 messages in one response", async () => {
      const db = getDb();
      await createTestPerson({
        id: "long-thread-person",
        email: "long-thread@example.com",
      });

      const rows = Array.from({ length: 125 }, (_, index) => ({
        id: `long-thread-${String(index).padStart(3, "0")}`,
        personId: "long-thread-person",
        recipient: "me@saasmail.test",
        subject: "Long thread",
        bodyText: `Message ${index}`,
        rawHeaders: "{}",
        messageId: `long-thread-${index}@example.com`,
        isRead: 0,
        conversationId: "long-thread",
        receivedAt: index + 1,
        createdAt: index + 1,
      }));

      for (let start = 0; start < rows.length; start += 5) {
        await db.insert(emails).values(rows.slice(start, start + 5));
      }

      const res = await authFetch("/api/conversations/long-thread/emails", {
        apiKey,
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        emails: Array<{ id: string; timestamp: number }>;
      };
      expect(body.emails).toHaveLength(125);
      expect(body.emails[0].timestamp).toBe(1);
      expect(body.emails[124].timestamp).toBe(125);
    });

    it("authorizes mixed-case stored inbox addresses through normalized scoping", async () => {
      const db = getDb();
      const { userId, apiKey: memberKey } = await createTestUser({
        id: "conversation-member",
        role: "member",
        email: "conversation-member@example.com",
      });
      await db.insert(inboxPermissions).values({
        userId,
        email: "support@saasmail.test",
        createdAt: 1,
        createdBy: userId,
      });
      await createTestPerson({
        id: "case-person",
        email: "case@example.com",
      });
      await db.insert(emails).values({
        id: "case-recv",
        personId: "case-person",
        recipient: "Support@saasmail.test",
        subject: "Mixed case inbox",
        bodyText: "Hello",
        rawHeaders: "{}",
        messageId: "case-recv@example.com",
        isRead: 0,
        conversationId: "case-conversation",
        receivedAt: 100,
        createdAt: 100,
      });

      const res = await authFetch(
        "/api/conversations/case-conversation/emails",
        { apiKey: memberKey },
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as { emails: Array<{ id: string }> };
      expect(body.emails.map((email) => email.id)).toEqual(["case-recv"]);
    });
  });
});
