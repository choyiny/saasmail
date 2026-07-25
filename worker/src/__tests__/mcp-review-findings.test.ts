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
import { attachments } from "../db/attachments.schema";
import { sentEmails } from "../db/sent-emails.schema";
import { blocklist } from "../db/blocklist.schema";
import {
  ALL_SCOPES,
  type Credentials,
  callTool,
  createUserWithPassword,
  getAccessToken,
  grantInbox,
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
  return rows[0].id;
}

describe("review findings", () => {
  let memberToken: string;

  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDb();
    await createUserWithPassword(ADMIN, "admin");
    await createUserWithPassword(MEMBER, "member");
    await grantInbox(await userIdFor(MEMBER.email), MINE);
    memberToken = await getAccessToken(MEMBER, ALL_SCOPES);
  });

  describe("list_people cross-inbox leak", () => {
    it("does not reveal inboxes the caller cannot see for a shared contact", async () => {
      // One contact who wrote to BOTH the member's inbox and a private one.
      await createTestPerson({ id: "p-shared", email: "vendor@example.com" });
      await createTestEmail({
        id: "e-shared-mine",
        personId: "p-shared",
        recipient: MINE,
        subject: "Invoice question",
        messageId: "shared-mine@example.com",
      });
      await createTestEmail({
        id: "e-shared-other",
        personId: "p-shared",
        recipient: OTHER,
        subject: "Termination settlement",
        messageId: "shared-other@example.com",
      });

      const out = await callTool(memberToken, "list_people");
      expect(out.isError, out.text).toBe(false);

      const inboxes = out.data.data.map((r: any) => r.recipient);
      expect(inboxes).toContain(MINE);
      // The private inbox's existence, counts, and subject must not leak
      // merely because the contact is in scope through another inbox.
      expect(inboxes).not.toContain(OTHER);

      const subjects = out.data.data.map((r: any) => r.latestSubject);
      expect(subjects).not.toContain("Termination settlement");
    });
  });

  describe("search_emails scoping", () => {
    beforeEach(async () => {
      await createTestPerson({ id: "p-mine", email: "alice@example.com" });
      await createTestPerson({ id: "p-other", email: "bob@example.com" });
      await createTestEmail({
        id: "e-mine",
        personId: "p-mine",
        recipient: MINE,
        subject: "Hello quarterly",
        messageId: "m1@example.com",
      });
      await createTestEmail({
        id: "e-other",
        personId: "p-other",
        recipient: OTHER,
        subject: "Hello quarterly",
        messageId: "o1@example.com",
      });
    });

    it("ignores an inbox filter naming an inbox the member cannot see", async () => {
      // The scope clause is ANDed with the inbox filter, so asking for someone
      // else's inbox must yield nothing rather than escaping the grant.
      const out = await callTool(memberToken, "search_emails", {
        q: "quarterly",
        inbox: OTHER,
      });
      expect(out.isError, out.text).toBe(false);
      expect(out.data.hits).toEqual([]);
    });

    it("returns nothing for a member with no inbox grants", async () => {
      await createUserWithPassword(
        {
          name: "Ungranted",
          email: "none@saasmail.test",
          password: "pw-12345678",
        },
        "member",
      );
      const token = await getAccessToken(
        {
          name: "Ungranted",
          email: "none@saasmail.test",
          password: "pw-12345678",
        },
        ALL_SCOPES,
      );
      // An empty grant list renders `IN ()`, a SQLite syntax error — this must
      // short-circuit, not surface a database error.
      const out = await callTool(token, "search_emails", { q: "quarterly" });
      expect(out.isError, out.text).toBe(false);
      expect(out.data.hits).toEqual([]);
    });

    it("hides mail from a blocked sender", async () => {
      await getDb()
        .insert(blocklist)
        .values({
          id: "b-1",
          type: "email",
          value: "alice@example.com",
          createdAt: Math.floor(Date.now() / 1000),
        });
      const out = await callTool(memberToken, "search_emails", {
        q: "quarterly",
      });
      // Blocking is expected to hide existing mail, not merely stop new mail.
      expect(out.data.hits.map((h: any) => h.id)).not.toContain("e-mine");
    });

    it("honours a zero timestamp bound instead of dropping it", async () => {
      // `before: 0` is falsy but meaningful — it must not widen to everything.
      const out = await callTool(memberToken, "search_emails", {
        q: "quarterly",
        before: 0,
      });
      expect(out.data.hits).toEqual([]);
    });
  });

  describe("delete_email attachment cleanup", () => {
    it("deletes attachments belonging to a sent message", async () => {
      await createTestPerson({ id: "p-1", email: "alice@example.com" });
      const now = Math.floor(Date.now() / 1000);
      await getDb().insert(sentEmails).values({
        id: "s-1",
        personId: "p-1",
        fromAddress: MINE,
        toAddress: "alice@example.com",
        subject: "With attachment",
        bodyHtml: "<p>see attached</p>",
        bodyText: "see attached",
        messageId: "s-1@saasmail.test",
        status: "sent",
        sentAt: now,
        createdAt: now,
      });
      await getDb().insert(attachments).values({
        id: "att-1",
        emailId: "s-1",
        kind: "sent",
        filename: "invoice.pdf",
        contentType: "application/pdf",
        size: 100,
        r2Key: "attachments/att-1",
        createdAt: now,
      });

      const out = await callTool(memberToken, "delete_email", {
        emailId: "s-1",
      });
      expect(out.isError, out.text).toBe(false);
      expect(out.data.attachmentsDeleted).toBe(1);

      // The row must not survive its parent message.
      const left = await getDb()
        .select()
        .from(attachments)
        .where(eq(attachments.emailId, "s-1"));
      expect(left).toHaveLength(0);
    });
  });
});
