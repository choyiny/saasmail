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
  });
});
