import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import {
  applyMigrations,
  cleanDb,
  createTestUser,
  createTestPerson,
  createTestEmail,
  authFetch,
  getDb,
  buildSendForm,
} from "./helpers";
import { people } from "../db/people.schema";
import { sentEmails } from "../db/sent-emails.schema";
import { attachments } from "../db/attachments.schema";

describe("send router", () => {
  let apiKey: string;

  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDb();
    ({ apiKey } = await createTestUser());
    // Use DemoSender so send() always succeeds in tests. The global test env
    // sets RESEND_API_KEY to a fake key (ResendSender would error); DEMO_MODE
    // is kept "0" globally so sequence-processor and enroll-route tests
    // exercise real queue behaviour. We override only for this describe block
    // and restore it in afterEach.
    (env as any).DEMO_MODE = "1";
  });

  afterEach(() => {
    (env as any).DEMO_MODE = "0";
  });

  describe("POST /api/send", () => {
    it("creates a people row for a new recipient", async () => {
      const res = await authFetch("/api/send", {
        apiKey,
        method: "POST",
        body: buildSendForm({
          to: "newperson@example.com",
          fromAddress: "me@saasmail.test",
          subject: "Hello",
          bodyHtml: "<p>Hi</p>",
        }),
      });
      expect(res.status).toBe(201);

      const db = getDb();
      const rows = await db
        .select()
        .from(people)
        .where(eq(people.email, "newperson@example.com"));
      expect(rows).toHaveLength(1);
      expect(rows[0].email).toBe("newperson@example.com");
    });

    it("populates sent_emails.personId for a new recipient", async () => {
      const res = await authFetch("/api/send", {
        apiKey,
        method: "POST",
        body: buildSendForm({
          to: "newperson@example.com",
          fromAddress: "me@saasmail.test",
          subject: "Hello",
          bodyHtml: "<p>Hi</p>",
        }),
      });
      const body = (await res.json()) as { id: string };

      const db = getDb();
      const rows = await db
        .select()
        .from(sentEmails)
        .where(eq(sentEmails.id, body.id));
      expect(rows).toHaveLength(1);
      expect(rows[0].personId).not.toBeNull();
    });

    it("reuses an existing people row when the recipient already exists", async () => {
      await createTestPerson({
        id: "existing-1",
        email: "existing@example.com",
      });

      const res = await authFetch("/api/send", {
        apiKey,
        method: "POST",
        body: buildSendForm({
          to: "existing@example.com",
          fromAddress: "me@saasmail.test",
          subject: "Hi again",
          bodyHtml: "<p>Hi</p>",
        }),
      });
      const body = (await res.json()) as { id: string };

      const db = getDb();
      const peopleRows = await db
        .select()
        .from(people)
        .where(eq(people.email, "existing@example.com"));
      expect(peopleRows).toHaveLength(1);
      expect(peopleRows[0].id).toBe("existing-1");

      const sentRows = await db
        .select()
        .from(sentEmails)
        .where(eq(sentEmails.id, body.id));
      expect(sentRows[0].personId).toBe("existing-1");
    });

    it("stores a single sent attachment in R2 and the attachments table", async () => {
      const payload = {
        to: "newperson@example.com",
        fromAddress: "me@saasmail.test",
        subject: "With attachment",
        bodyHtml: "<p>see attached</p>",
      };
      const file = {
        name: "report.pdf",
        type: "application/pdf",
        bytes: new Uint8Array([1, 2, 3, 4, 5]),
      };

      const res = await authFetch("/api/send", {
        apiKey,
        method: "POST",
        body: buildSendForm(payload, [file]),
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as {
        id: string;
        attachmentIds: string[];
      };
      expect(body.attachmentIds).toHaveLength(1);

      const db = getDb();
      const rows = await db
        .select()
        .from(attachments)
        .where(eq(attachments.emailId, body.id));
      expect(rows).toHaveLength(1);
      expect(rows[0].kind).toBe("sent");
      expect(rows[0].filename).toBe("report.pdf");
      expect(rows[0].contentType).toBe("application/pdf");
      expect(rows[0].size).toBe(5);
    });

    it("rejects more than 50 files with 400", async () => {
      const payload = {
        to: "a@example.com",
        fromAddress: "me@saasmail.test",
        subject: "many",
        bodyHtml: "<p>x</p>",
      };
      const files = Array.from({ length: 51 }, (_, i) => ({
        name: `f${i}.txt`,
        bytes: new Uint8Array([0]),
      }));
      const res = await authFetch("/api/send", {
        apiKey,
        method: "POST",
        body: buildSendForm(payload, files),
      });
      expect(res.status).toBe(400);
    });

    it("rejects oversize total with 413", async () => {
      const big = new Uint8Array(26 * 1024 * 1024);
      const payload = {
        to: "a@example.com",
        fromAddress: "me@saasmail.test",
        subject: "huge",
        bodyHtml: "<p>x</p>",
      };
      const res = await authFetch("/api/send", {
        apiKey,
        method: "POST",
        body: buildSendForm(payload, [{ name: "big.bin", bytes: big }]),
      });
      expect(res.status).toBe(413);
    });
  });

  describe("POST /api/send/reply/:emailId", () => {
    it("persists attachments on a reply", async () => {
      const person = await createTestPerson({
        id: "p1",
        email: "a@example.com",
      });
      await createTestEmail({
        id: "rcv-1",
        personId: person.id,
        recipient: "me@saasmail.test",
        subject: "hi",
        messageId: "abc@example.com",
      });

      const res = await authFetch("/api/send/reply/rcv-1", {
        apiKey,
        method: "POST",
        body: buildSendForm(
          { fromAddress: "me@saasmail.test", bodyHtml: "<p>reply</p>" },
          [
            {
              name: "evidence.png",
              type: "image/png",
              bytes: new Uint8Array([9, 9, 9]),
            },
          ],
        ),
      });
      expect(res.status).toBe(201);

      const body = (await res.json()) as {
        id: string;
        attachmentIds: string[];
      };
      expect(body.attachmentIds).toHaveLength(1);

      const db = getDb();
      const rows = await db
        .select()
        .from(attachments)
        .where(eq(attachments.emailId, body.id));
      expect(rows).toHaveLength(1);
      expect(rows[0].kind).toBe("sent");
      expect(rows[0].filename).toBe("evidence.png");
    });
  });

  describe("GET /api/people/grouped after sending", () => {
    it("includes a recipient that has only received sent emails", async () => {
      const sendRes = await authFetch("/api/send", {
        apiKey,
        method: "POST",
        body: buildSendForm({
          to: "newperson@example.com",
          fromAddress: "me@saasmail.test",
          subject: "Hello",
          bodyHtml: "<p>Hi</p>",
        }),
      });
      expect(sendRes.status).toBe(201);

      const res = await authFetch("/api/people/grouped", { apiKey });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        data: Array<{ email: string; totalCount: number }>;
        total: number;
      };
      expect(body.total).toBe(1);
      expect(body.data).toHaveLength(1);
      expect(body.data[0].email).toBe("newperson@example.com");
      expect(body.data[0].totalCount).toBe(1);
    });
  });
});
