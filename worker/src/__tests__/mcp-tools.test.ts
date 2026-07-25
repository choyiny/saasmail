import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import {
  applyMigrations,
  cleanDb,
  createTestEmail,
  createTestPerson,
  getDb,
} from "./helpers";
import { users } from "../db/auth.schema";
import { emails } from "../db/emails.schema";
import { people } from "../db/people.schema";
import { sentEmails } from "../db/sent-emails.schema";
import {
  ALL_SCOPES,
  type Credentials,
  callTool,
  createUserWithPassword,
  getAccessToken,
  grantInbox,
  mcpRpc,
  readRpc,
} from "./mcp-helpers";

const MINE = "mine@x.com";
const OTHER = "other@x.com";

const ADMIN: Credentials = {
  name: "Owner",
  email: "owner@saasmail.test",
  password: "correct-horse-battery",
};

const MEMBER: Credentials = {
  name: "Member",
  email: "member@saasmail.test",
  password: "member-password-123",
};

async function userIdFor(email: string): Promise<string> {
  const rows = await getDb()
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, email))
    .limit(1);
  expect(rows.length, `no user ${email}`).toBe(1);
  return rows[0].id;
}

async function insertSentEmail(
  id: string,
  fromAddress: string,
  personId: string,
) {
  const now = Math.floor(Date.now() / 1000);
  await getDb()
    .insert(sentEmails)
    .values({
      id,
      personId,
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
 * Two contacts: one who only ever wrote to MINE, one who only wrote to OTHER.
 * A member scoped to MINE must see exactly the first.
 */
async function seed() {
  await createTestPerson({ id: "p-mine", email: "alice@example.com" });
  await createTestPerson({ id: "p-other", email: "bob@example.com" });
  await createTestEmail({
    id: "e-mine",
    personId: "p-mine",
    recipient: MINE,
    subject: "Hello mine",
    messageId: "mine-1@example.com",
  });
  await createTestEmail({
    id: "e-other",
    personId: "p-other",
    recipient: OTHER,
    subject: "Hello other",
    messageId: "other-1@example.com",
  });
  await insertSentEmail("s-mine", MINE, "p-mine");
  await insertSentEmail("s-other", OTHER, "p-other");
}

describe("MCP tools", () => {
  let adminToken: string;
  let memberToken: string;

  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDb();
    await createUserWithPassword(ADMIN, "admin");
    await createUserWithPassword(MEMBER, "member");
    await grantInbox(await userIdFor(MEMBER.email), MINE);
    await seed();
    adminToken = await getAccessToken(ADMIN, ALL_SCOPES);
    memberToken = await getAccessToken(MEMBER, ALL_SCOPES);
  });

  describe("tools/list", () => {
    it("advertises every tool", async () => {
      const res = await mcpRpc(adminToken, "tools/list");
      const body = await readRpc(res);
      const names = (body.result.tools as Array<{ name: string }>)
        .map((t) => t.name)
        .sort();
      expect(names).toEqual(
        [
          "delete_email",
          "get_person",
          "list_emails",
          "list_people",
          "mark_read",
          "read_email",
          "whoami",
        ].sort(),
      );
    });

    it("marks delete_email destructive so clients can warn", async () => {
      const res = await mcpRpc(adminToken, "tools/list");
      const body = await readRpc(res);
      const del = (
        body.result.tools as Array<{
          name: string;
          annotations?: { destructiveHint?: boolean };
        }>
      ).find((t) => t.name === "delete_email");
      expect(del?.annotations?.destructiveHint).toBe(true);
    });
  });

  describe("whoami", () => {
    it("reports all inboxes for an admin", async () => {
      const out = await callTool(adminToken, "whoami");
      expect(out.isError).toBe(false);
      expect(out.data.email).toBe(ADMIN.email);
      expect(out.data.inboxes).toBe("all");
    });

    it("reports only the granted inboxes for a member", async () => {
      const out = await callTool(memberToken, "whoami");
      expect(out.data.role).toBe("member");
      expect(out.data.inboxes).toEqual([MINE]);
    });
  });

  describe("list_people", () => {
    it("returns every contact for an admin", async () => {
      const out = await callTool(adminToken, "list_people");
      const emailsSeen = out.data.data.map((r: any) => r.email).sort();
      expect(emailsSeen).toEqual(["alice@example.com", "bob@example.com"]);
    });

    it("hides contacts from inboxes the member cannot see", async () => {
      const out = await callTool(memberToken, "list_people");
      const emailsSeen = out.data.data.map((r: any) => r.email);
      expect(emailsSeen).toEqual(["alice@example.com"]);
    });
  });

  describe("get_person", () => {
    it("returns a contact inside an allowed inbox", async () => {
      const out = await callTool(memberToken, "get_person", {
        personId: "p-mine",
      });
      expect(out.isError).toBe(false);
      expect(out.data.email).toBe("alice@example.com");
    });

    it("reports a contact outside allowed inboxes as not found", async () => {
      const out = await callTool(memberToken, "get_person", {
        personId: "p-other",
      });
      expect(out.isError).toBe(true);
      expect(out.text).toContain("Not found");
    });
  });

  describe("list_emails", () => {
    it("returns messages for a visible contact", async () => {
      const out = await callTool(memberToken, "list_emails", {
        personId: "p-mine",
      });
      const ids = out.data.emails.map((e: any) => e.id).sort();
      expect(ids).toEqual(["e-mine", "s-mine"]);
    });

    it("returns nothing for a contact in another inbox", async () => {
      const out = await callTool(memberToken, "list_emails", {
        personId: "p-other",
      });
      expect(out.isError).toBe(false);
      expect(out.data.emails).toEqual([]);
    });
  });

  describe("read_email", () => {
    it("reads a received message in an allowed inbox", async () => {
      const out = await callTool(memberToken, "read_email", {
        emailId: "e-mine",
      });
      expect(out.data.type).toBe("received");
      expect(out.data.subject).toBe("Hello mine");
    });

    it("reads a sent message from an allowed inbox", async () => {
      const out = await callTool(memberToken, "read_email", {
        emailId: "s-mine",
      });
      expect(out.data.type).toBe("sent");
    });

    it("refuses a received message in another inbox", async () => {
      const out = await callTool(memberToken, "read_email", {
        emailId: "e-other",
      });
      expect(out.isError).toBe(true);
    });

    it("refuses a sent message from another inbox", async () => {
      const out = await callTool(memberToken, "read_email", {
        emailId: "s-other",
      });
      expect(out.isError).toBe(true);
    });
  });

  describe("mark_read", () => {
    it("marks a message read and decrements the unread count", async () => {
      const before = await getDb()
        .select({ unread: people.unreadCount })
        .from(people)
        .where(eq(people.id, "p-mine"));

      const out = await callTool(memberToken, "mark_read", {
        emailId: "e-mine",
        isRead: true,
      });
      expect(out.isError).toBe(false);

      const row = await getDb()
        .select({ isRead: emails.isRead })
        .from(emails)
        .where(eq(emails.id, "e-mine"));
      expect(row[0].isRead).toBe(1);

      const after = await getDb()
        .select({ unread: people.unreadCount })
        .from(people)
        .where(eq(people.id, "p-mine"));
      expect(after[0].unread).toBe(before[0].unread - 1);
    });

    it("refuses a message in another inbox and leaves it unread", async () => {
      const out = await callTool(memberToken, "mark_read", {
        emailId: "e-other",
        isRead: true,
      });
      expect(out.isError).toBe(true);

      const row = await getDb()
        .select({ isRead: emails.isRead })
        .from(emails)
        .where(eq(emails.id, "e-other"));
      expect(row[0].isRead).toBe(0);
    });
  });

  describe("delete_email", () => {
    it("deletes a received message in an allowed inbox", async () => {
      const out = await callTool(memberToken, "delete_email", {
        emailId: "e-mine",
      });
      expect(out.isError).toBe(false);
      const rows = await getDb()
        .select()
        .from(emails)
        .where(eq(emails.id, "e-mine"));
      expect(rows).toHaveLength(0);
    });

    it("refuses a received message in another inbox", async () => {
      const out = await callTool(memberToken, "delete_email", {
        emailId: "e-other",
      });
      expect(out.isError).toBe(true);
      const rows = await getDb()
        .select()
        .from(emails)
        .where(eq(emails.id, "e-other"));
      expect(rows).toHaveLength(1);
    });

    it("refuses a sent message from another inbox", async () => {
      // The gap fixed in #204, now asserted through the MCP surface: the
      // received-table lookup misses for a sent id, so an incomplete check
      // would fall through and destroy another inbox's mail.
      const out = await callTool(memberToken, "delete_email", {
        emailId: "s-other",
      });
      expect(out.isError).toBe(true);
      const rows = await getDb()
        .select()
        .from(sentEmails)
        .where(eq(sentEmails.id, "s-other"));
      expect(rows).toHaveLength(1);
    });

    it("lets an admin delete any message", async () => {
      const out = await callTool(adminToken, "delete_email", {
        emailId: "s-other",
      });
      expect(out.isError).toBe(false);
    });
  });

  describe("scope enforcement", () => {
    it("refuses a manage tool for a read-only token", async () => {
      const readOnly = await getAccessToken(ADMIN, "openid email:read");
      const out = await callTool(readOnly, "delete_email", {
        emailId: "e-mine",
      });
      expect(out.isError).toBe(true);
      expect(out.text).toContain("email:manage");

      // The message must survive a refused call.
      const rows = await getDb()
        .select()
        .from(emails)
        .where(eq(emails.id, "e-mine"));
      expect(rows).toHaveLength(1);
    });

    it("allows a read tool for a read-only token", async () => {
      const readOnly = await getAccessToken(ADMIN, "openid email:read");
      const out = await callTool(readOnly, "read_email", {
        emailId: "e-mine",
      });
      expect(out.isError).toBe(false);
    });

    it("refuses read tools when the token carries no capability scope", async () => {
      const bare = await getAccessToken(ADMIN, "openid");
      const out = await callTool(bare, "list_people");
      expect(out.isError).toBe(true);
      expect(out.text).toContain("email:read");
    });
  });
});
