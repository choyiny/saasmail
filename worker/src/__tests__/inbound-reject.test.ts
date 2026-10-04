// docs/specs/SPEC-reject-inbound.md: a `reject` rule action and
// unknown-recipient rejection, both before anything is stored.
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { eq, sql } from "drizzle-orm";
import { handleEmail } from "../email-handler";
import { auditEvents } from "../db/audit-events.schema";
import { blocklist } from "../db/blocklist.schema";
import { inboxPermissions } from "../db/inbox-permissions.schema";
import { rules } from "../db/rules.schema";
import { senderIdentities } from "../db/sender-identities.schema";
import { rejectionOf, selectMatchingRules } from "../lib/rules/evaluate";
import {
  RuleActionSchema,
  type RuleAction,
  type RuleCondition,
} from "../lib/rules/types";
import { InvalidRuleError, validateRuleActions } from "../lib/rules/validation";
import { setRejectUnknownRecipients } from "../lib/inbound-rejection";
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

function inboundMessage(options: {
  to?: string;
  from?: string;
  messageId: string;
  subject?: string;
  spamScore?: number;
  attachment?: boolean;
}) {
  const to = options.to ?? INBOX;
  const from = options.from ?? "customer@example.com";
  const head = [
    `From: Customer <${from}>`,
    `To: ${to}`,
    `Subject: ${options.subject ?? "Hello"}`,
    `Message-ID: <${options.messageId}>`,
    "MIME-Version: 1.0",
    ...(options.spamScore === undefined
      ? []
      : [`X-Spam-Score: ${options.spamScore}`]),
  ];
  const lines = options.attachment
    ? [
        ...head,
        'Content-Type: multipart/mixed; boundary="b1"',
        "",
        "--b1",
        "Content-Type: text/plain; charset=utf-8",
        "",
        "hello",
        "--b1",
        'Content-Type: text/plain; name="note.txt"',
        'Content-Disposition: attachment; filename="note.txt"',
        "",
        "attached",
        "--b1--",
      ]
    : [...head, "Content-Type: text/plain; charset=utf-8", "", "hello"];
  const raw = new TextEncoder().encode(lines.join("\r\n"));
  const rejections: string[] = [];
  const message = {
    from,
    to,
    raw: new Response(raw).body!,
    rawSize: raw.byteLength,
    headers: new Headers(),
    setReject(reason: string) {
      rejections.push(reason);
    },
    async forward() {},
    async reply() {},
  } as unknown as ForwardableEmailMessage;
  return { message, rejections };
}

/** waitUntil work the last delivery started (fan-out, forwards, webhooks). */
let lastPending: Promise<unknown>[] = [];

async function deliver(options: Parameters<typeof inboundMessage>[0]) {
  const { message, rejections } = inboundMessage(options);
  const pending: Promise<unknown>[] = [];
  lastPending = pending;
  const ctx = {
    waitUntil(promise: Promise<unknown>) {
      pending.push(Promise.resolve(promise));
    },
    passThroughOnException() {},
  } as unknown as ExecutionContext;
  await handleEmail(message, env as unknown as CloudflareBindings, ctx);
  await Promise.allSettled(pending);
  return rejections;
}

async function addRule(options: {
  id: string;
  inbox?: string | null;
  conditions?: RuleCondition[];
  actions: RuleAction[];
  position?: number;
  stopProcessing?: number;
}) {
  const now = Math.floor(Date.now() / 1000);
  await getDb()
    .insert(rules)
    .values({
      id: options.id,
      name: `Rule ${options.id}`,
      inbox: options.inbox === undefined ? INBOX : options.inbox,
      trigger: "message.received",
      conditions: options.conditions ?? [],
      actions: options.actions,
      position: options.position ?? 0,
      stopProcessing: options.stopProcessing ?? 0,
      enabled: 1,
      matchCount: 0,
      createdAt: now,
      updatedAt: now,
    });
}

async function storedCounts() {
  const count = async (table: string) => {
    const [row] = await getDb().all<{ n: number }>(
      sql.raw(`SELECT COUNT(*) AS n FROM ${table}`),
    );
    return Number(row.n);
  };
  return {
    emails: await count("emails"),
    people: await count("people"),
    attachments: await count("attachments"),
  };
}

async function rejectionEvents() {
  return (await getDb().select().from(auditEvents)).filter(
    (event) => event.action === "inbound.rejected",
  );
}

const fromSpammer: RuleCondition = {
  field: "from_domain",
  operator: "equals",
  value: "spam.example",
};

beforeAll(async () => {
  await applyMigrations();
});

beforeEach(async () => {
  await cleanDb();
  const now = Math.floor(Date.now() / 1000);
  await getDb().insert(senderIdentities).values({
    email: INBOX,
    displayName: "Support",
    createdAt: now,
    updatedAt: now,
  });
});

describe("selecting the matching rules", () => {
  const message = {
    fromAddress: "bob@spam.example",
    subject: "Buy now",
    bodyText: "hello",
    bodyHtml: null,
    hasAttachments: false,
    spamScore: null,
    headers: {},
  };

  it("returns the matching rules in order and stops after one that stops processing", async () => {
    await addRule({ id: "a", actions: [{ type: "archive" }], position: 0 });
    await addRule({
      id: "b",
      conditions: [{ field: "subject", operator: "contains", value: "nope" }],
      actions: [{ type: "archive" }],
      position: 1,
    });
    await addRule({
      id: "c",
      actions: [{ type: "mark_spam" }],
      position: 2,
      stopProcessing: 1,
    });
    await addRule({ id: "d", actions: [{ type: "archive" }], position: 3 });

    const matched = await selectMatchingRules(getDb(), {
      inbox: "Support@SaaSmail.test",
      message,
    });
    expect(matched.map((entry) => entry.rule.id)).toEqual(["a", "c"]);
    // Selecting writes nothing.
    const [row] = await getDb().select().from(rules).where(eq(rules.id, "a"));
    expect(row.matchCount).toBe(0);
  });

  it("names the first rejecting rule and its reason, or the default", async () => {
    await addRule({ id: "a", actions: [{ type: "archive" }], position: 0 });
    await addRule({ id: "r", actions: [{ type: "reject" }], position: 1 });
    const matched = await selectMatchingRules(getDb(), {
      inbox: INBOX,
      message,
    });
    expect(rejectionOf(matched)).toMatchObject({
      rule: { id: "r" },
      reason: "Rejected by mailbox policy",
    });
    expect(rejectionOf(matched.slice(0, 1))).toBeNull();
  });
});

describe("a reject rule", () => {
  it("refuses the message at SMTP time and stores nothing", async () => {
    await addRule({
      id: "r",
      conditions: [fromSpammer],
      actions: [{ type: "reject", reason: "We do not accept this mail" }],
    });
    const queue = (env as any).EMAIL_QUEUE;
    const queued: unknown[] = [];
    (env as any).EMAIL_QUEUE = {
      send: async (message: unknown) => {
        queued.push(message);
      },
    };
    const before = (await env.R2.list()).objects.length;

    let rejections: string[];
    try {
      rejections = await deliver({
        from: "bob@spam.example",
        messageId: "spam-1@spam.example",
        attachment: true,
      });
    } finally {
      (env as any).EMAIL_QUEUE = queue;
    }

    expect(rejections).toEqual(["We do not accept this mail"]);
    expect(await storedCounts()).toEqual({
      emails: 0,
      people: 0,
      attachments: 0,
    });
    // No raw message, no attachment, no queue message, no background work.
    expect((await env.R2.list()).objects.length).toBe(before);
    expect(queued).toEqual([]);
    expect(lastPending).toEqual([]);

    const [rule] = await getDb().select().from(rules).where(eq(rules.id, "r"));
    expect(rule.matchCount).toBe(1);
    expect(rule.lastMatchedAt).toEqual(expect.any(Number));

    const events = await rejectionEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      actorType: "rule",
      inbox: INBOX,
      targetType: "rule",
      targetId: "r",
    });
    expect(JSON.parse(events[0].details!)).toMatchObject({
      from: "bob@spam.example",
      recipient: INBOX,
      subject: "Hello",
      messageId: "<spam-1@spam.example>",
      ruleId: "r",
    });
  });

  it("still rejects after a rule that did not match", async () => {
    await addRule({
      id: "other",
      conditions: [{ field: "subject", operator: "contains", value: "nope" }],
      actions: [{ type: "archive" }],
      position: 0,
      stopProcessing: 1,
    });
    await addRule({ id: "r", actions: [{ type: "reject" }], position: 1 });
    expect(await deliver({ messageId: "m1@example.com" })).toEqual([
      "Rejected by mailbox policy",
    ]);
  });

  it("is never reached past a matching rule that stops processing", async () => {
    await addRule({
      id: "keep",
      actions: [{ type: "archive" }],
      position: 0,
      stopProcessing: 1,
    });
    await addRule({ id: "r", actions: [{ type: "reject" }], position: 1 });
    expect(await deliver({ messageId: "m2@example.com" })).toEqual([]);
    expect((await storedCounts()).emails).toBe(1);
  });

  it("applies before the inbox spam threshold", async () => {
    await getDb()
      .update(senderIdentities)
      .set({ spamThreshold: 5 })
      .where(eq(senderIdentities.email, INBOX));
    await addRule({ id: "r", actions: [{ type: "reject" }] });
    expect(
      await deliver({ messageId: "spammy@example.com", spamScore: 9 }),
    ).toEqual(["Rejected by mailbox policy"]);
    expect((await storedCounts()).emails).toBe(0);
  });

  it("leaves a blocked sender to the silent drop", async () => {
    await getDb().insert(blocklist).values({
      id: "b1",
      type: "domain",
      value: "spam.example",
      createdAt: 1,
    });
    await addRule({
      id: "r",
      conditions: [fromSpammer],
      actions: [{ type: "reject" }],
    });
    expect(
      await deliver({ from: "bob@spam.example", messageId: "m3@spam.example" }),
    ).toEqual([]);
    expect((await storedCounts()).emails).toBe(0);
    expect(await rejectionEvents()).toHaveLength(0);
  });
});

describe("mail to an address that is not an inbox", () => {
  it("is stored by default (catch-all)", async () => {
    expect(
      await deliver({
        to: "nobody@saasmail.test",
        messageId: "u1@example.com",
      }),
    ).toEqual([]);
    expect((await storedCounts()).emails).toBe(1);
  });

  it("is refused with 'No such mailbox' when the setting is on", async () => {
    await setRejectUnknownRecipients(getDb(), true);
    expect(
      await deliver({
        to: "nobody@saasmail.test",
        messageId: "u2@example.com",
      }),
    ).toEqual(["No such mailbox"]);
    expect(await storedCounts()).toEqual({
      emails: 0,
      people: 0,
      attachments: 0,
    });
    const [event] = await rejectionEvents();
    expect(event).toMatchObject({ actorType: "system", targetType: "inbox" });
    expect(JSON.parse(event.details!)).toMatchObject({
      reason: "unknown_recipient",
      recipient: "nobody@saasmail.test",
    });
  });

  it("knows an address with assigned members but no identity", async () => {
    await setRejectUnknownRecipients(getDb(), true);
    const { userId } = await createTestUser({ role: "member" });
    await getDb().insert(inboxPermissions).values({
      userId,
      email: "sales@saasmail.test",
      createdAt: 1,
      createdBy: null,
    });
    expect(
      await deliver({ to: "Sales@saasmail.test", messageId: "u4@example.com" }),
    ).toEqual([]);
    expect((await storedCounts()).emails).toBe(1);
  });

  it("is checked before the blocklist", async () => {
    await setRejectUnknownRecipients(getDb(), true);
    await getDb().insert(blocklist).values({
      id: "b2",
      type: "domain",
      value: "spam.example",
      createdAt: 1,
    });
    expect(
      await deliver({
        to: "nobody@saasmail.test",
        from: "bob@spam.example",
        messageId: "u5@spam.example",
      }),
    ).toEqual(["No such mailbox"]);
  });

  it("lists the addresses with recent mail that would start bouncing", async () => {
    const { apiKey } = await createTestUser();
    await deliver({ to: "typo@saasmail.test", messageId: "t1@example.com" });
    await deliver({ to: "typo@saasmail.test", messageId: "t2@example.com" });
    await deliver({ to: INBOX, messageId: "t3@example.com" });
    const res = await authFetch("/api/admin/settings/unknown-recipients", {
      apiKey,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      addresses: [
        {
          address: "typo@saasmail.test",
          count: 2,
          lastReceivedAt: expect.any(Number),
        },
      ],
    });
  });

  it("knows an inbox written in another case", async () => {
    await setRejectUnknownRecipients(getDb(), true);
    expect(
      await deliver({
        to: "Support@SaaSmail.Test",
        messageId: "u3@example.com",
      }),
    ).toEqual([]);
    expect((await storedCounts()).emails).toBe(1);
  });
});

describe("validating a reject rule", () => {
  it("must be the rule's only action", async () => {
    await expect(
      validateRuleActions(getDb(), {
        inbox: null,
        actions: [{ type: "reject" }, { type: "archive" }],
      }),
    ).rejects.toThrow(InvalidRuleError);
    await expect(
      validateRuleActions(getDb(), {
        inbox: null,
        actions: [{ type: "reject" }],
      }),
    ).resolves.toBeUndefined();
  });

  it("takes a reason of 1 to 200 printable ASCII characters, trimmed", () => {
    const parse = (reason: string) =>
      RuleActionSchema.safeParse({ type: "reject", reason }).success;
    expect(
      RuleActionSchema.parse({ type: "reject", reason: "  Go away  " }),
    ).toEqual({ type: "reject", reason: "Go away" });
    expect(parse("   ")).toBe(false);
    expect(parse("Go away")).toBe(true);
    expect(parse("x".repeat(200))).toBe(true);
    expect(parse("x".repeat(201))).toBe(false);
    expect(parse("")).toBe(false);
    expect(parse("line\r\nbreak")).toBe(false);
    expect(parse("café")).toBe(false);
  });
});

describe("the admin routes", () => {
  let apiKey: string;

  beforeEach(async () => {
    ({ apiKey } = await createTestUser());
  });

  it("refuse a rule with reject and another action", async () => {
    const res = await authFetch("/api/admin/rules", {
      apiKey,
      method: "POST",
      body: JSON.stringify({
        name: "Bad",
        conditions: [],
        actions: [{ type: "reject" }, { type: "archive" }],
      }),
    });
    expect(res.status).toBe(400);
  });

  it("say in a dry run that a matching reject rule would reject", async () => {
    await createTestPerson({ id: "p1", email: "bob@spam.example" });
    await createTestEmail({ id: "e1", personId: "p1", recipient: INBOX });
    const test = (actions?: RuleAction[]) =>
      authFetch("/api/admin/rules/test", {
        apiKey,
        method: "POST",
        body: JSON.stringify({
          rule: { conditions: [fromSpammer], ...(actions ? { actions } : {}) },
          emailId: "e1",
        }),
      });
    expect(await (await test([{ type: "reject" }])).json()).toMatchObject({
      matched: true,
      wouldReject: true,
    });
    expect(await (await test([{ type: "archive" }])).json()).toMatchObject({
      matched: true,
      wouldReject: false,
    });
    expect(await (await test()).json()).toMatchObject({ wouldReject: false });
  });

  it("turn unknown-recipient rejection on through the settings, recorded", async () => {
    const patched = await authFetch("/api/admin/settings", {
      apiKey,
      method: "PATCH",
      body: JSON.stringify({ rejectUnknownRecipients: true }),
    });
    expect(await patched.json()).toMatchObject({
      rejectUnknownRecipients: true,
    });
    const settings = await authFetch("/api/admin/settings", { apiKey });
    expect(await settings.json()).toMatchObject({
      rejectUnknownRecipients: true,
    });
    const changes = (await getDb().select().from(auditEvents)).filter(
      (event) => event.action === "settings.changed",
    );
    expect(changes).toHaveLength(1);
  });
});
