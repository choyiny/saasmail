import { vi } from "vitest";
import { env } from "cloudflare:workers";
import { eq, sql } from "drizzle-orm";
import { emails } from "../db/emails.schema";
import { inboxConversationState } from "../db/inbox-conversation-state.schema";
import { rules } from "../db/rules.schema";
import { senderIdentities } from "../db/sender-identities.schema";
import { sequenceEmails } from "../db/sequence-emails.schema";
import { sequenceEnrollments } from "../db/sequence-enrollments.schema";
import { sequences } from "../db/sequences.schema";
import { setSpamFilterEnabled } from "../lib/spam/filter";
import { setWebhookConfig } from "../lib/webhook-config";
import {
  createTestPerson,
  createTestTemplate,
  createTestUser,
  getDb,
} from "./helpers";

const HOOK_URL = "https://hook.example.com/inbound";

/**
 * Every live step after an inbound message is stored, armed so a test can see
 * whether a Gmail or Outlook sync ran it: a webhook, a rule, the spam filter,
 * a forward, an autodraft inbox with a model, push, a snoozed conversation and
 * an active sequence for the sender. Call after the provider's fetch stub is
 * in place; the webhook is recorded here and every other fetch goes to it.
 */
export async function armLiveSteps(opts: { inbox: string; sender: string }) {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  const personId = "p-armed";

  await db
    .update(senderIdentities)
    .set({ agentAutodraft: 1, forwardTo: "elsewhere@example.net" })
    .where(eq(senderIdentities.email, opts.inbox));
  await setSpamFilterEnabled(db, opts.inbox, true);
  await setWebhookConfig(db, { url: HOOK_URL, secret: null }, null);
  await db.insert(rules).values({
    id: "armed-rule",
    name: "Every message",
    inbox: opts.inbox,
    trigger: "message.received",
    conditions: [],
    actions: [{ type: "archive" }],
    position: 0,
    stopProcessing: 0,
    enabled: 1,
    matchCount: 0,
    createdAt: now,
    updatedAt: now,
  });

  // An admin to push to.
  await createTestUser({ role: "admin" });
  await createTestPerson({ id: personId, email: opts.sender });
  await createTestTemplate({ slug: "armed-welcome" });
  await db.insert(sequences).values({
    id: "armed-seq",
    name: "Onboarding",
    steps: JSON.stringify([
      { order: 1, templateSlug: "armed-welcome", delayHours: 24 },
    ]),
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(sequenceEnrollments).values({
    id: "armed-enr",
    sequenceId: "armed-seq",
    personId,
    status: "active",
    variables: "{}",
    fromAddress: opts.inbox,
    enrolledAt: now,
  });
  await db.insert(sequenceEmails).values({
    id: "armed-enr-step-1",
    enrollmentId: "armed-enr",
    stepOrder: 1,
    templateSlug: "armed-welcome",
    scheduledAt: now + 86_400,
    status: "pending",
  });
  await db.insert(inboxConversationState).values({
    inbox: opts.inbox,
    conversationKey: `p:${personId}`,
    snoozedUntil: now + 86_400,
    updatedAt: now,
  });

  // Arming writes settings audit rows; only what the sync adds counts.
  const auditBefore = (
    await db.all<{ id: string }>(sql`SELECT id FROM audit_events`)
  ).map((row) => row.id);

  const webhookCalls: string[] = [];
  const inner = globalThis.fetch;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === HOOK_URL) {
        webhookCalls.push(String(input));
        return new Response(null, { status: 200 });
      }
      return inner(input, init);
    }),
  );

  const mutableEnv = env as unknown as Record<string, unknown>;
  const saved = {
    queue: mutableEnv.EMAIL_QUEUE,
    hub: mutableEnv.NOTIFICATIONS_HUB,
    anthropic: mutableEnv.ANTHROPIC_API_KEY,
  };
  const queued: Array<{ type?: string }> = [];
  const pushes: string[] = [];
  mutableEnv.EMAIL_QUEUE = {
    send: async (message: { type?: string }) => void queued.push(message),
  };
  mutableEnv.NOTIFICATIONS_HUB = {
    idFromName: (name: string) => name,
    get: () => ({
      fetch: async (request: Request) => {
        pushes.push(request.url);
        return new Response("ok");
      },
    }),
  };
  mutableEnv.ANTHROPIC_API_KEY = "sk-ant-test";

  const background: Promise<unknown>[] = [];
  const ctx = {
    waitUntil: (p: Promise<unknown>) => void background.push(p),
    passThroughOnException: () => {},
    props: {},
  } as unknown as ExecutionContext;

  return {
    ctx,
    restore() {
      mutableEnv.EMAIL_QUEUE = saved.queue;
      mutableEnv.NOTIFICATIONS_HUB = saved.hub;
      mutableEnv.ANTHROPIC_API_KEY = saved.anthropic;
    },
    /** What the sync did, once its background work has settled. */
    async observe() {
      await Promise.allSettled(background);
      const [rule] = await db
        .select({ matchCount: rules.matchCount })
        .from(rules)
        .where(eq(rules.id, "armed-rule"));
      const [snooze] = await db
        .select({ snoozedUntil: inboxConversationState.snoozedUntil })
        .from(inboxConversationState)
        .where(eq(inboxConversationState.inbox, opts.inbox));
      const [enrollment] = await db
        .select({ status: sequenceEnrollments.status })
        .from(sequenceEnrollments)
        .where(eq(sequenceEnrollments.id, "armed-enr"));
      const stored = await db.select().from(emails);
      const emailChanges = await db.all<{ object_id: string; op: string }>(
        sql`SELECT object_id, op FROM jmap_changes WHERE object_type = 'email' ORDER BY seq`,
      );
      const audit = await db.all<{ action: string }>(
        sql`SELECT action FROM audit_events WHERE id NOT IN (SELECT value FROM json_each(${JSON.stringify(auditBefore)}))`,
      );
      const training = await db.all(sql`SELECT 1 FROM spam_training`);
      return {
        stored,
        emailChanges,
        audit: audit.map((row) => row.action),
        backgroundTasks: background.length,
        webhookCalls: webhookCalls.length,
        suggestedReplies: queued.filter((m) => m.type === "suggest_reply")
          .length,
        pushes: pushes.length,
        ruleMatches: rule.matchCount,
        snoozed: snooze?.snoozedUntil != null,
        sequenceStatus: enrollment.status,
        spamTraining: training.length,
      };
    },
  };
}
