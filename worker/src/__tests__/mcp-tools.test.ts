import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import {
  applyMigrations,
  cleanDb,
  createTestEmail,
  createTestPerson,
  createTestTemplate,
  getDb,
} from "./helpers";
import { sequences } from "../db/sequences.schema";
import { sequenceEnrollments } from "../db/sequence-enrollments.schema";
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
          "enroll_sequence",
          "get_person",
          "list_emails",
          "list_people",
          "mark_read",
          "read_email",
          "reply_email",
          "search_emails",
          "send_email",
          "send_template",
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
      expect(out.text).toContain("Not found");
    });

    it("refuses a sent message from another inbox", async () => {
      const out = await callTool(memberToken, "read_email", {
        emailId: "s-other",
      });
      expect(out.isError).toBe(true);
      expect(out.text).toContain("Not found");
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
      expect(out.text).toContain("Not found");

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
      expect(out.text).toContain("Not found");
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
      expect(out.text).toContain("Not found");
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

  describe("search_emails", () => {
    it("finds a received message by a word in its subject", async () => {
      const out = await callTool(memberToken, "search_emails", {
        q: "mine",
      });
      expect(out.isError, out.text).toBe(false);
      const ids = out.data.hits.map((h: any) => h.id);
      expect(ids).toContain("e-mine");
    });

    it("finds a received message by a word in its body", async () => {
      await createTestEmail({
        id: "e-body",
        personId: "p-mine",
        recipient: MINE,
        subject: "No keyword here",
        bodyText: "the quarterly invoice is attached",
        messageId: "body-1@example.com",
      });
      const out = await callTool(memberToken, "search_emails", {
        q: "invoice",
      });
      const ids = out.data.hits.map((h: any) => h.id);
      expect(ids).toContain("e-body");
    });

    it("finds sent messages too", async () => {
      const out = await callTool(memberToken, "search_emails", {
        q: "Outgoing",
      });
      const hit = out.data.hits.find((h: any) => h.id === "s-mine");
      expect(hit).toBeTruthy();
      expect(hit.type).toBe("sent");
    });

    it("never returns messages from another inbox", async () => {
      // "Hello" matches both the MINE and OTHER seeded subjects.
      const out = await callTool(memberToken, "search_emails", { q: "Hello" });
      const ids = out.data.hits.map((h: any) => h.id);
      expect(ids).toContain("e-mine");
      expect(ids).not.toContain("e-other");
    });

    it("returns both inboxes for an admin", async () => {
      const out = await callTool(adminToken, "search_emails", { q: "Hello" });
      const ids = out.data.hits.map((h: any) => h.id).sort();
      expect(ids).toEqual(["e-mine", "e-other"]);
    });

    it("restricts to a single inbox when asked", async () => {
      const out = await callTool(adminToken, "search_emails", {
        q: "Hello",
        inbox: OTHER,
      });
      const ids = out.data.hits.map((h: any) => h.id);
      expect(ids).toEqual(["e-other"]);
    });

    it("returns an empty result rather than erroring on no match", async () => {
      const out = await callTool(memberToken, "search_emails", {
        q: "zzzznotpresent",
      });
      expect(out.isError).toBe(false);
      expect(out.data.hits).toEqual([]);
      expect(out.data.hasMore).toBe(false);
    });

    it("treats LIKE wildcards as literal text", async () => {
      // A bare "%" must not behave as match-everything on the sent-mail side.
      const out = await callTool(memberToken, "search_emails", { q: "%" });
      expect(out.isError).toBe(false);
      expect(out.data.hits).toEqual([]);
    });

    it("paginates and reports hasMore", async () => {
      for (let i = 0; i < 3; i++) {
        await createTestEmail({
          id: `e-page-${i}`,
          personId: "p-mine",
          recipient: MINE,
          subject: `Paginate ${i}`,
          messageId: `page-${i}@example.com`,
        });
      }
      const first = await callTool(memberToken, "search_emails", {
        q: "Paginate",
        limit: 2,
      });
      expect(first.data.hits).toHaveLength(2);
      expect(first.data.hasMore).toBe(true);

      const second = await callTool(memberToken, "search_emails", {
        q: "Paginate",
        limit: 2,
        page: 2,
      });
      expect(second.data.hits).toHaveLength(1);
      expect(second.data.hasMore).toBe(false);

      // Pages must not overlap.
      const firstIds = first.data.hits.map((h: any) => h.id);
      const secondIds = second.data.hits.map((h: any) => h.id);
      expect(firstIds.filter((id: string) => secondIds.includes(id))).toEqual(
        [],
      );
    });

    it("filters by time range", async () => {
      const out = await callTool(memberToken, "search_emails", {
        q: "Hello",
        after: Math.floor(Date.now() / 1000) + 3600,
      });
      expect(out.data.hits).toEqual([]);
    });
  });

  describe("send_template", () => {
    beforeEach(async () => {
      await createTestTemplate({
        slug: "welcome",
        subject: "Hi {{name}}",
        bodyHtml: "<p>Hi {{name}}, welcome!</p>",
      });
      // DemoSender, so sends complete without reaching a real provider.
      (env as any).DEMO_MODE = "1";
    });

    afterEach(() => {
      (env as any).DEMO_MODE = "0";
    });

    it("sends from an allowed inbox", async () => {
      const out = await callTool(memberToken, "send_template", {
        slug: "welcome",
        to: "alice@example.com",
        fromAddress: MINE,
        variables: { name: "Alice" },
      });
      expect(out.isError, out.text).toBe(false);
      expect(out.data.status).toBe("sent");
    });

    it("refuses to send from an inbox the member does not own", async () => {
      const out = await callTool(memberToken, "send_template", {
        slug: "welcome",
        to: "alice@example.com",
        fromAddress: OTHER,
        variables: { name: "Alice" },
      });
      expect(out.isError).toBe(true);
      expect(out.text).toContain("Inbox not allowed");

      const rows = await getDb()
        .select()
        .from(sentEmails)
        .where(eq(sentEmails.fromAddress, OTHER));
      // Only the seeded message; nothing new was sent.
      expect(rows).toHaveLength(1);
    });

    it("names the missing variables so the caller can retry", async () => {
      const out = await callTool(memberToken, "send_template", {
        slug: "welcome",
        to: "alice@example.com",
        fromAddress: MINE,
        variables: {},
      });
      expect(out.isError).toBe(true);
      expect(out.text).toContain("name");
    });

    it("reports an unknown template", async () => {
      const out = await callTool(memberToken, "send_template", {
        slug: "does-not-exist",
        to: "alice@example.com",
        fromAddress: MINE,
      });
      expect(out.isError).toBe(true);
    });
  });

  describe("send_email / reply_email", () => {
    beforeEach(() => {
      (env as any).DEMO_MODE = "1";
    });
    afterEach(() => {
      (env as any).DEMO_MODE = "0";
    });

    it("sends from an allowed inbox", async () => {
      const out = await callTool(memberToken, "send_email", {
        to: "alice@example.com",
        fromAddress: MINE,
        subject: "Hello there",
        bodyHtml: "<p>Hi</p>",
        bodyText: "Hi",
      });
      expect(out.isError, out.text).toBe(false);
      expect(out.data.status).toBe("sent");
    });

    it("refuses to send from an inbox the member does not own", async () => {
      const before = await getDb().select().from(sentEmails);
      const out = await callTool(memberToken, "send_email", {
        to: "alice@example.com",
        fromAddress: OTHER,
        subject: "Nope",
        bodyHtml: "<p>Nope</p>",
      });
      expect(out.isError).toBe(true);
      expect(out.text).toContain("Inbox not allowed");
      const after = await getDb().select().from(sentEmails);
      expect(after).toHaveLength(before.length);
    });

    it("rejects a recipient that is not an address", async () => {
      const out = await callTool(memberToken, "send_email", {
        to: "Bob Smith",
        fromAddress: MINE,
        subject: "Hi",
        bodyHtml: "<p>Hi</p>",
      });
      expect(out.isError).toBe(true);
    });

    it("replies to a message in an allowed inbox", async () => {
      const out = await callTool(memberToken, "reply_email", {
        emailId: "e-mine",
        fromAddress: MINE,
        bodyHtml: "<p>replying</p>",
      });
      expect(out.isError, out.text).toBe(false);
    });

    it("reports a reply target in another inbox as not found", async () => {
      const out = await callTool(memberToken, "reply_email", {
        emailId: "e-other",
        fromAddress: MINE,
        bodyHtml: "<p>replying</p>",
      });
      expect(out.isError).toBe(true);
      // Must not confirm the message exists in an inbox the caller can't see.
      expect(out.text).toContain("Not found");
    });
  });

  describe("enroll_sequence", () => {
    beforeEach(async () => {
      await createTestTemplate({ slug: "step-1", subject: "One" });
      await createTestTemplate({ slug: "step-2", subject: "Two" });
      const now = Math.floor(Date.now() / 1000);
      await getDb()
        .insert(sequences)
        .values({
          id: "seq-1",
          name: "Onboarding",
          steps: JSON.stringify([
            { order: 1, templateSlug: "step-1", delayHours: 0 },
            { order: 2, templateSlug: "step-2", delayHours: 24 },
          ]),
          createdAt: now,
          updatedAt: now,
        });
      (env as any).DEMO_MODE = "1";
    });

    afterEach(() => {
      (env as any).DEMO_MODE = "0";
    });

    it("enrols a contact and schedules every step", async () => {
      const out = await callTool(memberToken, "enroll_sequence", {
        sequenceId: "seq-1",
        personEmail: "alice@example.com",
        fromAddress: MINE,
        variables: { name: "Alice" },
      });
      expect(out.isError, out.text).toBe(false);
      expect(out.data.scheduledEmails).toHaveLength(2);
      expect(out.data.enrollment.status).toBe("active");
    });

    it("refuses to enrol from an inbox the member does not own", async () => {
      const out = await callTool(memberToken, "enroll_sequence", {
        sequenceId: "seq-1",
        personEmail: "alice@example.com",
        fromAddress: OTHER,
      });
      expect(out.isError).toBe(true);
      expect(out.text).toContain("Inbox not allowed");

      const rows = await getDb().select().from(sequenceEnrollments);
      expect(rows).toHaveLength(0);
    });

    it("refuses a second active enrolment for the same contact", async () => {
      const first = await callTool(memberToken, "enroll_sequence", {
        sequenceId: "seq-1",
        personEmail: "alice@example.com",
        fromAddress: MINE,
      });
      expect(first.isError, first.text).toBe(false);

      const second = await callTool(memberToken, "enroll_sequence", {
        sequenceId: "seq-1",
        personEmail: "alice@example.com",
        fromAddress: MINE,
      });
      expect(second.isError).toBe(true);
      expect(second.text.toLowerCase()).toContain("active sequence");
    });

    it("skips the steps it is told to skip", async () => {
      const out = await callTool(memberToken, "enroll_sequence", {
        sequenceId: "seq-1",
        personEmail: "alice@example.com",
        fromAddress: MINE,
        skipSteps: [2],
      });
      expect(out.isError, out.text).toBe(false);
      expect(out.data.scheduledEmails).toHaveLength(1);
      expect(out.data.scheduledEmails[0].stepOrder).toBe(1);
    });

    it("reports an unknown sequence", async () => {
      const out = await callTool(memberToken, "enroll_sequence", {
        sequenceId: "nope",
        personEmail: "alice@example.com",
        fromAddress: MINE,
      });
      expect(out.isError).toBe(true);
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
