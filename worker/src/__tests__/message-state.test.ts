import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  applyMigrations,
  authFetch,
  cleanDb,
  createTestEmail,
  createTestPerson,
  createTestSentEmail,
  createTestUser,
  getDb,
} from "./helpers";
import { inboxPermissions } from "../db/inbox-permissions.schema";
import { messageUserState } from "../db/message-user-state.schema";
import { mailboxMessageState } from "../db/mailbox-message-state.schema";
import { mailboxes } from "../db/mailboxes.schema";
import { messageMailboxes } from "../db/message-mailboxes.schema";
import { sentEmails } from "../db/sent-emails.schema";
import { blocklist } from "../db/blocklist.schema";
import { deleteEmailWithAttachments } from "../lib/delete-email";
import { purgeBlockedMail } from "../lib/purge-blocked";
import {
  createMailbox,
  deleteMailbox,
  InvalidMessageStateError,
  MessageStateAccessError,
  setMailboxMembership,
  setMailboxState,
  setUserState,
} from "../lib/messages/state";

describe("message state services", () => {
  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDb();
  });

  async function seedMessages() {
    await createTestPerson({
      id: "state-person",
      email: "person@example.com",
    });
    await createTestEmail({
      id: "state-received",
      personId: "state-person",
      recipient: "support@saasmail.test",
      messageId: "state-received@example.com",
    });
    await createTestSentEmail({
      id: "state-sent",
      personId: "state-person",
      fromAddress: "support@saasmail.test",
      toAddress: "person@example.com",
    });
  }

  it("rejects archived and spam state on sent messages", async () => {
    await createTestUser({
      id: "state-admin",
      role: "admin",
      email: "state-admin@example.com",
    });
    await seedMessages();
    const db = getDb();

    await expect(
      setMailboxState(
        db,
        { isAdmin: true },
        "state-admin",
        [{ kind: "sent", id: "state-sent" }],
        { archived: true },
      ),
    ).rejects.toBeInstanceOf(InvalidMessageStateError);

    await expect(
      setMailboxState(
        db,
        { isAdmin: true },
        "state-admin",
        [{ kind: "sent", id: "state-sent" }],
        { spam: true },
      ),
    ).rejects.toBeInstanceOf(InvalidMessageStateError);
  });

  it("treats seen changes on sent messages as a no-op", async () => {
    await createTestUser({
      id: "seen-admin",
      role: "admin",
      email: "seen-admin@example.com",
    });
    await seedMessages();
    const db = getDb();

    await setUserState(db, "seen-admin", [{ kind: "sent", id: "state-sent" }], {
      seen: false,
    });

    const rows = await db
      .select()
      .from(messageUserState)
      .where(eq(messageUserState.userId, "seen-admin"));
    expect(rows).toEqual([]);
  });

  it("preserves sent seen_at in a mixed seen/starred batch", async () => {
    await createTestUser({
      id: "mixed-state-admin",
      role: "admin",
      email: "mixed-state-admin@example.com",
    });
    await seedMessages();
    const db = getDb();

    await db.insert(messageUserState).values({
      userId: "mixed-state-admin",
      messageKind: "sent",
      messageId: "state-sent",
      seenAt: 123,
      starredAt: null,
      updatedAt: 123,
    });

    await setUserState(
      db,
      "mixed-state-admin",
      [
        { kind: "received", id: "state-received" },
        { kind: "sent", id: "state-sent" },
      ],
      { seen: true, starred: true },
    );

    const rows = await db
      .select()
      .from(messageUserState)
      .where(eq(messageUserState.userId, "mixed-state-admin"));
    const byId = new Map(rows.map((row) => [row.messageId, row]));

    expect(byId.get("state-received")?.seenAt).not.toBeNull();
    expect(byId.get("state-received")?.starredAt).not.toBeNull();
    expect(byId.get("state-sent")?.seenAt).toBe(123);
    expect(byId.get("state-sent")?.starredAt).not.toBeNull();
  });

  it("bootstraps seen state from legacy is_read when first creating a personal row", async () => {
    await createTestUser({
      id: "bootstrap-admin",
      role: "admin",
      email: "bootstrap-admin@example.com",
    });
    await createTestPerson({
      id: "bootstrap-person",
      email: "bootstrap@example.com",
    });
    await createTestEmail({
      id: "legacy-read",
      personId: "bootstrap-person",
      recipient: "support@saasmail.test",
      messageId: "legacy-read@example.com",
      isRead: 1,
    });
    await createTestEmail({
      id: "legacy-unread",
      personId: "bootstrap-person",
      recipient: "support@saasmail.test",
      messageId: "legacy-unread@example.com",
      isRead: 0,
    });

    const db = getDb();
    await setUserState(
      db,
      "bootstrap-admin",
      [
        { kind: "received", id: "legacy-read" },
        { kind: "received", id: "legacy-unread" },
      ],
      { starred: true },
    );

    const rows = await db
      .select()
      .from(messageUserState)
      .where(eq(messageUserState.userId, "bootstrap-admin"));
    const byId = new Map(rows.map((row) => [row.messageId, row]));
    expect(byId.get("legacy-read")?.seenAt).not.toBeNull();
    expect(byId.get("legacy-unread")?.seenAt).toBeNull();
  });

  it("writes personal state only for the caller", async () => {
    await createTestUser({
      id: "personal-a",
      role: "admin",
      email: "personal-a@example.com",
    });
    await createTestUser({
      id: "personal-b",
      role: "admin",
      email: "personal-b@example.com",
    });
    await seedMessages();

    const db = getDb();
    await setUserState(
      db,
      "personal-a",
      [{ kind: "received", id: "state-received" }],
      { starred: true },
    );

    const rows = await db.select().from(messageUserState);
    expect(rows).toHaveLength(1);
    expect(rows[0].userId).toBe("personal-a");
    expect(rows[0].starredAt).not.toBeNull();
  });

  it("denies shared state outside a member's inbox and allows admin", async () => {
    await createTestUser({
      id: "state-member",
      role: "member",
      email: "state-member@example.com",
    });
    await createTestUser({
      id: "state-admin-2",
      role: "admin",
      email: "state-admin-2@example.com",
    });
    await createTestPerson({
      id: "billing-person",
      email: "billing-person@example.com",
    });
    await createTestEmail({
      id: "billing-message",
      personId: "billing-person",
      recipient: "billing@saasmail.test",
      messageId: "billing-message@example.com",
    });

    const db = getDb();
    await expect(
      setMailboxState(
        db,
        { isAdmin: false, inboxes: ["support@saasmail.test"] },
        "state-member",
        [{ kind: "received", id: "billing-message" }],
        { trashed: true },
      ),
    ).rejects.toBeInstanceOf(MessageStateAccessError);

    await setMailboxState(
      db,
      { isAdmin: true },
      "state-admin-2",
      [{ kind: "received", id: "billing-message" }],
      { trashed: true },
    );
    const rows = await db.select().from(mailboxMessageState);
    expect(rows).toHaveLength(1);
    expect(rows[0].inbox).toBe("billing@saasmail.test");
    expect(rows[0].updatedBy).toBe("state-admin-2");
  });

  it("archives 150 message refs in one call", async () => {
    await createTestUser({
      id: "bulk-archive-admin",
      role: "admin",
      email: "bulk-archive-admin@example.com",
    });
    await createTestPerson({
      id: "bulk-archive-person",
      email: "bulk-archive@example.com",
    });

    const refs = Array.from({ length: 150 }, (_, index) => ({
      kind: "received" as const,
      id: `bulk-archive-${index}`,
    }));
    for (const [index, ref] of refs.entries()) {
      await createTestEmail({
        id: ref.id,
        personId: "bulk-archive-person",
        recipient: "support@saasmail.test",
        messageId: `bulk-archive-${index}@example.com`,
      });
    }

    const db = getDb();
    await setMailboxState(db, { isAdmin: true }, "bulk-archive-admin", refs, {
      archived: true,
    });

    const rows = await db.select().from(mailboxMessageState);
    expect(rows).toHaveLength(150);
    expect(rows.every((row) => row.archivedAt !== null)).toBe(true);
  });

  it("keeps archived, spam, and trashed timestamps independent", async () => {
    await createTestUser({
      id: "precedence-admin",
      role: "admin",
      email: "precedence-admin@example.com",
    });
    await seedMessages();
    const db = getDb();
    const ref = [{ kind: "received" as const, id: "state-received" }];

    await setMailboxState(db, { isAdmin: true }, "precedence-admin", ref, {
      archived: true,
    });
    await setMailboxState(db, { isAdmin: true }, "precedence-admin", ref, {
      spam: true,
    });
    await setMailboxState(db, { isAdmin: true }, "precedence-admin", ref, {
      trashed: true,
    });

    let [row] = await db.select().from(mailboxMessageState);
    expect(row.archivedAt).not.toBeNull();
    expect(row.spamAt).not.toBeNull();
    expect(row.trashedAt).not.toBeNull();

    await setMailboxState(db, { isAdmin: true }, "precedence-admin", ref, {
      trashed: false,
    });
    [row] = await db.select().from(mailboxMessageState);
    expect(row.trashedAt).toBeNull();
    expect(row.spamAt).not.toBeNull();
    expect(row.archivedAt).not.toBeNull();
  });

  it("enforces root mailbox uniqueness without over-constraining children or inboxes", async () => {
    await createTestUser({
      id: "folder-admin",
      role: "admin",
      email: "folder-admin@example.com",
    });
    const db = getDb();
    const allowed = { isAdmin: true } as const;

    await createMailbox(db, allowed, "folder-admin", {
      inbox: "support@saasmail.test",
      name: "Projects",
    });
    await expect(
      createMailbox(db, allowed, "folder-admin", {
        inbox: "support@saasmail.test",
        name: "Projects",
      }),
    ).rejects.toThrow();

    const parentA = await createMailbox(db, allowed, "folder-admin", {
      inbox: "support@saasmail.test",
      name: "Parent A",
    });
    const parentB = await createMailbox(db, allowed, "folder-admin", {
      inbox: "support@saasmail.test",
      name: "Parent B",
    });
    await createMailbox(db, allowed, "folder-admin", {
      inbox: "support@saasmail.test",
      name: "Projects",
      parentId: parentA.id,
    });
    await createMailbox(db, allowed, "folder-admin", {
      inbox: "support@saasmail.test",
      name: "Projects",
      parentId: parentB.id,
    });
    await createMailbox(db, allowed, "folder-admin", {
      inbox: "billing@saasmail.test",
      name: "Projects",
    });
  });

  it("rejects cross-inbox mailbox membership", async () => {
    await createTestUser({
      id: "membership-admin",
      role: "admin",
      email: "membership-admin@example.com",
    });
    await seedMessages();
    const db = getDb();
    const billing = await createMailbox(
      db,
      { isAdmin: true },
      "membership-admin",
      { inbox: "billing@saasmail.test", name: "Billing" },
    );

    await expect(
      setMailboxMembership(
        db,
        { isAdmin: true },
        "membership-admin",
        [{ kind: "received", id: "state-received" }],
        { add: [billing.id] },
      ),
    ).rejects.toBeInstanceOf(MessageStateAccessError);
  });

  it("deleting a mailbox cascades to children and memberships", async () => {
    await createTestUser({
      id: "cascade-admin",
      role: "admin",
      email: "cascade-admin@example.com",
    });
    await seedMessages();
    const db = getDb();
    const root = await createMailbox(db, { isAdmin: true }, "cascade-admin", {
      inbox: "support@saasmail.test",
      name: "Root",
    });
    const child = await createMailbox(db, { isAdmin: true }, "cascade-admin", {
      inbox: "support@saasmail.test",
      name: "Child",
      parentId: root.id,
    });
    await setMailboxMembership(
      db,
      { isAdmin: true },
      "cascade-admin",
      [{ kind: "received", id: "state-received" }],
      { add: [child.id] },
    );

    await deleteMailbox(db, { isAdmin: true }, "cascade-admin", root.id);

    expect(await db.select().from(mailboxes)).toEqual([]);
    expect(await db.select().from(messageMailboxes)).toEqual([]);
  });

  it("rejects bogus message_kind values in all constrained state tables", async () => {
    await createTestUser({
      id: "trigger-user",
      role: "admin",
      email: "trigger-user@example.com",
    });
    const db = getDb();
    const mailbox = await createMailbox(db, { isAdmin: true }, "trigger-user", {
      inbox: "support@saasmail.test",
      name: "Trigger",
    });

    await expect(
      env.DB.prepare(
        "INSERT INTO message_user_state (user_id,message_kind,message_id,updated_at) VALUES (?,?,?,?)",
      )
        .bind("trigger-user", "bogus", "x", 1)
        .run(),
    ).rejects.toThrow("invalid message_kind");

    await expect(
      env.DB.prepare(
        "INSERT INTO mailbox_message_state (inbox,message_kind,message_id,updated_at) VALUES (?,?,?,?)",
      )
        .bind("support@saasmail.test", "bogus", "x", 1)
        .run(),
    ).rejects.toThrow("invalid message_kind");

    await expect(
      env.DB.prepare(
        "INSERT INTO message_mailboxes (message_kind,message_id,mailbox_id,added_at) VALUES (?,?,?,?)",
      )
        .bind("bogus", "x", mailbox.id, 1)
        .run(),
    ).rejects.toThrow("invalid message_kind");
  });

  it("requires personal-state callers to have access to the message inbox", async () => {
    const { userId } = await createTestUser({
      id: "personal-member",
      role: "member",
      email: "personal-member@example.com",
    });
    await createTestPerson({
      id: "private-person",
      email: "private-person@example.com",
    });
    await createTestEmail({
      id: "private-message",
      personId: "private-person",
      recipient: "private@saasmail.test",
      messageId: "private-message@example.com",
    });
    await getDb().insert(inboxPermissions).values({
      userId,
      email: "support@saasmail.test",
      createdAt: 1,
      createdBy: null,
    });

    await expect(
      setUserState(
        getDb(),
        userId,
        [{ kind: "received", id: "private-message" }],
        { starred: true },
      ),
    ).rejects.toBeInstanceOf(MessageStateAccessError);
  });

  it("records memberships only for matching inboxes", async () => {
    await createTestUser({
      id: "membership-ok-admin",
      role: "admin",
      email: "membership-ok-admin@example.com",
    });
    await seedMessages();
    const db = getDb();
    const folder = await createMailbox(
      db,
      { isAdmin: true },
      "membership-ok-admin",
      { inbox: "support@saasmail.test", name: "Projects" },
    );

    await setMailboxMembership(
      db,
      { isAdmin: true },
      "membership-ok-admin",
      [
        { kind: "received", id: "state-received" },
        { kind: "sent", id: "state-sent" },
      ],
      { add: [folder.id] },
    );

    const rows = await db
      .select()
      .from(messageMailboxes)
      .where(eq(messageMailboxes.mailboxId, folder.id));
    expect(rows).toHaveLength(2);
    expect(
      rows.some(
        (row) =>
          row.messageKind === "received" && row.messageId === "state-received",
      ),
    ).toBe(true);
    expect(
      rows.some(
        (row) => row.messageKind === "sent" && row.messageId === "state-sent",
      ),
    ).toBe(true);
  });

  async function seedAllMessageState(
    userId: string,
    refs: Array<{ kind: "received" | "sent"; id: string }>,
    inbox = "support@saasmail.test",
  ) {
    const db = getDb();
    await setUserState(db, userId, refs, { starred: true });
    await setMailboxState(db, { isAdmin: true }, userId, refs, {
      trashed: true,
    });
    const folder = await createMailbox(db, { isAdmin: true }, userId, {
      inbox,
      name: `State ${refs.map((ref) => ref.id).join("-")}`,
    });
    await setMailboxMembership(db, { isAdmin: true }, userId, refs, {
      add: [folder.id],
    });
  }

  async function expectNoMessageState(
    refs: Array<{ kind: "received" | "sent"; id: string }>,
  ) {
    const db = getDb();
    for (const ref of refs) {
      expect(
        await db
          .select()
          .from(messageUserState)
          .where(
            and(
              eq(messageUserState.messageKind, ref.kind),
              eq(messageUserState.messageId, ref.id),
            ),
          ),
      ).toEqual([]);
      expect(
        await db
          .select()
          .from(mailboxMessageState)
          .where(
            and(
              eq(mailboxMessageState.messageKind, ref.kind),
              eq(mailboxMessageState.messageId, ref.id),
            ),
          ),
      ).toEqual([]);
      expect(
        await db
          .select()
          .from(messageMailboxes)
          .where(
            and(
              eq(messageMailboxes.messageKind, ref.kind),
              eq(messageMailboxes.messageId, ref.id),
            ),
          ),
      ).toEqual([]);
    }
  }

  it("deleteEmailWithAttachments removes received-message state", async () => {
    await createTestUser({
      id: "delete-received-admin",
      role: "admin",
      email: "delete-received-admin@example.com",
    });
    await createTestPerson({
      id: "delete-received-person",
      email: "delete-received@example.com",
    });
    await createTestEmail({
      id: "delete-received",
      personId: "delete-received-person",
      recipient: "support@saasmail.test",
      messageId: "delete-received@example.com",
    });
    const refs = [{ kind: "received" as const, id: "delete-received" }];
    await seedAllMessageState("delete-received-admin", refs);

    const result = await deleteEmailWithAttachments(
      getDb(),
      env.R2,
      "delete-received",
      { isAdmin: true },
    );
    expect(result?.success).toBe(true);
    await expectNoMessageState(refs);
  });

  it("deleteEmailWithAttachments removes sent-message state", async () => {
    await createTestUser({
      id: "delete-sent-admin",
      role: "admin",
      email: "delete-sent-admin@example.com",
    });
    await createTestPerson({
      id: "delete-sent-person",
      email: "delete-sent@example.com",
    });
    await createTestSentEmail({
      id: "delete-sent",
      personId: "delete-sent-person",
      fromAddress: "support@saasmail.test",
      toAddress: "delete-sent@example.com",
    });
    const refs = [{ kind: "sent" as const, id: "delete-sent" }];
    await seedAllMessageState("delete-sent-admin", refs);

    const result = await deleteEmailWithAttachments(
      getDb(),
      env.R2,
      "delete-sent",
      { isAdmin: true },
    );
    expect(result?.success).toBe(true);
    await expectNoMessageState(refs);
  });

  it("purgeBlockedMail removes state for received and direct-deleted sent rows", async () => {
    await createTestUser({
      id: "purge-state-admin",
      role: "admin",
      email: "purge-state-admin@example.com",
    });
    await createTestPerson({
      id: "purge-state-person",
      email: "blocked-state@example.com",
    });
    await createTestEmail({
      id: "purge-state-received",
      personId: "purge-state-person",
      recipient: "support@saasmail.test",
      messageId: "purge-state-received@example.com",
    });
    await createTestSentEmail({
      id: "purge-state-sent",
      personId: "purge-state-person",
      fromAddress: "support@saasmail.test",
      toAddress: "blocked-state@example.com",
    });

    const refs = [
      { kind: "received" as const, id: "purge-state-received" },
      { kind: "sent" as const, id: "purge-state-sent" },
    ];
    await seedAllMessageState("purge-state-admin", refs);
    await getDb().insert(blocklist).values({
      id: "purge-state-rule",
      type: "email",
      value: "blocked-state@example.com",
      note: null,
      createdBy: null,
      createdAt: 1,
    });

    await purgeBlockedMail(getDb(), env.R2);
    await expectNoMessageState(refs);
  });

  it("person hard-delete removes state for all received and sent rows", async () => {
    const { apiKey } = await createTestUser({
      id: "person-delete-state-admin",
      role: "admin",
      email: "person-delete-state-admin@example.com",
    });
    await createTestPerson({
      id: "person-delete-state-person",
      email: "person-delete-state@example.com",
    });
    await createTestEmail({
      id: "person-delete-state-received",
      personId: "person-delete-state-person",
      recipient: "support@saasmail.test",
      messageId: "person-delete-state-received@example.com",
    });
    await createTestSentEmail({
      id: "person-delete-state-sent",
      personId: "person-delete-state-person",
      fromAddress: "support@saasmail.test",
      toAddress: "person-delete-state@example.com",
    });

    const refs = [
      { kind: "received" as const, id: "person-delete-state-received" },
      { kind: "sent" as const, id: "person-delete-state-sent" },
    ];
    await seedAllMessageState("person-delete-state-admin", refs);

    const res = await authFetch("/api/people/person-delete-state-person", {
      apiKey,
      method: "DELETE",
    });
    expect(res.status).toBe(200);
    await expectNoMessageState(refs);
  });

  it("batches a 500-message move into three folders without N+1 writes", async () => {
    await createTestUser({
      id: "bulk-state-admin",
      role: "admin",
      email: "bulk-state-admin@example.com",
    });
    const db = getDb();
    const now = Math.floor(Date.now() / 1000);
    const inbox = "support@saasmail.test";
    const rows = Array.from({ length: 500 }, (_, i) => ({
      id: `bulk-sent-${i}`,
      personId: null,
      fromAddress: inbox,
      toAddress: `recipient-${i}@example.com`,
      subject: `Bulk ${i}`,
      status: "sent",
      sentAt: now,
      createdAt: now,
    }));
    for (let start = 0; start < rows.length; start += 10) {
      await db.insert(sentEmails).values(rows.slice(start, start + 10));
    }

    const folders = [];
    for (const name of ["One", "Two", "Three"]) {
      folders.push(
        await createMailbox(db, { isAdmin: true }, "bulk-state-admin", {
          inbox,
          name,
        }),
      );
    }

    const refs = rows.map((row) => ({ kind: "sent" as const, id: row.id }));
    const batchSpy = vi.spyOn(db, "batch");
    await setMailboxMembership(
      db,
      { isAdmin: true },
      "bulk-state-admin",
      refs,
      { add: folders.map((folder) => folder.id) },
    );

    expect(await db.select().from(messageMailboxes)).toHaveLength(1500);
    expect(batchSpy).toHaveBeenCalledTimes(3);
  });
});
