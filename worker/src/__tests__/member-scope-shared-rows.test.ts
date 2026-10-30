// A conversation or a person can have mail in an inbox the member is granted
// and in one they are not. Reads show only the granted inbox's mail and writes
// touch only it; an admin still sees and changes both.
import { eq, inArray } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { drafts } from "../db/drafts.schema";
import { emails } from "../db/emails.schema";
import { inboxPermissions } from "../db/inbox-permissions.schema";
import { people } from "../db/people.schema";
import {
  applyMigrations,
  authFetch,
  cleanDb,
  createTestAttachment,
  createTestEmail,
  createTestPerson,
  createTestSentEmail,
  createTestUser,
  getDb,
} from "./helpers";

const GRANTED = "granted@saasmail.test";
const PRIVATE = "private@saasmail.test";
const T_GRANTED = 1_800_000_000;
const T_PRIVATE = T_GRANTED + 3600;

async function users() {
  const admin = await createTestUser({ id: "scope-admin" });
  const member = await createTestUser({
    id: "scope-member",
    role: "member",
    email: "scope-member@example.com",
  });
  await getDb().insert(inboxPermissions).values({
    userId: member.userId,
    email: GRANTED,
    createdAt: 1,
    createdBy: null,
  });
  return { admin: admin.apiKey, member: member.apiKey };
}

async function email(
  id: string,
  recipient: string,
  at: number,
  opts: { personId: string; conversationId?: string; cc?: string },
) {
  await createTestEmail({
    id,
    personId: opts.personId,
    recipient,
    messageId: `${id}@example.com`,
    conversationId: opts.conversationId ?? null,
    cc: opts.cc ?? null,
  });
  await getDb().update(emails).set({ receivedAt: at }).where(eq(emails.id, id));
}

async function json(path: string, apiKey: string, init: RequestInit = {}) {
  const response = await authFetch(path, { ...init, apiKey });
  expect(response.status, path).toBe(200);
  return (await response.json()) as any;
}

async function unread(ids: string[]) {
  const rows = await getDb()
    .select({ id: emails.id, isRead: emails.isRead })
    .from(emails)
    .where(inArray(emails.id, ids));
  return Object.fromEntries(rows.map((row) => [row.id, row.isRead === 0]));
}

describe("rows shared between a granted and a private inbox", () => {
  beforeAll(async () => {
    await applyMigrations();
  });
  beforeEach(async () => {
    await cleanDb();
    await createTestPerson({ id: "p-both", email: "both@example.com" });
  });

  describe("POST /api/conversations/mark-read", () => {
    async function seedConversation() {
      await email("c-granted", GRANTED, T_GRANTED, {
        personId: "p-both",
        conversationId: "conv-shared",
      });
      await email("c-private", PRIVATE, T_PRIVATE, {
        personId: "p-both",
        conversationId: "conv-shared",
      });
    }
    const mark = (apiKey: string) =>
      json("/api/conversations/mark-read", apiKey, {
        method: "POST",
        body: JSON.stringify({ conversationIds: ["conv-shared"] }),
      });

    it("a member marks only the granted inbox's rows read", async () => {
      const { member } = await users();
      await seedConversation();
      expect(await mark(member)).toEqual({ success: true, affected: 1 });
      expect(await unread(["c-granted", "c-private"])).toEqual({
        "c-granted": false,
        "c-private": true,
      });
    });

    it("an admin marks every row read", async () => {
      const { admin } = await users();
      await seedConversation();
      expect(await mark(admin)).toEqual({ success: true, affected: 2 });
      expect(await unread(["c-granted", "c-private"])).toEqual({
        "c-granted": false,
        "c-private": false,
      });
    });
  });

  describe("people reads", () => {
    async function seedPerson() {
      await email("p-granted", GRANTED, T_GRANTED, { personId: "p-both" });
      await email("p-private", PRIVATE, T_PRIVATE, { personId: "p-both" });
      await createTestAttachment({
        id: "att-private",
        emailId: "p-private",
        r2Key: "attachments/private.txt",
      });
      // The denormalized counters span every inbox.
      await getDb()
        .update(people)
        .set({ lastEmailAt: T_PRIVATE, unreadCount: 2, totalCount: 2 })
        .where(eq(people.id, "p-both"));
    }

    function personRow(body: { data: any[] }) {
      const row = body.data.find(
        (item) => item.type === "person" && item.id === "p-both",
      );
      expect(row).toBeDefined();
      return row;
    }

    it("GET /api/people/grouped: a member sees only the granted inbox's address, counts, recency and attachments", async () => {
      const { member, admin } = await users();
      await seedPerson();
      expect(
        personRow(await json("/api/people/grouped", member)),
      ).toMatchObject({
        recipients: [GRANTED],
        recipientCount: 1,
        totalCount: 1,
        unreadCount: 1,
        lastEmailAt: T_GRANTED,
        hasAttachment: 0,
      });
      const adminRow = personRow(await json("/api/people/grouped", admin));
      expect([...adminRow.recipients].sort()).toEqual(
        [GRANTED, PRIVATE].sort(),
      );
      expect(adminRow).toMatchObject({
        recipientCount: 2,
        totalCount: 2,
        unreadCount: 2,
        lastEmailAt: T_PRIVATE,
        hasAttachment: 1,
      });
    });

    it("GET /api/people/grouped?unread=1 and ?recipient=<private>: nothing from the private inbox", async () => {
      const { member } = await users();
      await seedPerson();
      // Only the private row is unread.
      await getDb()
        .update(emails)
        .set({ isRead: 1 })
        .where(eq(emails.id, "p-granted"));
      const unreadOnly = await json("/api/people/grouped?unread=1", member);
      expect(unreadOnly.data).toEqual([]);
      const privateOnly = await json(
        `/api/people/grouped?recipient=${encodeURIComponent(PRIVATE)}`,
        member,
      );
      expect(privateOnly.data).toEqual([]);
    });

    it("GET /api/people/{id}: a member gets counts and recency over the granted inbox only", async () => {
      const { member, admin } = await users();
      await seedPerson();
      expect(await json("/api/people/p-both", member)).toMatchObject({
        id: "p-both",
        lastEmailAt: T_GRANTED,
        unreadCount: 1,
        totalCount: 1,
      });
      expect(await json("/api/people/p-both", admin)).toMatchObject({
        id: "p-both",
        lastEmailAt: T_PRIVATE,
        unreadCount: 2,
        totalCount: 2,
      });
    });

    it("GET /api/people/grouped group rows: participants, CC and attachments of the granted inbox only", async () => {
      const { member, admin } = await users();
      await createTestPerson({ id: "p-secret", email: "secret@example.com" });
      await email("g-granted", GRANTED, T_GRANTED, {
        personId: "p-both",
        conversationId: "conv-g",
        cc: JSON.stringify([{ email: "cc-granted@example.com", name: null }]),
      });
      await email("g-private", PRIVATE, T_PRIVATE, {
        personId: "p-secret",
        conversationId: "conv-g",
        cc: JSON.stringify([{ email: "cc-secret@example.com", name: null }]),
      });
      await createTestAttachment({
        id: "att-g-private",
        emailId: "g-private",
        r2Key: "attachments/g-private.txt",
      });

      const groups = (body: { data: any[] }) =>
        body.data.filter((row) => row.type === "group");
      const [memberGroup, ...rest] = groups(
        await json("/api/people/grouped", member),
      );
      expect(rest).toEqual([]);
      expect(memberGroup).toMatchObject({
        id: "conv-g",
        inbox: GRANTED,
        hasAttachment: 0,
      });
      expect(memberGroup.participants.map((p: any) => p.id)).toEqual([
        "p-both",
      ]);
      expect(memberGroup.ccParticipants.map((p: any) => p.email)).toEqual([
        "cc-granted@example.com",
      ]);

      const adminGroups = groups(await json("/api/people/grouped", admin));
      expect(adminGroups.map((g: any) => g.inbox).sort()).toEqual(
        [GRANTED, PRIVATE].sort(),
      );
      for (const group of adminGroups) {
        expect(group.hasAttachment).toBe(1);
        expect(group.participants.map((p: any) => p.id).sort()).toEqual([
          "p-both",
          "p-secret",
        ]);
      }
    });
  });

  describe("people: the last review's findings", () => {
    it("POST /api/people/mark-read with a private recipient changes nothing", async () => {
      const { member, admin } = await users();
      await email("m-granted", GRANTED, T_GRANTED, { personId: "p-both" });
      await email("m-private", PRIVATE, T_PRIVATE, { personId: "p-both" });
      const denied = await json("/api/people/mark-read", member, {
        method: "POST",
        body: JSON.stringify({ personIds: ["p-both"], recipient: PRIVATE }),
      });
      expect(denied).toEqual({ success: true, affected: 0 });
      expect(await unread(["m-granted", "m-private"])).toEqual({
        "m-granted": true,
        "m-private": true,
      });
      // Without a recipient a member still reaches only the granted inbox.
      await json("/api/people/mark-read", member, {
        method: "POST",
        body: JSON.stringify({ personIds: ["p-both"] }),
      });
      expect(await unread(["m-granted", "m-private"])).toEqual({
        "m-granted": false,
        "m-private": true,
      });
      await json("/api/people/mark-read", admin, {
        method: "POST",
        body: JSON.stringify({ personIds: ["p-both"], recipient: PRIVATE }),
      });
      expect(await unread(["m-private"])).toEqual({ "m-private": false });
    });

    it("GET /api/people/grouped?drafts=1: a draft on a private row doesn't surface a shared conversation", async () => {
      const { member } = await users();
      await email("d-granted", GRANTED, T_GRANTED, {
        personId: "p-both",
        conversationId: "conv-d",
      });
      await email("d-private", PRIVATE, T_PRIVATE, {
        personId: "p-both",
        conversationId: "conv-d",
      });
      // The member's reply draft on the private row (e.g. written before the
      // grant was revoked).
      await getDb().insert(drafts).values({
        id: "draft-private",
        userId: "scope-member",
        contextKey: "reply:d-private",
        replyToEmailId: "d-private",
        createdAt: 1,
        updatedAt: 1,
      });
      const body = await json("/api/people/grouped?drafts=1", member);
      expect(body.data).toEqual([]);
    });

    it("GET /api/people/{id}: a member gets an explicit projection with timestamps from visible mail only", async () => {
      const { member } = await users();
      await email("x-granted", GRANTED, T_GRANTED, { personId: "p-both" });
      await email("x-private", PRIVATE, T_PRIVATE, { personId: "p-both" });
      await getDb()
        .update(people)
        .set({ createdAt: 1, updatedAt: T_PRIVATE + 99 })
        .where(eq(people.id, "p-both"));
      const body = await json("/api/people/p-both", member);
      expect(body).toEqual({
        id: "p-both",
        email: "both@example.com",
        name: expect.anything(),
        lastEmailAt: T_GRANTED,
        unreadCount: 1,
        totalCount: 1,
        createdAt: T_GRANTED,
        updatedAt: T_GRANTED,
      });
    });

    it("GET /api/people/{id}: a contact the member only sent mail to is found, as in the grouped list", async () => {
      const { member } = await users();
      await createTestPerson({ id: "p-sent", email: "sent-only@example.com" });
      await createTestSentEmail({
        id: "s-granted",
        personId: "p-sent",
        fromAddress: GRANTED,
        toAddress: "sent-only@example.com",
        sentAt: T_GRANTED,
      });
      await createTestSentEmail({
        id: "s-private",
        personId: "p-sent",
        fromAddress: PRIVATE,
        toAddress: "sent-only@example.com",
        sentAt: T_PRIVATE,
      });
      const grouped = await json("/api/people/grouped", member);
      expect(grouped.data.some((row: any) => row.id === "p-sent")).toBe(true);
      expect(await json("/api/people/p-sent", member)).toMatchObject({
        id: "p-sent",
        totalCount: 1,
        unreadCount: 0,
        lastEmailAt: T_GRANTED,
      });
    });
  });
});
