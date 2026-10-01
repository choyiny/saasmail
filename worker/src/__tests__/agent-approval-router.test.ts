import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { inboxPermissions } from "../db/inbox-permissions.schema";
import { listMembers } from "../db/list-members.schema";
import { lists } from "../db/lists.schema";
import { customerPeople, customers } from "../db/customers.schema";
import { sequences } from "../db/sequences.schema";
import { suppressions } from "../db/suppressions.schema";
import { createAgentTools } from "../lib/agent/tools";
import {
  applyMigrations,
  authFetch,
  cleanDb,
  createTestEmail,
  createTestPerson,
  createTestUser,
  getDb,
} from "./helpers";

async function execute(
  tools: ReturnType<typeof createAgentTools>,
  name: string,
  input: Record<string, unknown> = {},
) {
  const entry = (tools as any)[name];
  if (!entry?.execute) throw new Error(`Tool ${name} has no execute function`);
  return entry.execute(input, {});
}

describe("agent approval summaries", () => {
  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDb();
  });

  it("summarizes visible entities from D1 and hides out-of-scope targets", async () => {
    const member = await createTestUser({
      id: "approval-summary-member",
      role: "member",
      email: "approval-summary-member@example.com",
    });
    const db = getDb();
    const now = Math.floor(Date.now() / 1000);
    await db.insert(inboxPermissions).values({
      userId: member.userId,
      email: "allowed@example.com",
      createdAt: now,
      createdBy: null,
    });

    const visible = await createTestPerson({
      id: "approval-summary-person",
      email: "jane@acme.com",
      name: "Jane",
    });
    await createTestEmail({
      id: "approval-summary-email",
      personId: visible.id,
      recipient: "allowed@example.com",
      messageId: "approval-summary-email@example.com",
    });

    await db.insert(sequences).values({
      id: "approval-summary-sequence",
      name: "Onboarding",
      steps: JSON.stringify([
        { order: 1, templateSlug: "one", delayHours: 0 },
        { order: 2, templateSlug: "two", delayHours: 120 },
        { order: 3, templateSlug: "three", delayHours: 120 },
      ]),
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(lists).values([
      {
        id: "approval-summary-list",
        name: "Beta testers",
        description: null,
        fromAddress: "allowed@example.com",
        doubleOptIn: 0,
        confirmationTemplateSlug: null,
        archivedAt: null,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: "approval-summary-suppressed-list",
        name: "Suppressed beta",
        description: null,
        fromAddress: "allowed@example.com",
        doubleOptIn: 0,
        confirmationTemplateSlug: null,
        archivedAt: null,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: "approval-summary-hidden-list",
        name: "Hidden",
        description: null,
        fromAddress: "denied@example.com",
        doubleOptIn: 0,
        confirmationTemplateSlug: null,
        archivedAt: null,
        createdAt: now,
        updatedAt: now,
      },
    ]);

    const enroll = await authFetch("/api/agent/approval-summary", {
      method: "POST",
      apiKey: member.apiKey,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        toolName: "enroll_in_sequence",
        input: {
          personId: visible.id,
          sequenceId: "approval-summary-sequence",
        },
      }),
    });
    expect(enroll.status).toBe(200);
    const enrollSummary = (await enroll.json()) as { summary: string };
    expect(enrollSummary).toEqual({
      summary:
        "Enroll jane@acme.com in 'Onboarding' from allowed@example.com (3 emails over 10 days)",
    });

    const tools = createAgentTools({
      db,
      env: { DEMO_MODE: "1" } as any,
      user: {
        id: member.userId,
        email: "approval-summary-member@example.com",
        role: "member",
      },
    });
    const executedEnrollment = (await execute(tools, "enroll_in_sequence", {
      personId: visible.id,
      sequenceId: "approval-summary-sequence",
    })) as { success: boolean; fromAddress: string };
    expect(executedEnrollment).toMatchObject({
      success: true,
      fromAddress: "allowed@example.com",
    });
    expect(enrollSummary.summary).toContain(
      ` from ${executedEnrollment.fromAddress} `,
    );

    const list = await authFetch("/api/agent/approval-summary", {
      method: "POST",
      apiKey: member.apiKey,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        toolName: "add_to_list",
        input: { personId: visible.id, listId: "approval-summary-list" },
      }),
    });
    expect(list.status).toBe(200);
    expect(await list.json()).toEqual({
      summary: "Add jane@acme.com to list 'Beta testers'",
    });

    await db.insert(listMembers).values({
      id: "approval-summary-unsubscribed-member",
      listId: "approval-summary-list",
      contactId: "approval-summary-contact",
      email: "jane@acme.com",
      status: "unsubscribed",
      source: "api",
      formId: null,
      submittedIp: null,
      consentSource: "api",
      consentAt: now - 100,
      importJobId: null,
      subscribedAt: now - 100,
      confirmedAt: null,
      unsubscribedAt: now - 10,
      unsubscribeReason: "user",
      createdAt: now - 100,
    });
    const unsubscribed = await authFetch("/api/agent/approval-summary", {
      method: "POST",
      apiKey: member.apiKey,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        toolName: "add_to_list",
        input: { personId: visible.id, listId: "approval-summary-list" },
      }),
    });
    expect(unsubscribed.status).toBe(200);
    expect(await unsubscribed.json()).toEqual({
      summary: "Can't add: jane@acme.com unsubscribed from 'Beta testers'",
    });

    await db.insert(suppressions).values({
      id: "approval-summary-suppression",
      email: "jane@acme.com",
      reason: "unsubscribe",
      source: "test",
      note: null,
      createdAt: now,
    });
    const suppressed = await authFetch("/api/agent/approval-summary", {
      method: "POST",
      apiKey: member.apiKey,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        toolName: "add_to_list",
        input: {
          personId: visible.id,
          listId: "approval-summary-suppressed-list",
        },
      }),
    });
    expect(suppressed.status).toBe(200);
    expect(await suppressed.json()).toEqual({
      summary: "Can't add: jane@acme.com is suppressed from 'Suppressed beta'",
    });

    const hidden = await authFetch("/api/agent/approval-summary", {
      method: "POST",
      apiKey: member.apiKey,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        toolName: "add_to_list",
        input: {
          personId: visible.id,
          listId: "approval-summary-hidden-list",
        },
      }),
    });
    expect(hidden.status).toBe(404);

    await db
      .delete(inboxPermissions)
      .where(eq(inboxPermissions.userId, member.userId));

    const revoked = await authFetch("/api/agent/approval-summary", {
      method: "POST",
      apiKey: member.apiKey,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        toolName: "enroll_in_sequence",
        input: {
          personId: visible.id,
          sequenceId: "approval-summary-sequence",
        },
      }),
    });
    expect(revoked.status).toBe(404);
  });

  it("labels an existing-customer merge as admin-only in the approval summary", async () => {
    const member = await createTestUser({
      id: "approval-merge-member",
      role: "member",
      email: "approval-merge-member@example.com",
    });
    const db = getDb();
    const now = Math.floor(Date.now() / 1000);
    await db.insert(inboxPermissions).values({
      userId: member.userId,
      email: "allowed@example.com",
      createdAt: now,
      createdBy: null,
    });

    for (const id of ["approval-a", "approval-b", "approval-c", "approval-d"]) {
      await createTestPerson({ id, email: `${id}@example.com` });
      await createTestEmail({
        id: `${id}-mail`,
        personId: id,
        recipient: "allowed@example.com",
        messageId: `${id}@example.test`,
      });
    }
    await db.insert(customers).values([
      {
        id: "approval-customer-1",
        displayName: null,
        createdBy: null,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: "approval-customer-2",
        displayName: null,
        createdBy: null,
        createdAt: now,
        updatedAt: now,
      },
    ]);
    await db.insert(customerPeople).values([
      {
        customerId: "approval-customer-1",
        personId: "approval-a",
        linkedBy: null,
        linkedAt: now,
      },
      {
        customerId: "approval-customer-1",
        personId: "approval-b",
        linkedBy: null,
        linkedAt: now,
      },
      {
        customerId: "approval-customer-2",
        personId: "approval-c",
        linkedBy: null,
        linkedAt: now,
      },
      {
        customerId: "approval-customer-2",
        personId: "approval-d",
        linkedBy: null,
        linkedAt: now,
      },
    ]);

    const response = await authFetch("/api/agent/approval-summary", {
      apiKey: member.apiKey,
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        toolName: "link_customer",
        input: { personId: "approval-a", otherPersonId: "approval-c" },
      }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      summary:
        "Merge two existing customers (admin only): approval-a@example.com and approval-c@example.com",
    });
  });
});
