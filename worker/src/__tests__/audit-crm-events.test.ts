// docs/specs/SPEC-audit-log.md §3: events for customers, sequences, lists and
// the agent's actions.
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { sql } from "drizzle-orm";
import { auditDeclinedApprovals } from "../agent/mail-agent";
import { auditEvents } from "../db/audit-events.schema";
import { lists } from "../db/lists.schema";
import { senderIdentities } from "../db/sender-identities.schema";
import { sequences } from "../db/sequences.schema";
import { createAgentTools } from "../lib/agent/tools";
import { agentActor } from "../lib/audit/actors";
import { linkPeople, unlinkPerson } from "../lib/customers";
import {
  applyMigrations,
  authFetch,
  buildSendForm,
  cleanDb,
  createTestEmail,
  createTestPerson,
  createTestTemplate,
  createTestUser,
  getDb,
} from "./helpers";

const ADMIN = { isAdmin: true as const };
const INBOX = "support@saasmail.test";

async function events() {
  const rows = await getDb()
    .select()
    .from(auditEvents)
    .orderBy(sql`rowid`);
  return rows.map((row) => ({
    ...row,
    details: row.details ? JSON.parse(row.details) : null,
  }));
}

function send(path: string, apiKey: string, method: string, body?: unknown) {
  return authFetch(path, {
    apiKey,
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

describe("audit events for customers, sequences, lists and the agent", () => {
  let userId: string;
  let apiKey: string;

  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDb();
    ({ userId, apiKey } = await createTestUser());
    (env as any).DEMO_MODE = "1";
    const now = Math.floor(Date.now() / 1000);
    await getDb()
      .insert(senderIdentities)
      .values({ email: INBOX, createdAt: now, updatedAt: now });
    for (const [id, email] of [
      ["p1", "alice@example.com"],
      ["p2", "alice@work.example"],
      ["p3", "bob@example.com"],
      ["p4", "bob@work.example"],
    ]) {
      await createTestPerson({ id, email });
      await createTestEmail({
        id: `e-${id}`,
        personId: id,
        recipient: INBOX,
        messageId: `<${id}@example.com>`,
      });
    }
  });

  afterEach(() => {
    (env as any).DEMO_MODE = "0";
  });

  it("records customers linked, extended, merged and unlinked", async () => {
    await linkPeople(getDb(), ADMIN, userId, "p1", "p2");
    await linkPeople(getDb(), ADMIN, userId, "p3", "p4");
    // Both are customers already: linking across them merges the two.
    await linkPeople(getDb(), ADMIN, userId, "p1", "p3");
    await unlinkPerson(getDb(), ADMIN, userId, "p4");
    // Already one customer: nothing to record.
    await linkPeople(getDb(), ADMIN, userId, "p1", "p2");

    const rows = await events();
    expect(rows.map((row) => row.action)).toEqual([
      "customer.linked",
      "customer.linked",
      "customer.merged",
      "customer.unlinked",
    ]);
    expect(rows[0].details).toEqual({ personIds: ["p1", "p2"] });
    expect(rows[2].details.personIds).toEqual(["p1", "p3"]);
    expect(rows.every((row) => row.targetType === "customer")).toBe(true);
  });

  it("records an enrollment and a deliberate cancel, not the automatic one", async () => {
    await createTestTemplate({ slug: "step-1", bodyHtml: "<p>One</p>" });
    await createTestTemplate({ slug: "step-2", bodyHtml: "<p>Two</p>" });
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

    const enrolled = await send("/api/sequences/seq-1/enroll", apiKey, "POST", {
      personId: "p1",
      fromAddress: INBOX,
    });
    expect(enrolled.status, await enrolled.clone().text()).toBeLessThan(300);
    const { enrollment } = (await enrolled.json()) as {
      enrollment: { id: string };
    };

    const cancelled = await send(
      `/api/sequences/enrollments/${enrollment.id}`,
      apiKey,
      "DELETE",
    );
    expect(cancelled.status, await cancelled.clone().text()).toBe(200);

    const rows = (await events()).filter((row) =>
      row.action.startsWith("sequence."),
    );
    expect(rows.map((row) => row.action)).toEqual([
      "sequence.enrolled",
      "sequence.cancelled",
    ]);
    expect(rows[0]).toMatchObject({ targetId: "seq-1", inbox: INBOX });
    expect(rows[1].details).toMatchObject({ enrollmentId: enrollment.id });

    // A direct send stops a contact's sequences as a side effect of every
    // send. That is not somebody cancelling a sequence.
    const again = await send("/api/sequences/seq-1/enroll", apiKey, "POST", {
      personId: "p3",
      fromAddress: INBOX,
    });
    expect(again.status).toBeLessThan(300);
    const sent = await authFetch("/api/send", {
      apiKey,
      method: "POST",
      body: buildSendForm({
        to: "bob@example.com",
        fromAddress: INBOX,
        subject: "Hello",
        bodyHtml: "<p>hi</p>",
        transactional: true,
      }),
    });
    expect(sent.status).toBe(201);
    expect(
      (await events()).filter((row) => row.action === "sequence.cancelled"),
    ).toHaveLength(1);
  });

  it("records a list member added and removed by a person", async () => {
    const now = Math.floor(Date.now() / 1000);
    await getDb().insert(lists).values({
      id: "list-1",
      name: "Weekly",
      description: null,
      fromAddress: INBOX,
      doubleOptIn: 0,
      confirmationTemplateSlug: null,
      archivedAt: null,
      createdAt: now,
      updatedAt: now,
    });

    const added = await send("/api/lists/list-1/members", apiKey, "POST", {
      email: "carol@example.com",
    });
    expect(added.status, await added.clone().text()).toBe(201);
    const { id: memberId } = (await added.json()) as { id: string };
    // Adding someone who is already subscribed changes nothing.
    await send("/api/lists/list-1/members", apiKey, "POST", {
      email: "carol@example.com",
    });
    const removed = await send(
      `/api/lists/list-1/members/${memberId}`,
      apiKey,
      "DELETE",
    );
    expect(removed.status, await removed.clone().text()).toBe(200);
    // Already unsubscribed: nothing more to record.
    await send(`/api/lists/list-1/members/${memberId}`, apiKey, "DELETE");

    const rows = await events();
    expect(rows.map((row) => [row.action, row.summary])).toEqual([
      ["list.member_added", "Added carol@example.com to 'Weekly'"],
      ["list.member_removed", "Removed carol@example.com from 'Weekly'"],
    ]);
    expect(rows.every((row) => row.targetId === "list-1")).toBe(true);
  });

  it("records what the agent does as the agent, and an approved action twice over", async () => {
    const user = {
      id: userId,
      name: "Test User",
      email: "test@example.com",
      role: "admin",
    };
    const tools = createAgentTools({
      db: getDb(),
      env: env as unknown as CloudflareBindings,
      user,
      sessionId: "session-9",
    });
    const run = (name: string, input: Record<string, unknown>) =>
      (tools as any)[name].execute(input, {});

    // Not approval-gated: only the state change is an event.
    await run("set_archived", { refs: ["received:e-p1"], archived: true });
    // Approval-gated: the link itself, and that the agent ran it.
    await run("link_customer", { personId: "p1", otherPersonId: "p2" });

    const rows = await events();
    expect(rows.map((row) => row.action)).toEqual([
      "mail.archived",
      "customer.linked",
      "agent.action_executed",
    ]);
    for (const row of rows) {
      expect(row).toMatchObject({
        actorType: "agent",
        actorUserId: userId,
        actorLabel: "agent for test@example.com",
        channel: "agent",
      });
    }
    expect(rows[2].details).toEqual({
      tool: "link_customer",
      args: { personId: "p1", otherPersonId: "p2" },
    });
  });

  it("records an agent action the user declined, in the turn it is answered", async () => {
    const audit = {
      db: getDb(),
      actor: agentActor({ id: userId, email: "test@example.com" }, "s1"),
    };
    const part = (state: string, approved: boolean, toolCallId: string) => ({
      type: "tool-enroll_in_sequence",
      toolCallId,
      state,
      input: { personId: "p1", sequenceId: "seq-1" },
      approval: { id: `approval-${toolCallId}`, approved },
    });
    const turn = (parts: unknown[]) =>
      [
        { id: "m1", role: "user", parts: [{ type: "text", text: "enroll" }] },
        { id: "m2", role: "assistant", parts },
      ] as never;

    // The user pressed Deny: the answer arrives with the next request.
    await auditDeclinedApprovals(
      audit,
      turn([part("approval-responded", false, "c1")]),
    );
    // Approved, still waiting, or already settled in an earlier turn: none of
    // these is a decline to record now.
    await auditDeclinedApprovals(
      audit,
      turn([
        part("approval-responded", true, "c2"),
        part("approval-requested", false, "c3"),
        part("output-denied", false, "c4"),
      ]),
    );
    // Only the message being answered counts.
    await auditDeclinedApprovals(audit, [
      {
        id: "m2",
        role: "assistant",
        parts: [part("approval-responded", false, "c5")],
      },
      { id: "m3", role: "user", parts: [{ type: "text", text: "never mind" }] },
    ] as never);

    const rows = await events();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: "agent.action_denied",
      actorType: "agent",
      actorUserId: userId,
      summary: "The agent's request to run enroll_in_sequence was declined",
      details: { tool: "enroll_in_sequence", toolCallId: "c1" },
    });
  });
});
