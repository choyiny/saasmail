import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { handleEmail } from "../email-handler";
import { inboxConversationState } from "../db/inbox-conversation-state.schema";
import { inboxPermissions } from "../db/inbox-permissions.schema";
import { mailboxMessageState } from "../db/mailbox-message-state.schema";
import { mailboxes } from "../db/mailboxes.schema";
import { messageMailboxes } from "../db/message-mailboxes.schema";
import { rules } from "../db/rules.schema";
import { senderIdentities } from "../db/sender-identities.schema";
import type { RuleAction, RuleCondition } from "../lib/rules/types";
import {
  applyMigrations,
  cleanDb,
  createTestPerson,
  createTestUser,
  getDb,
} from "./helpers";

const INBOX = "support@saasmail.test";

beforeAll(async () => {
  await applyMigrations();
});

beforeEach(async () => {
  await cleanDb();
});

function inboundMessage(options: {
  inbox?: string;
  messageId: string;
  subject?: string;
  body?: string;
  spamScore?: number;
}): ForwardableEmailMessage {
  const inbox = options.inbox ?? INBOX;
  const headers = [
    "From: Customer <customer@example.com>",
    `To: ${inbox}`,
    `Subject: ${options.subject ?? "Rule test"}`,
    `Message-ID: <${options.messageId}>`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    ...(options.spamScore === undefined
      ? []
      : [`X-Spam-Score: ${options.spamScore}`]),
    "",
    options.body ?? "hello",
  ];
  const raw = new TextEncoder().encode(headers.join("\r\n"));
  return {
    from: "customer@example.com",
    to: inbox,
    raw: new Response(raw).body!,
    rawSize: raw.byteLength,
    headers: new Headers(),
    setReject() {},
    async forward() {},
    async reply() {},
  } as unknown as ForwardableEmailMessage;
}

function executionContext() {
  const pending: Promise<unknown>[] = [];
  const ctx = {
    waitUntil(promise: Promise<unknown>) {
      pending.push(Promise.resolve(promise));
    },
    passThroughOnException() {},
  } as unknown as ExecutionContext;
  return {
    ctx,
    async settle() {
      await Promise.allSettled(pending);
    },
  };
}

async function deliver(
  messageId: string,
  options: Omit<Parameters<typeof inboundMessage>[0], "messageId"> = {},
) {
  const { ctx, settle } = executionContext();
  await handleEmail(
    inboundMessage({ ...options, messageId }),
    env as unknown as CloudflareBindings,
    ctx,
  );
  await settle();
}

async function addRule(options: {
  id: string;
  inbox?: string | null;
  conditions?: RuleCondition[];
  actions: RuleAction[];
  position?: number;
  stopProcessing?: number;
  enabled?: number;
}) {
  const now = Math.floor(Date.now() / 1000);
  await getDb()
    .insert(rules)
    .values({
      id: options.id,
      name: options.id,
      inbox: options.inbox === undefined ? INBOX : options.inbox,
      trigger: "message.received",
      conditions: options.conditions ?? [],
      actions: options.actions,
      position: options.position ?? 0,
      stopProcessing: options.stopProcessing ?? 0,
      enabled: options.enabled ?? 1,
      matchCount: 0,
      createdAt: now,
      updatedAt: now,
    });
}

async function stateFor(ruleMessageId: string) {
  return getDb()
    .select()
    .from(mailboxMessageState)
    .where(eq(mailboxMessageState.messageId, ruleMessageId))
    .limit(1);
}

describe("inbound rule actions", () => {
  it("archives through mailbox state", async () => {
    await addRule({ id: "archive-rule", actions: [{ type: "archive" }] });
    await deliver("archive@example.com");
    const [state] = await stateFor(
      (await getDb().query.emails.findFirst({
        where: (email, { eq }) => eq(email.messageId, "<archive@example.com>"),
      }))!.id,
    );
    expect(state.archivedAt).toEqual(expect.any(Number));
    expect(state.updatedBy).toBeNull();
  });

  it("marks spam through mailbox state", async () => {
    await addRule({ id: "spam-rule", actions: [{ type: "mark_spam" }] });
    await deliver("spam-rule@example.com");
    const email = await getDb().query.emails.findFirst({
      where: (row, { eq }) => eq(row.messageId, "<spam-rule@example.com>"),
    });
    const [state] = await stateFor(email!.id);
    expect(state.spamAt).toEqual(expect.any(Number));
    expect(state.updatedBy).toBeNull();
  });

  it("moves to a custom folder", async () => {
    const now = Math.floor(Date.now() / 1000);
    await getDb().insert(mailboxes).values({
      id: "rule-folder",
      inbox: INBOX,
      name: "VIP",
      role: null,
      sortOrder: 0,
      createdAt: now,
      updatedAt: now,
    });
    await addRule({
      id: "folder-rule",
      actions: [{ type: "move_to_folder", mailboxId: "rule-folder" }],
    });
    await deliver("folder@example.com");
    const email = await getDb().query.emails.findFirst({
      where: (row, { eq }) => eq(row.messageId, "<folder@example.com>"),
    });
    const rows = await getDb()
      .select()
      .from(messageMailboxes)
      .where(eq(messageMailboxes.messageId, email!.id));
    expect(rows).toEqual([
      expect.objectContaining({ mailboxId: "rule-folder", addedBy: null }),
    ]);
  });

  it("snoozes the inbound conversation without the generic wake clearing it", async () => {
    await addRule({
      id: "snooze-rule",
      actions: [{ type: "snooze", hours: 2 }],
    });
    await deliver("snooze@example.com");
    const [row] = await getDb().select().from(inboxConversationState);
    expect(row.snoozedUntil).toBeGreaterThan(Math.floor(Date.now() / 1000));
    expect(row.snoozedBy).toBeNull();
  });

  it("assigns the conversation", async () => {
    const assignee = await createTestUser({
      id: "rules-assignee",
      role: "member",
      email: "assignee@example.com",
    });
    await getDb()
      .insert(inboxPermissions)
      .values({
        userId: assignee.userId,
        email: INBOX,
        createdAt: Math.floor(Date.now() / 1000),
        createdBy: null,
      });
    await addRule({
      id: "assign-rule",
      actions: [{ type: "assign", userId: assignee.userId }],
    });
    await deliver("assign@example.com");
    const [row] = await getDb().select().from(inboxConversationState);
    expect(row.assignedUserId).toBe(assignee.userId);
    expect(row.assignedAt).toEqual(expect.any(Number));
  });
});

describe("inbound rule evaluation semantics", () => {
  it("stops after a matching stop_processing rule", async () => {
    await addRule({
      id: "first-stop",
      actions: [{ type: "archive" }],
      position: 1,
      stopProcessing: 1,
    });
    await addRule({
      id: "second-spam",
      actions: [{ type: "mark_spam" }],
      position: 2,
    });
    await deliver("stop@example.com");
    const rows = await getDb().select().from(rules);
    expect(rows.find((row) => row.id === "first-stop")?.matchCount).toBe(1);
    expect(rows.find((row) => row.id === "second-spam")?.matchCount).toBe(0);
  });

  it("ignores disabled rules", async () => {
    await addRule({
      id: "disabled-rule",
      actions: [{ type: "mark_spam" }],
      enabled: 0,
    });
    await deliver("disabled@example.com");
    const row = await getDb().query.rules.findFirst({
      where: (rule, { eq }) => eq(rule.id, "disabled-rule"),
    });
    expect(row?.matchCount).toBe(0);
  });

  it("matches all-inboxes rules plus only the scoped rule for the recipient", async () => {
    await addRule({
      id: "global-rule",
      inbox: null,
      actions: [{ type: "archive" }],
      position: 1,
    });
    await addRule({
      id: "support-rule",
      inbox: INBOX.toUpperCase(),
      actions: [{ type: "archive" }],
      position: 2,
    });
    await addRule({
      id: "other-rule",
      inbox: "other@saasmail.test",
      actions: [{ type: "archive" }],
      position: 3,
    });
    await deliver("scope@example.com");
    const rows = await getDb().select().from(rules);
    expect(
      Object.fromEntries(rows.map((row) => [row.id, row.matchCount])),
    ).toMatchObject({
      "global-rule": 1,
      "support-rule": 1,
      "other-rule": 0,
    });
  });

  it("makes rule-spam silent and leaves an existing snooze untouched", async () => {
    const person = await createTestPerson({
      id: "rule-spam-person",
      email: "customer@example.com",
    });
    const now = Math.floor(Date.now() / 1000);
    const snoozedUntil = now + 3600;
    await getDb()
      .insert(inboxConversationState)
      .values({
        inbox: INBOX,
        conversationKey: `p:${person.id}`,
        snoozedUntil,
        snoozedBy: null,
        updatedAt: now,
      });
    await addRule({
      id: "silent-spam-rule",
      actions: [{ type: "mark_spam" }],
    });
    const getSpy = vi.spyOn(env.NOTIFICATIONS_HUB, "get");
    await deliver("silent-rule-spam@example.com");

    const [conversation] = await getDb()
      .select()
      .from(inboxConversationState)
      .where(eq(inboxConversationState.conversationKey, `p:${person.id}`));
    expect(conversation.snoozedUntil).toBe(snoozedUntil);
    expect(getSpy).not.toHaveBeenCalled();
    getSpy.mockRestore();
  });

  it("continues later actions when one action fails", async () => {
    await addRule({
      id: "failure-rule",
      actions: [
        { type: "move_to_folder", mailboxId: "missing-folder" },
        { type: "archive" },
      ],
    });
    await deliver("failure@example.com");
    const email = await getDb().query.emails.findFirst({
      where: (row, { eq }) => eq(row.messageId, "<failure@example.com>"),
    });
    const [state] = await stateFor(email!.id);
    expect(state.archivedAt).toEqual(expect.any(Number));
    const rule = await getDb().query.rules.findFirst({
      where: (row, { eq }) => eq(row.id, "failure-rule"),
    });
    expect(rule?.matchCount).toBe(1);
  });

  it("skips a malformed stored rule and continues with later rules", async () => {
    const now = Math.floor(Date.now() / 1000);
    await env.DB.prepare(
      `INSERT INTO rules (
        id, name, inbox, trigger, conditions, actions, position,
        stop_processing, enabled, match_count, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        "corrupt-rule",
        "Corrupt rule",
        INBOX,
        "message.received",
        JSON.stringify({ field: "subject" }),
        JSON.stringify([]),
        0,
        0,
        1,
        0,
        now,
        now,
      )
      .run();
    await addRule({
      id: "valid-after-corrupt",
      actions: [{ type: "archive" }],
      position: 1,
    });

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    await deliver("corrupt-rule@example.com");
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("[rules] skipping malformed rule corrupt-rule:"),
      expect.anything(),
    );
    warnSpy.mockRestore();

    const email = await getDb().query.emails.findFirst({
      where: (row, { eq }) => eq(row.messageId, "<corrupt-rule@example.com>"),
    });
    const [state] = await stateFor(email!.id);
    expect(state.archivedAt).toEqual(expect.any(Number));

    const rows = await getDb().select().from(rules);
    expect(rows.find((row) => row.id === "corrupt-rule")?.matchCount).toBe(0);
    expect(
      rows.find((row) => row.id === "valid-after-corrupt")?.matchCount,
    ).toBe(1);
  });

  it("skips rules for D21 auto-junked mail", async () => {
    const now = Math.floor(Date.now() / 1000);
    await getDb().insert(senderIdentities).values({
      email: INBOX,
      displayName: "Support",
      spamThreshold: 5,
      createdAt: now,
      updatedAt: now,
    });
    await addRule({
      id: "should-not-run",
      actions: [{ type: "archive" }],
    });
    await deliver("d21-skip@example.com", { spamScore: 7 });
    const rule = await getDb().query.rules.findFirst({
      where: (row, { eq }) => eq(row.id, "should-not-run"),
    });
    expect(rule?.matchCount).toBe(0);
  });
});
