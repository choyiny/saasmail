import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { handleEmail } from "../email-handler";
import { senderIdentities } from "../db/sender-identities.schema";
import { emails } from "../db/emails.schema";
import { inboxConversationState } from "../db/inbox-conversation-state.schema";
import { mailboxMessageState } from "../db/mailbox-message-state.schema";
import {
  applyMigrations,
  cleanDb,
  createTestPerson,
  createTestUser,
  getDb,
} from "./helpers";

beforeAll(async () => {
  await applyMigrations();
});

beforeEach(async () => {
  await cleanDb();
});

function inboundMessage(options: {
  inbox: string;
  messageId: string;
  spamScore?: number;
}): ForwardableEmailMessage {
  const headers = [
    "From: Customer <customer@example.com>",
    `To: ${options.inbox}`,
    "Subject: Spam threshold test",
    `Message-ID: <${options.messageId}>`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    ...(options.spamScore === undefined
      ? []
      : [`X-Spam-Score: ${options.spamScore}`]),
    "",
    "hello",
  ];
  const raw = new TextEncoder().encode(headers.join("\r\n"));

  return {
    from: "customer@example.com",
    to: options.inbox,
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

async function deliver(options: {
  threshold: number | null;
  spamScore?: number;
  messageId: string;
}) {
  const inbox = "support@example.com";
  const now = Math.floor(Date.now() / 1000);
  await getDb().insert(senderIdentities).values({
    email: inbox,
    displayName: "Support",
    spamThreshold: options.threshold,
    createdAt: now,
    updatedAt: now,
  });

  const { ctx, settle } = executionContext();
  await handleEmail(
    inboundMessage({
      inbox,
      messageId: options.messageId,
      spamScore: options.spamScore,
    }),
    env as unknown as CloudflareBindings,
    ctx,
  );
  await settle();

  const [email] = await getDb()
    .select()
    .from(emails)
    .where(eq(emails.messageId, `<${options.messageId}>`))
    .limit(1);
  expect(email).toBeTruthy();

  const state = await getDb()
    .select()
    .from(mailboxMessageState)
    .where(eq(mailboxMessageState.messageId, email!.id));
  return state[0] ?? null;
}

describe("per-inbox spam threshold on the real inbound path", () => {
  it("does not file a score below the threshold", async () => {
    expect(
      await deliver({
        threshold: 5,
        spamScore: 4.9,
        messageId: "spam-below@example.com",
      }),
    ).toBeNull();
  });

  it("files a score equal to the threshold in Junk", async () => {
    const state = await deliver({
      threshold: 5,
      spamScore: 5,
      messageId: "spam-equal@example.com",
    });
    expect(state?.spamAt).toEqual(expect.any(Number));
    expect(state?.updatedBy).toBeNull();
  });

  it("does not wake a snoozed conversation when the message is auto-filed as spam", async () => {
    const inbox = "support@example.com";
    const person = await createTestPerson({
      id: "spam-snoozed-person",
      email: "customer@example.com",
    });
    const now = Math.floor(Date.now() / 1000);
    const snoozedUntil = now + 3600;
    await getDb()
      .insert(inboxConversationState)
      .values({
        inbox,
        conversationKey: `p:${person.id}`,
        snoozedUntil,
        snoozedBy: null,
        updatedAt: now,
      });

    await deliver({
      threshold: 5,
      spamScore: 7,
      messageId: "spam-snoozed@example.com",
    });

    const [conversation] = await getDb()
      .select()
      .from(inboxConversationState)
      .where(eq(inboxConversationState.conversationKey, `p:${person.id}`))
      .limit(1);
    expect(conversation?.snoozedUntil).toBe(snoozedUntil);
  });

  it("does not notify users when the message is auto-filed as spam", async () => {
    await createTestUser({
      id: "spam-notify-admin",
      email: "spam-notify-admin@example.com",
      role: "admin",
    });
    const getSpy = vi.spyOn(env.NOTIFICATIONS_HUB, "get");

    await deliver({
      threshold: 5,
      spamScore: 7,
      messageId: "spam-silent@example.com",
    });

    expect(getSpy).not.toHaveBeenCalled();
    getSpy.mockRestore();
  });

  it("files a score above the threshold in Junk", async () => {
    const state = await deliver({
      threshold: 5,
      spamScore: 8.5,
      messageId: "spam-above@example.com",
    });
    expect(state?.spamAt).toEqual(expect.any(Number));
    expect(state?.updatedBy).toBeNull();
  });

  it("does nothing when the inbox threshold is null", async () => {
    expect(
      await deliver({
        threshold: null,
        spamScore: 99,
        messageId: "spam-disabled@example.com",
      }),
    ).toBeNull();
  });

  it("does nothing when X-Spam-Score is absent", async () => {
    expect(
      await deliver({
        threshold: 5,
        messageId: "spam-no-score@example.com",
      }),
    ).toBeNull();
  });
});
