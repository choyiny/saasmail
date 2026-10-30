// docs/inboxes.md, "Test inboxes": plus addresses of a test inbox land in it
// with their detail, and its mail skips every side effect of live mail.
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { handleEmail } from "../email-handler";
import { emails } from "../db/emails.schema";
import { rules } from "../db/rules.schema";
import { senderIdentities } from "../db/sender-identities.schema";
import { inboxPermissions } from "../db/inbox-permissions.schema";
import { setRejectUnknownRecipients } from "../lib/inbound-rejection";
import { splitSubaddress } from "../lib/inbound/subaddress";
import { selectMatchingRules, runMatchedRules } from "../lib/rules/evaluate";
import { deliverWebhook } from "../lib/webhook-delivery";
import { forwardInbound } from "../lib/inbound-forward";
import { wakeConversation } from "../lib/messages/conversation-state";
import { cancelSequencesForPerson } from "../lib/cancel-sequence";
import { scoreInbound } from "../lib/spam/filter";
import { applyMigrations, cleanDb, createTestUser, getDb } from "./helpers";

vi.mock("../lib/rules/evaluate", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("../lib/rules/evaluate")>();
  return {
    ...original,
    selectMatchingRules: vi.fn(original.selectMatchingRules),
    runMatchedRules: vi.fn(original.runMatchedRules),
  };
});
vi.mock("../lib/webhook-delivery", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("../lib/webhook-delivery")>();
  return { ...original, deliverWebhook: vi.fn(original.deliverWebhook) };
});
vi.mock("../lib/inbound-forward", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("../lib/inbound-forward")>();
  return { ...original, forwardInbound: vi.fn(original.forwardInbound) };
});
vi.mock("../lib/messages/conversation-state", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("../lib/messages/conversation-state")>();
  return { ...original, wakeConversation: vi.fn(original.wakeConversation) };
});
vi.mock("../lib/cancel-sequence", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("../lib/cancel-sequence")>();
  return {
    ...original,
    cancelSequencesForPerson: vi.fn(original.cancelSequencesForPerson),
  };
});
vi.mock("../lib/spam/filter", async (importOriginal) => {
  const original = await importOriginal<typeof import("../lib/spam/filter")>();
  return { ...original, scoreInbound: vi.fn(original.scoreInbound) };
});

const TEST_INBOX = "e2e@saasmail.test";
const NORMAL_INBOX = "support@saasmail.test";

async function addInbox(email: string, purpose: "mail" | "test") {
  const now = Math.floor(Date.now() / 1000);
  await getDb()
    .insert(senderIdentities)
    .values({ email, purpose, createdAt: now, updatedAt: now });
}

async function deliver(to: string, id: string, from = "no-reply@example.com") {
  const raw = [
    `From: App <${from}>`,
    `To: ${to}`,
    "Subject: Reset your password",
    `Message-ID: <${id}@example.com>`,
    "Content-Type: text/plain; charset=utf-8",
    "",
    "Your code is 482913",
  ].join("\r\n");
  const setReject = vi.fn();
  const waitUntil = vi.fn();
  const message = {
    from,
    to,
    raw: new Response(raw).body!,
    rawSize: raw.length,
    headers: new Headers(),
    setReject,
    async forward() {},
    async reply() {},
  } as unknown as ForwardableEmailMessage;
  const ctx = {
    waitUntil,
    passThroughOnException() {},
  } as unknown as ExecutionContext;
  await handleEmail(message, env as unknown as CloudflareBindings, ctx);
  return { setReject, waitUntil };
}

beforeAll(async () => {
  await applyMigrations();
});

beforeEach(async () => {
  await cleanDb();
  vi.clearAllMocks();
});

describe("splitSubaddress", () => {
  it("leaves a plain address whole", () => {
    expect(splitSubaddress("e2e@example.com")).toEqual({
      base: "e2e@example.com",
      detail: null,
    });
  });

  it("splits one plus", () => {
    expect(splitSubaddress("e2e+run1@example.com")).toEqual({
      base: "e2e@example.com",
      detail: "run1",
    });
  });

  it("splits at the first plus, keeping the rest in the detail", () => {
    expect(splitSubaddress("e2e+a+b@example.com")).toEqual({
      base: "e2e@example.com",
      detail: "a+b",
    });
  });

  it("treats an empty detail as no detail", () => {
    expect(splitSubaddress("e2e+@example.com")).toEqual({
      base: "e2e+@example.com",
      detail: null,
    });
  });

  it("ignores a plus in the domain part", () => {
    expect(splitSubaddress("e2e@ex+ample.com")).toEqual({
      base: "e2e@ex+ample.com",
      detail: null,
    });
  });
});

describe("ingest — test inboxes", () => {
  it("stores plus mail to a test inbox in it, with the detail", async () => {
    await addInbox(TEST_INBOX, "test");
    await deliver("E2E+Run1@saasmail.test", "m1");

    const rows = await getDb().select().from(emails);
    expect(rows).toHaveLength(1);
    expect(rows[0].recipient).toBe(TEST_INBOX);
    expect(rows[0].recipientDetail).toBe("run1");
  });

  it("runs no rule, spam score, webhook, forward, fan-out, wake or sequence cancel", async () => {
    await addInbox(TEST_INBOX, "test");
    const { waitUntil, setReject } = await deliver(
      "e2e+run1@saasmail.test",
      "m1",
    );

    expect(await getDb().select().from(emails)).toHaveLength(1);
    expect(setReject).not.toHaveBeenCalled();
    expect(scoreInbound).not.toHaveBeenCalled();
    expect(selectMatchingRules).not.toHaveBeenCalled();
    expect(runMatchedRules).not.toHaveBeenCalled();
    expect(deliverWebhook).not.toHaveBeenCalled();
    expect(forwardInbound).not.toHaveBeenCalled();
    expect(wakeConversation).not.toHaveBeenCalled();
    expect(cancelSequencesForPerson).not.toHaveBeenCalled();
    // The notification fan-out and the suggested reply run in waitUntil.
    expect(waitUntil).not.toHaveBeenCalled();
  });

  it("runs the live steps for a normal inbox (the spies see real calls)", async () => {
    await addInbox(NORMAL_INBOX, "mail");
    await deliver(NORMAL_INBOX, "m1");
    expect(selectMatchingRules).toHaveBeenCalled();
    expect(deliverWebhook).toHaveBeenCalled();
    expect(forwardInbound).toHaveBeenCalled();
    expect(cancelSequencesForPerson).toHaveBeenCalled();
  });

  it("lets an exact plus-address inbox win", async () => {
    await addInbox(TEST_INBOX, "test");
    await addInbox("e2e+exact@saasmail.test", "mail");
    await deliver("e2e+exact@saasmail.test", "m1");

    const [row] = await getDb().select().from(emails);
    expect(row.recipient).toBe("e2e+exact@saasmail.test");
    expect(row.recipientDetail).toBeNull();
  });

  it("keeps mail for a member-granted plus address with no identity row", async () => {
    await addInbox(TEST_INBOX, "test");
    const { userId } = await createTestUser({ id: "member-1", role: "member" });
    await getDb()
      .insert(inboxPermissions)
      .values({
        userId,
        email: "e2e+private@saasmail.test",
        createdAt: Math.floor(Date.now() / 1000),
        createdBy: userId,
      });
    await deliver("e2e+private@saasmail.test", "m1");

    const [row] = await getDb().select().from(emails);
    expect(row.recipient).toBe("e2e+private@saasmail.test");
    expect(row.recipientDetail).toBeNull();
  });

  it("stores one message to two subaddresses once, with the first detail", async () => {
    await addInbox(TEST_INBOX, "test");
    await deliver("e2e+a@saasmail.test", "same");
    await deliver("e2e+b@saasmail.test", "same");

    const rows = await getDb().select().from(emails);
    expect(rows).toHaveLength(1);
    expect(rows[0].recipientDetail).toBe("a");
  });

  it("keeps a plus address whose base is a normal inbox separate", async () => {
    await addInbox(NORMAL_INBOX, "mail");
    await deliver("support+x@saasmail.test", "m1");
    const [row] = await getDb().select().from(emails);
    expect(row.recipient).toBe("support+x@saasmail.test");
    expect(row.recipientDetail).toBeNull();

    await setRejectUnknownRecipients(getDb(), true);
    const { setReject } = await deliver("support+y@saasmail.test", "m2");
    expect(setReject).toHaveBeenCalled();
  });

  it("follows the unknown-recipient path when the base is not an inbox", async () => {
    await deliver("nobody+x@saasmail.test", "m1");
    const [row] = await getDb().select().from(emails);
    expect(row.recipient).toBe("nobody+x@saasmail.test");

    await setRejectUnknownRecipients(getDb(), true);
    const { setReject } = await deliver("nobody+y@saasmail.test", "m2");
    expect(setReject).toHaveBeenCalled();
    expect(
      await getDb()
        .select()
        .from(emails)
        .where(eq(emails.recipient, "nobody+y@saasmail.test")),
    ).toHaveLength(0);
  });

  // Where unknown recipients are refused, the plus address must resolve to the
  // test inbox before that check, and a reject rule must not see test mail;
  // the blocklist still drops a blocked sender's test mail.
  it("stores plus mail despite unknown-recipient rejection and a reject rule, but drops a blocked sender", async () => {
    await addInbox(TEST_INBOX, "test");
    await setRejectUnknownRecipients(getDb(), true);
    const now = Math.floor(Date.now() / 1000);
    await getDb()
      .insert(rules)
      .values({
        id: "reject-all",
        name: "Refuse everything",
        inbox: null,
        trigger: "message.received",
        conditions: [],
        actions: [{ type: "reject" }] as never,
        position: 0,
        stopProcessing: 0,
        enabled: 1,
        matchCount: 0,
        createdAt: now,
        updatedAt: now,
      });
    await env.DB.prepare(
      "INSERT INTO blocklist (id, type, value, created_at) VALUES ('b1', 'email', 'spammer@example.com', ?)",
    )
      .bind(now)
      .run();

    const stored = await deliver("e2e+run42@saasmail.test", "ok");
    const blocked = await deliver(
      "e2e+run43@saasmail.test",
      "blocked",
      "spammer@example.com",
    );

    expect(stored.setReject).not.toHaveBeenCalled();
    expect(blocked.setReject).not.toHaveBeenCalled();
    const rows = await getDb()
      .select({
        recipient: emails.recipient,
        detail: emails.recipientDetail,
      })
      .from(emails);
    expect(rows).toEqual([{ recipient: TEST_INBOX, detail: "run42" }]);
    const [rule] = await getDb()
      .select({ matchCount: rules.matchCount })
      .from(rules);
    expect(rule.matchCount).toBe(0);
    const rejections = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM audit_events WHERE action = 'inbound.rejected'",
    ).first<{ n: number }>();
    expect(rejections?.n).toBe(0);
  });
});
