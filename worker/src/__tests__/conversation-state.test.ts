import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { blocklist } from "../db/blocklist.schema";
import { inboxConversationState } from "../db/inbox-conversation-state.schema";
import { handleEmail } from "../email-handler";
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
import {
  conversationKeyOf,
  conversationKeySql,
  snoozeConversations,
} from "../lib/messages/conversation-state";
import {
  InvalidMessageStateError,
  MessageStateAccessError,
} from "../lib/messages/state";

const INBOX = "support@saasmail.test";

describe("conversation snooze state", () => {
  beforeAll(applyMigrations);
  beforeEach(cleanDb);

  it("derives group, person, and no-conversation keys", () => {
    expect(
      conversationKeyOf({ conversationId: "group-1", personId: "person-1" }),
    ).toBe("group-1");
    expect(
      conversationKeyOf({ conversationId: null, personId: "person-1" }),
    ).toBe("p:person-1");
    expect(
      conversationKeyOf({ conversationId: null, personId: null }),
    ).toBeNull();
  });

  it("keeps SQL and TypeScript conversation-key derivation in lockstep", async () => {
    const cases = [
      { conversationId: "group-1", personId: "person-1" },
      { conversationId: null, personId: "person-1" },
      { conversationId: null, personId: null },
    ];

    for (const item of cases) {
      const [row] = await getDb().all<{ key: string | null }>(sql`
        SELECT ${conversationKeySql({
          conversationId: sql`${item.conversationId}`,
          personId: sql`${item.personId}`,
        })} AS key
      `);
      expect(row?.key ?? null).toBe(conversationKeyOf(item));
    }
  });

  it("snoozes distinct conversations and keeps group/person keys separate", async () => {
    const { userId } = await createTestUser({
      id: "snooze-admin",
      email: "snooze-admin@example.com",
    });
    await createTestPerson({ id: "p1", email: "p1@example.com" });
    await createTestEmail({
      id: "group-message",
      personId: "p1",
      recipient: INBOX,
      conversationId: "group-1",
      messageId: "group-message@example.com",
    });
    await createTestEmail({
      id: "person-message",
      personId: "p1",
      recipient: INBOX,
      conversationId: null,
      messageId: "person-message@example.com",
    });

    const until = Math.floor(Date.now() / 1000) + 3600;
    const count = await snoozeConversations(
      getDb(),
      { isAdmin: true },
      userId,
      [
        { kind: "received", id: "group-message" },
        { kind: "received", id: "group-message" },
      ],
      until,
    );
    expect(count).toBe(1);

    let rows = await getDb().select().from(inboxConversationState);
    expect(rows).toEqual([
      expect.objectContaining({
        inbox: INBOX,
        conversationKey: "group-1",
        snoozedUntil: until,
      }),
    ]);

    await snoozeConversations(
      getDb(),
      { isAdmin: true },
      userId,
      [{ kind: "received", id: "person-message" }],
      until,
    );
    rows = await getDb().select().from(inboxConversationState);
    expect(rows.map((row) => row.conversationKey).sort()).toEqual([
      "group-1",
      "p:p1",
    ]);
  });

  it("rejects invalid times, inaccessible refs, and messages without a key", async () => {
    const { userId } = await createTestUser({
      id: "member",
      role: "member",
      email: "member@example.com",
    });
    await createTestPerson({ id: "p1", email: "p1@example.com" });
    await createTestEmail({
      id: "other-inbox",
      personId: "p1",
      recipient: "other@saasmail.test",
      messageId: "other@example.com",
    });
    await createTestSentEmail({
      id: "no-conversation",
      personId: null,
      fromAddress: INBOX,
      toAddress: "nobody@example.com",
      conversationId: null,
    });

    const now = Math.floor(Date.now() / 1000);
    await expect(
      snoozeConversations(
        getDb(),
        { isAdmin: true },
        userId,
        [{ kind: "sent", id: "no-conversation" }],
        now,
      ),
    ).rejects.toBeInstanceOf(InvalidMessageStateError);
    await expect(
      snoozeConversations(
        getDb(),
        { isAdmin: true },
        userId,
        [{ kind: "sent", id: "no-conversation" }],
        now + 367 * 24 * 60 * 60,
      ),
    ).rejects.toBeInstanceOf(InvalidMessageStateError);

    await expect(
      snoozeConversations(
        getDb(),
        { isAdmin: false, inboxes: [INBOX] },
        userId,
        [{ kind: "received", id: "other-inbox" }],
        now + 60,
      ),
    ).rejects.toBeInstanceOf(MessageStateAccessError);

    await expect(
      snoozeConversations(
        getDb(),
        { isAdmin: true },
        userId,
        [{ kind: "sent", id: "no-conversation" }],
        now + 60,
      ),
    ).rejects.toBeInstanceOf(InvalidMessageStateError);
  });

  it("a real inbound delivery wakes a snoozed one-to-one conversation", async () => {
    const { userId } = await createTestUser({
      id: "wake-admin",
      email: "wake-admin@example.com",
    });
    await createTestPerson({ id: "wake-person", email: "wake@example.com" });
    await createTestEmail({
      id: "old-message",
      personId: "wake-person",
      recipient: INBOX,
      conversationId: null,
      messageId: "old-message@example.com",
    });
    const until = Math.floor(Date.now() / 1000) + 3600;
    await snoozeConversations(
      getDb(),
      { isAdmin: true },
      userId,
      [{ kind: "received", id: "old-message" }],
      until,
    );

    const raw = [
      "From: Wake Person <wake@example.com>",
      `To: ${INBOX}`,
      "Subject: Wake up",
      "Message-ID: <wake-new@example.com>",
      "Content-Type: text/plain; charset=utf-8",
      "",
      "new inbound message",
    ].join("\r\n");
    const bytes = new TextEncoder().encode(raw);
    const message = {
      from: "wake@example.com",
      to: INBOX,
      headers: new Headers(),
      raw: new ReadableStream({
        start(controller) {
          controller.enqueue(bytes);
          controller.close();
        },
      }),
      setReject() {},
      forward: async () => {},
    } as unknown as ForwardableEmailMessage;
    const pending: Promise<unknown>[] = [];
    const ctx = {
      waitUntil(promise: Promise<unknown>) {
        pending.push(promise);
      },
      passThroughOnException() {},
    } as unknown as ExecutionContext;

    await handleEmail(message, env as CloudflareBindings, ctx);
    await Promise.allSettled(pending);

    const rows = await getDb().select().from(inboxConversationState);
    expect(rows).toEqual([
      expect.objectContaining({
        inbox: INBOX,
        conversationKey: "p:wake-person",
        snoozedUntil: null,
      }),
    ]);
  });

  it("an outbound message does not wake a snoozed conversation", async () => {
    const { userId } = await createTestUser({
      id: "reply-admin",
      email: "reply-admin@example.com",
    });
    await createTestPerson({ id: "reply-person", email: "reply@example.com" });
    await createTestEmail({
      id: "reply-old",
      personId: "reply-person",
      recipient: INBOX,
      messageId: "reply-old@example.com",
    });
    const until = Math.floor(Date.now() / 1000) + 3600;
    await snoozeConversations(
      getDb(),
      { isAdmin: true },
      userId,
      [{ kind: "received", id: "reply-old" }],
      until,
    );

    await createTestSentEmail({
      id: "reply-sent",
      personId: "reply-person",
      fromAddress: INBOX,
      toAddress: "reply@example.com",
      conversationId: null,
    });

    const [row] = await getDb().select().from(inboxConversationState);
    expect(row.snoozedUntil).toBe(until);
  });

  it("person delete removes only that person's p: conversation rows", async () => {
    const { apiKey, userId } = await createTestUser({
      id: "delete-admin",
      email: "delete-admin@example.com",
    });
    await createTestPerson({
      id: "delete-person",
      email: "delete@example.com",
    });
    await createTestEmail({
      id: "delete-message",
      personId: "delete-person",
      recipient: INBOX,
      messageId: "delete-message@example.com",
    });
    const now = Math.floor(Date.now() / 1000);
    await getDb()
      .insert(inboxConversationState)
      .values([
        {
          inbox: INBOX,
          conversationKey: "p:delete-person",
          snoozedUntil: now + 3600,
          snoozedBy: userId,
          updatedAt: now,
        },
        {
          inbox: INBOX,
          conversationKey: "group-survives",
          snoozedUntil: now + 3600,
          snoozedBy: userId,
          updatedAt: now,
        },
      ]);

    const response = await authFetch("/api/people/delete-person", {
      apiKey,
      method: "DELETE",
    });
    expect(response.status).toBe(200);
    const rows = await getDb().select().from(inboxConversationState);
    expect(rows.map((row) => row.conversationKey)).toEqual(["group-survives"]);
  });

  it("purge-blocked removes p: conversation rows for purged people", async () => {
    const { apiKey, userId } = await createTestUser({
      id: "purge-admin",
      email: "purge-admin@example.com",
    });
    await createTestPerson({ id: "blocked-person", email: "bad@evil.com" });
    await createTestEmail({
      id: "blocked-message",
      personId: "blocked-person",
      recipient: INBOX,
      messageId: "blocked-message@example.com",
    });
    const now = Math.floor(Date.now() / 1000);
    await getDb()
      .insert(inboxConversationState)
      .values({
        inbox: INBOX,
        conversationKey: "p:blocked-person",
        snoozedUntil: now + 3600,
        snoozedBy: userId,
        updatedAt: now,
      });
    await getDb().insert(blocklist).values({
      id: "block-1",
      type: "domain",
      value: "evil.com",
      createdAt: now,
    });

    const response = await authFetch("/api/blocklist/mail", {
      apiKey,
      method: "DELETE",
    });
    expect(response.status).toBe(200);
    expect(await getDb().select().from(inboxConversationState)).toEqual([]);
  });
});
