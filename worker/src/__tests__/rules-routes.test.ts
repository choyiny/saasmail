import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { inboxConversationState } from "../db/inbox-conversation-state.schema";
import { inboxPermissions } from "../db/inbox-permissions.schema";
import { mailboxMessageState } from "../db/mailbox-message-state.schema";
import { mailboxes } from "../db/mailboxes.schema";
import { rules } from "../db/rules.schema";
import {
  applyMigrations,
  authFetch,
  cleanDb,
  createTestEmail,
  createTestPerson,
  createTestUser,
  getDb,
} from "./helpers";

const INBOX = "support@saasmail.test";
const OTHER = "other@saasmail.test";

beforeAll(async () => {
  await applyMigrations();
});

beforeEach(async () => {
  await cleanDb();
});

async function grant(userId: string, inbox: string) {
  await getDb()
    .insert(inboxPermissions)
    .values({
      userId,
      email: inbox,
      createdAt: Math.floor(Date.now() / 1000),
      createdBy: null,
    });
}

function ruleBody(overrides: Record<string, unknown> = {}) {
  return {
    name: "Route rule",
    inbox: INBOX,
    conditions: [{ field: "subject", operator: "contains", value: "invoice" }],
    actions: [{ type: "archive" }],
    position: 0,
    ...overrides,
  };
}

async function seedReorderRules() {
  const now = Math.floor(Date.now() / 1000);
  await getDb()
    .insert(rules)
    .values([
      {
        id: "reorder-a",
        name: "A",
        inbox: INBOX,
        trigger: "message.received",
        conditions: [],
        actions: [{ type: "archive" }],
        position: 0,
        stopProcessing: 0,
        enabled: 1,
        matchCount: 0,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: "reorder-b",
        name: "B",
        inbox: INBOX,
        trigger: "message.received",
        conditions: [],
        actions: [{ type: "archive" }],
        position: 1,
        stopProcessing: 0,
        enabled: 1,
        matchCount: 0,
        createdAt: now,
        updatedAt: now,
      },
    ]);
}

describe("admin rule routes", () => {
  it("supports create, list, update, reorder, and delete", async () => {
    const admin = await createTestUser({
      id: "rules-admin",
      role: "admin",
      email: "rules-admin@example.com",
    });
    let res = await authFetch("/api/admin/rules", {
      apiKey: admin.apiKey,
      method: "POST",
      body: JSON.stringify(ruleBody()),
    });
    expect(res.status).toBe(201);
    const first = (await res.json()) as { id: string };

    res = await authFetch("/api/admin/rules", {
      apiKey: admin.apiKey,
      method: "POST",
      body: JSON.stringify(ruleBody({ name: "Second", position: 1 })),
    });
    expect(res.status).toBe(201);
    const second = (await res.json()) as { id: string };

    res = await authFetch(`/api/admin/rules/${first.id}`, {
      apiKey: admin.apiKey,
      method: "PATCH",
      body: JSON.stringify({ enabled: false }),
    });
    expect(res.status).toBe(200);

    res = await authFetch("/api/admin/rules/reorder", {
      apiKey: admin.apiKey,
      method: "POST",
      body: JSON.stringify({ ids: [second.id, first.id] }),
    });
    expect(res.status).toBe(200);

    res = await authFetch("/api/admin/rules", { apiKey: admin.apiKey });
    expect(res.status).toBe(200);
    const listed = (await res.json()) as Array<{ id: string }>;
    expect(listed.map((row) => row.id)).toEqual([second.id, first.id]);

    res = await authFetch(`/api/admin/rules/${first.id}`, {
      apiKey: admin.apiKey,
      method: "DELETE",
    });
    expect(res.status).toBe(200);
  });

  it("rejects a partial reorder", async () => {
    const admin = await createTestUser({
      id: "reorder-partial-admin",
      role: "admin",
    });
    await seedReorderRules();

    const res = await authFetch("/api/admin/rules/reorder", {
      apiKey: admin.apiKey,
      method: "POST",
      body: JSON.stringify({ ids: ["reorder-a"] }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects duplicate ids in a reorder", async () => {
    const admin = await createTestUser({
      id: "reorder-duplicate-admin",
      role: "admin",
    });
    await seedReorderRules();

    const res = await authFetch("/api/admin/rules/reorder", {
      apiKey: admin.apiKey,
      method: "POST",
      body: JSON.stringify({ ids: ["reorder-a", "reorder-a"] }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects unknown ids in a reorder", async () => {
    const admin = await createTestUser({
      id: "reorder-unknown-admin",
      role: "admin",
    });
    await seedReorderRules();

    const res = await authFetch("/api/admin/rules/reorder", {
      apiKey: admin.apiKey,
      method: "POST",
      body: JSON.stringify({ ids: ["reorder-a", "missing-rule"] }),
    });
    expect(res.status).toBe(400);
  });

  it("is admin-only", async () => {
    const member = await createTestUser({
      id: "rules-member",
      role: "member",
      email: "rules-member@example.com",
    });
    await grant(member.userId, INBOX);
    const res = await authFetch("/api/admin/rules", {
      apiKey: member.apiKey,
    });
    expect(res.status).toBe(403);
  });

  it("rejects a missing folder", async () => {
    const admin = await createTestUser({
      id: "missing-folder-admin",
      role: "admin",
    });
    const res = await authFetch("/api/admin/rules", {
      apiKey: admin.apiKey,
      method: "POST",
      body: JSON.stringify(
        ruleBody({
          actions: [{ type: "move_to_folder", mailboxId: "missing-folder" }],
        }),
      ),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "move_to_folder mailbox must belong to the rule inbox",
    });
  });

  it("surfaces dangling warnings and mailbox rule counts", async () => {
    const admin = await createTestUser({
      id: "warning-admin",
      role: "admin",
      email: "warning-admin@example.com",
    });
    const assignee = await createTestUser({
      id: "warning-assignee",
      role: "member",
      email: "warning-assignee@example.com",
    });
    await grant(assignee.userId, INBOX);
    const now = Math.floor(Date.now() / 1000);
    await getDb().insert(mailboxes).values({
      id: "warning-folder",
      inbox: INBOX,
      name: "Warnings",
      role: null,
      sortOrder: 0,
      createdAt: now,
      updatedAt: now,
    });

    let res = await authFetch("/api/admin/rules", {
      apiKey: admin.apiKey,
      method: "POST",
      body: JSON.stringify(
        ruleBody({
          name: "Folder warning",
          actions: [{ type: "move_to_folder", mailboxId: "warning-folder" }],
        }),
      ),
    });
    expect(res.status).toBe(201);
    const folderRule = (await res.json()) as { id: string };

    res = await authFetch("/api/admin/rules", {
      apiKey: admin.apiKey,
      method: "POST",
      body: JSON.stringify(
        ruleBody({
          name: "Assignee warning",
          position: 1,
          actions: [{ type: "assign", userId: assignee.userId }],
        }),
      ),
    });
    expect(res.status).toBe(201);
    const assigneeRule = (await res.json()) as { id: string };

    res = await authFetch(`/api/mailboxes?inbox=${encodeURIComponent(INBOX)}`, {
      apiKey: admin.apiKey,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      mailboxes: [
        expect.objectContaining({ id: "warning-folder", ruleCount: 1 }),
      ],
    });

    await getDb().delete(mailboxes).where(eq(mailboxes.id, "warning-folder"));
    await getDb()
      .delete(inboxPermissions)
      .where(
        and(
          eq(inboxPermissions.userId, assignee.userId),
          eq(inboxPermissions.email, INBOX),
        ),
      );

    res = await authFetch("/api/admin/rules", { apiKey: admin.apiKey });
    expect(res.status).toBe(200);
    const listed = (await res.json()) as Array<{
      id: string;
      warnings: Array<{ actionIndex: number; code: string }>;
    }>;
    expect(listed.find((row) => row.id === folderRule.id)?.warnings).toEqual([
      { actionIndex: 0, code: "missing_folder" },
    ]);
    expect(listed.find((row) => row.id === assigneeRule.id)?.warnings).toEqual([
      { actionIndex: 0, code: "assignee_unavailable" },
    ]);

    res = await authFetch(`/api/admin/rules/${folderRule.id}`, {
      apiKey: admin.apiKey,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      id: folderRule.id,
      warnings: [{ actionIndex: 0, code: "missing_folder" }],
    });
  });

  it("rejects a folder from another inbox", async () => {
    const admin = await createTestUser({ id: "folder-admin", role: "admin" });
    const now = Math.floor(Date.now() / 1000);
    await getDb().insert(mailboxes).values({
      id: "other-folder",
      inbox: OTHER,
      name: "Other",
      role: null,
      sortOrder: 0,
      createdAt: now,
      updatedAt: now,
    });
    const res = await authFetch("/api/admin/rules", {
      apiKey: admin.apiKey,
      method: "POST",
      body: JSON.stringify(
        ruleBody({
          actions: [{ type: "move_to_folder", mailboxId: "other-folder" }],
        }),
      ),
    });
    expect(res.status).toBe(400);
  });

  it("rejects an assignee without access and all-inboxes assignment", async () => {
    const admin = await createTestUser({
      id: "assign-admin",
      role: "admin",
      email: "assign-admin@example.com",
    });
    const assignee = await createTestUser({
      id: "no-access-user",
      role: "member",
      email: "no-access@example.com",
    });

    let res = await authFetch("/api/admin/rules", {
      apiKey: admin.apiKey,
      method: "POST",
      body: JSON.stringify(
        ruleBody({
          actions: [{ type: "assign", userId: assignee.userId }],
        }),
      ),
    });
    expect(res.status).toBe(400);

    await grant(assignee.userId, INBOX);
    res = await authFetch("/api/admin/rules", {
      apiKey: admin.apiKey,
      method: "POST",
      body: JSON.stringify(
        ruleBody({
          inbox: null,
          actions: [{ type: "assign", userId: assignee.userId }],
        }),
      ),
    });
    expect(res.status).toBe(400);
  });

  it("rejects all-inboxes and duplicate auto-reply actions", async () => {
    const admin = await createTestUser({
      id: "auto-reply-validation-admin",
      role: "admin",
    });

    let res = await authFetch("/api/admin/rules", {
      apiKey: admin.apiKey,
      method: "POST",
      body: JSON.stringify(
        ruleBody({
          inbox: null,
          actions: [{ type: "auto_reply", bodyText: "Hello" }],
        }),
      ),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "auto_reply requires an inbox-scoped rule",
    });

    res = await authFetch("/api/admin/rules", {
      apiKey: admin.apiKey,
      method: "POST",
      body: JSON.stringify(
        ruleBody({
          actions: [
            { type: "auto_reply", bodyText: "First" },
            { type: "auto_reply", bodyText: "Second" },
          ],
        }),
      ),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "A rule may have at most one auto_reply action",
    });
  });

  it("rejects more than ten conditions", async () => {
    const admin = await createTestUser({ id: "limit-admin", role: "admin" });
    const conditions = Array.from({ length: 11 }, () => ({
      field: "subject",
      operator: "contains",
      value: "x",
    }));
    const res = await authFetch("/api/admin/rules", {
      apiKey: admin.apiKey,
      method: "POST",
      body: JSON.stringify(ruleBody({ conditions })),
    });
    expect(res.status).toBe(400);
  });

  it("dry-runs conditions without saving a rule or running actions", async () => {
    const admin = await createTestUser({ id: "dry-admin", role: "admin" });
    await createTestPerson({ id: "dry-person", email: "alice@example.com" });
    await createTestEmail({
      id: "dry-email",
      personId: "dry-person",
      recipient: INBOX,
      subject: "Invoice attached",
      rawHeaders: JSON.stringify({ "X-Source": "Portal" }),
    });

    const res = await authFetch("/api/admin/rules/test", {
      apiKey: admin.apiKey,
      method: "POST",
      body: JSON.stringify({
        rule: {
          conditions: [
            {
              field: "header",
              name: "x-source",
              operator: "equals",
              value: "portal",
            },
          ],
          actions: [{ type: "mark_spam" }],
        },
        emailId: "dry-email",
      }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      matched: true,
      conditionResults: [{ matched: true }],
    });
    expect(await getDb().select().from(rules)).toHaveLength(0);
    expect(await getDb().select().from(mailboxMessageState)).toHaveLength(0);
  });
});

describe("conversation assignment routes and filters", () => {
  it("assigns, returns assignedUserId, supports assignedTo id/me, and unassigns", async () => {
    const caller = await createTestUser({
      id: "assign-caller",
      role: "member",
      email: "caller@example.com",
    });
    const assignee = await createTestUser({
      id: "assign-target",
      role: "member",
      email: "target@example.com",
    });
    await grant(caller.userId, INBOX);
    await grant(assignee.userId, INBOX);
    await createTestPerson({
      id: "assign-person",
      email: "person@example.com",
    });
    await createTestEmail({
      id: "assign-message",
      personId: "assign-person",
      recipient: INBOX,
      messageId: "assign-route@example.com",
    });

    let res = await authFetch("/api/messages/assign", {
      apiKey: caller.apiKey,
      method: "POST",
      body: JSON.stringify({
        refs: ["received:assign-message"],
        userId: assignee.userId,
      }),
    });
    expect(res.status).toBe(200);

    res = await authFetch(
      `/api/messages?assignedTo=${encodeURIComponent(assignee.userId)}`,
      { apiKey: caller.apiKey },
    );
    expect(res.status).toBe(200);
    let body = (await res.json()) as {
      messages: Array<{
        ref: string;
        state?: { assignedUserId: string | null };
      }>;
    };
    expect(body.messages).toEqual([
      expect.objectContaining({
        ref: "received:assign-message",
        state: expect.objectContaining({ assignedUserId: assignee.userId }),
      }),
    ]);

    res = await authFetch("/api/messages?assignedTo=me", {
      apiKey: assignee.apiKey,
    });
    body = (await res.json()) as typeof body;
    expect(body.messages.map((message) => message.ref)).toEqual([
      "received:assign-message",
    ]);

    res = await authFetch("/api/messages/assign", {
      apiKey: caller.apiKey,
      method: "POST",
      body: JSON.stringify({
        refs: ["received:assign-message"],
        userId: null,
      }),
    });
    expect(res.status).toBe(200);
    const [conversation] = await getDb()
      .select()
      .from(inboxConversationState)
      .where(eq(inboxConversationState.conversationKey, "p:assign-person"));
    expect(conversation.assignedUserId).toBeNull();
    expect(conversation.assignedAt).toBeNull();
  });

  it("requires caller access to every referenced inbox and makes no partial assignment", async () => {
    const caller = await createTestUser({
      id: "scope-caller",
      role: "member",
      email: "scope-caller@example.com",
    });
    const assignee = await createTestUser({
      id: "scope-target",
      role: "admin",
      email: "scope-target@example.com",
    });
    await grant(caller.userId, INBOX);
    await createTestPerson({ id: "scope-person-a", email: "a@example.com" });
    await createTestPerson({ id: "scope-person-b", email: "b@example.com" });
    await createTestEmail({
      id: "scope-a",
      personId: "scope-person-a",
      recipient: INBOX,
      messageId: "scope-a@example.com",
    });
    await createTestEmail({
      id: "scope-b",
      personId: "scope-person-b",
      recipient: OTHER,
      messageId: "scope-b@example.com",
    });

    const res = await authFetch("/api/messages/assign", {
      apiKey: caller.apiKey,
      method: "POST",
      body: JSON.stringify({
        refs: ["received:scope-a", "received:scope-b"],
        userId: assignee.userId,
      }),
    });
    expect(res.status).toBe(404);
    expect(await getDb().select().from(inboxConversationState)).toHaveLength(0);
  });
});
