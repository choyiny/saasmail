import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { users } from "../db/auth.schema";
import { drafts } from "../db/drafts.schema";
import { emailTemplates } from "../db/email-templates.schema";
import { listMembers } from "../db/list-members.schema";
import { lists } from "../db/lists.schema";
import { sequences } from "../db/sequences.schema";
import { inboxPermissions } from "../db/inbox-permissions.schema";
import { customerPeople, customers } from "../db/customers.schema";
import { mailboxes } from "../db/mailboxes.schema";
import { senderIdentities } from "../db/sender-identities.schema";
import { suppressions } from "../db/suppressions.schema";
import { createAgentTools, AGENT_TOOL_NAMES } from "../lib/agent/tools";
import { AGENT_PLAYBOOK_INTRO, AGENT_PLAYBOOKS } from "../lib/agent/playbook";
import { upsertDraft } from "../lib/drafts";
import {
  applyMigrations,
  authFetch,
  cleanDb,
  createTestEmail,
  createTestPerson,
  createTestUser,
  getDb,
} from "./helpers";

const ALLOWED = "allowed@example.com";
const DENIED = "denied@example.com";

async function execute(
  tools: ReturnType<typeof createAgentTools>,
  name: string,
  input: Record<string, unknown> = {},
) {
  const entry = (tools as any)[name];
  if (!entry?.execute) throw new Error(`Tool ${name} has no execute function`);
  return entry.execute(input, {});
}

describe("agent tools", () => {
  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDb();
  });

  async function fixture() {
    const member = await createTestUser({
      id: "agent-tools-member",
      email: "agent-tools-member@example.com",
      role: "member",
    });
    const other = await createTestUser({
      id: "agent-tools-other",
      email: "agent-tools-other@example.com",
      role: "member",
    });
    const db = getDb();
    const now = Math.floor(Date.now() / 1000);

    await db.insert(inboxPermissions).values({
      userId: member.userId,
      email: ALLOWED,
      createdAt: now,
      createdBy: null,
    });
    await db.insert(senderIdentities).values([
      {
        email: ALLOWED,
        displayName: "Allowed",
        createdAt: now,
        updatedAt: now,
      },
      {
        email: DENIED,
        displayName: "Denied",
        createdAt: now,
        updatedAt: now,
      },
    ]);

    const allowedPerson = await createTestPerson({
      id: "agent-person-allowed",
      email: "allowed-customer@example.net",
      name: "Allowed Customer",
    });
    const deniedPerson = await createTestPerson({
      id: "agent-person-denied",
      email: "denied-customer@example.net",
      name: "Denied Customer",
    });
    await createTestEmail({
      id: "agent-email-allowed",
      personId: allowedPerson.id,
      recipient: ALLOWED,
      subject: "Allowed subject",
      bodyText: "allowed searchable body",
      messageId: "agent-allowed@example.net",
    });
    await createTestEmail({
      id: "agent-email-denied",
      personId: deniedPerson.id,
      recipient: DENIED,
      subject: "Denied subject",
      bodyText: "denied-secret-search-token",
      messageId: "agent-denied@example.net",
    });

    await db.insert(emailTemplates).values([
      {
        id: "agent-template-global",
        slug: "agent-global",
        name: "Global",
        subject: "Global",
        bodyHtml: "<p>Global</p>",
        format: "html",
        bodyJson: null,
        fromAddress: null,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: "agent-template-allowed",
        slug: "agent-allowed",
        name: "Allowed",
        subject: "Allowed",
        bodyHtml: "<p>Allowed</p>",
        format: "html",
        bodyJson: null,
        fromAddress: ALLOWED,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: "agent-template-denied",
        slug: "agent-denied",
        name: "Denied",
        subject: "Denied",
        bodyHtml: "<p>Denied</p>",
        format: "html",
        bodyJson: null,
        fromAddress: DENIED,
        createdAt: now,
        updatedAt: now,
      },
    ]);

    await db.insert(mailboxes).values([
      {
        id: "agent-folder-allowed",
        inbox: ALLOWED,
        name: "Follow up",
        role: null,
        parentId: null,
        sortOrder: 0,
        createdBy: member.userId,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: "agent-folder-denied",
        inbox: DENIED,
        name: "Private",
        role: null,
        parentId: null,
        sortOrder: 0,
        createdBy: other.userId,
        createdAt: now,
        updatedAt: now,
      },
    ]);

    const user = {
      id: member.userId,
      name: "Agent Member",
      email: "agent-tools-member@example.com",
      role: "member",
    };
    return {
      db,
      member,
      other,
      tools: createAgentTools({ db, user }),
      allowedPerson,
      deniedPerson,
    };
  }

  it("exposes the approval-gated CRM surface with no send/trash/delete tool", async () => {
    const { tools } = await fixture();
    expect(Object.keys(tools).sort()).toEqual([...AGENT_TOOL_NAMES].sort());
    expect(
      Object.keys(tools).filter((name) => /send|trash|delete/i.test(name)),
    ).toEqual([]);
  });

  it("only mentions tools that exist in the agent playbook", async () => {
    await fixture();
    const text = [AGENT_PLAYBOOK_INTRO, ...Object.values(AGENT_PLAYBOOKS)].join(
      "\n",
    );
    const mentioned = [...text.matchAll(/\`([a-z][a-z0-9_]*)\(/g)].map(
      (match) => match[1],
    );

    expect(mentioned.length).toBeGreaterThan(0);
    for (const name of mentioned) {
      expect(AGENT_TOOL_NAMES).toContain(name);
    }
  });

  it("lists assignees with the route's scoping and fields", async () => {
    const { db, member, other, tools: agentTools } = await fixture();
    const now = Math.floor(Date.now() / 1000);
    const admin = await createTestUser({
      id: "agent-assignee-admin",
      email: "agent-assignee-admin@example.com",
      role: "admin",
      name: "Admin Assignee",
    });
    await db.insert(inboxPermissions).values({
      userId: other.userId,
      email: ALLOWED,
      createdAt: now,
      createdBy: null,
    });

    const routeResponse = await authFetch(
      `/api/messages/assignees?inbox=${encodeURIComponent(ALLOWED)}`,
      { apiKey: member.apiKey },
    );
    expect(routeResponse.status).toBe(200);
    const routeRows = (await routeResponse.json()) as Array<{
      id: string;
      name: string;
      email: string;
      image: string | null;
    }>;
    const toolRows = (await execute(agentTools, "list_assignees", {
      inbox: ALLOWED.toUpperCase(),
    })) as Array<{ id: string; name: string; email: string }>;

    expect(toolRows).toEqual(
      routeRows.map(({ id, name, email }) => ({ id, name, email })),
    );
    expect(toolRows.map((row) => row.id)).toEqual(
      expect.arrayContaining([member.userId, other.userId, admin.userId]),
    );

    const deniedUser = await createTestUser({
      id: "agent-tools-denied-assignee",
      email: "agent-tools-denied-assignee@example.com",
      role: "member",
      name: "Denied Assignee",
    });
    const deniedTools = createAgentTools({
      db,
      user: {
        id: deniedUser.userId,
        name: "Denied Assignee",
        email: "agent-tools-denied-assignee@example.com",
        role: "member",
      },
    });
    const deniedRoute = await authFetch(
      `/api/messages/assignees?inbox=${encodeURIComponent(ALLOWED)}`,
      { apiKey: deniedUser.apiKey },
    );
    expect(deniedRoute.status).toBe(404);
    await expect(
      execute(deniedTools, "list_assignees", { inbox: ALLOWED }),
    ).rejects.toThrow("Inbox not found");
  });

  it("scopes every read surface to the caller's inbox permissions", async () => {
    const { tools, allowedPerson, deniedPerson } = await fixture();

    expect(await execute(tools, "whoami")).toMatchObject({
      inboxes: [ALLOWED],
    });

    const inboxes = JSON.stringify(await execute(tools, "list_inboxes"));
    expect(inboxes).toContain(ALLOWED);
    expect(inboxes).not.toContain(DENIED);

    const listed = JSON.stringify(await execute(tools, "list_messages"));
    expect(listed).toContain("agent-email-allowed");
    expect(listed).not.toContain("agent-email-denied");

    await expect(
      execute(tools, "read_message", { ref: "received:agent-email-denied" }),
    ).rejects.toThrow("Message not found");

    const searched = JSON.stringify(
      await execute(tools, "search_messages", {
        q: "denied-secret-search-token",
      }),
    );
    expect(searched).not.toContain("agent-email-denied");

    const allowedTimeline = JSON.stringify(
      await execute(tools, "customer_timeline", {
        personId: allowedPerson.id,
      }),
    );
    expect(allowedTimeline).toContain("agent-email-allowed");

    const deniedTimeline = JSON.stringify(
      await execute(tools, "customer_timeline", {
        personId: deniedPerson.id,
      }),
    );
    expect(deniedTimeline).not.toContain("agent-email-denied");

    const templates = JSON.stringify(await execute(tools, "list_templates"));
    expect(templates).toContain("agent-global");
    expect(templates).toContain("agent-allowed");
    expect(templates).not.toContain("agent-denied");

    expect(await execute(tools, "get_playbook")).toContain("saasmail");
  });

  it("uses customer scope in the timeline without widening inbox access", async () => {
    const { db, tools, allowedPerson } = await fixture();
    const now = Math.floor(Date.now() / 1000);
    const alias = await createTestPerson({
      id: "agent-person-alias",
      email: "alias-customer@example.net",
    });
    await createTestEmail({
      id: "agent-alias-allowed",
      personId: alias.id,
      recipient: ALLOWED,
      subject: "Alias allowed",
      bodyText: "linked allowed history",
      messageId: "agent-alias-allowed@example.net",
    });
    await createTestEmail({
      id: "agent-alias-denied",
      personId: alias.id,
      recipient: DENIED,
      subject: "Alias denied",
      bodyText: "linked denied history",
      messageId: "agent-alias-denied@example.net",
    });
    await db.insert(customers).values({
      id: "agent-customer",
      displayName: null,
      createdBy: null,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(customerPeople).values([
      {
        customerId: "agent-customer",
        personId: allowedPerson.id,
        linkedBy: null,
        linkedAt: now,
      },
      {
        customerId: "agent-customer",
        personId: alias.id,
        linkedBy: null,
        linkedAt: now,
      },
    ]);

    const timeline = JSON.stringify(
      await execute(tools, "customer_timeline", {
        personId: allowedPerson.id,
      }),
    );
    expect(timeline).toContain("agent-email-allowed");
    expect(timeline).toContain("agent-alias-allowed");
    expect(timeline).not.toContain("agent-alias-denied");
  });

  it("re-reads role before every tool call so demotion narrows scope immediately", async () => {
    const { db, member } = await fixture();

    await db
      .update(users)
      .set({ role: "admin" })
      .where(eq(users.id, member.userId));

    const tools = createAgentTools({
      db,
      user: {
        id: member.userId,
        name: "Agent Admin",
        email: "agent-tools-member@example.com",
        role: "admin",
      },
    });

    const before = JSON.stringify(await execute(tools, "list_inboxes"));
    expect(before).toContain(ALLOWED);
    expect(before).toContain(DENIED);

    await db
      .update(users)
      .set({ role: "member" })
      .where(eq(users.id, member.userId));

    const afterInboxes = JSON.stringify(await execute(tools, "list_inboxes"));
    expect(afterInboxes).toContain(ALLOWED);
    expect(afterInboxes).not.toContain(DENIED);

    const afterMessages = JSON.stringify(await execute(tools, "list_messages"));
    expect(afterMessages).toContain("agent-email-allowed");
    expect(afterMessages).not.toContain("agent-email-denied");
  });

  it("exposes gated CRM tools and ungated CRM reads", async () => {
    const { db, tools, allowedPerson } = await fixture();
    const now = Math.floor(Date.now() / 1000);

    await db.insert(sequences).values({
      id: "agent-sequence",
      name: "Onboarding",
      steps: JSON.stringify([
        { order: 1, templateSlug: "agent-global", delayHours: 0 },
      ]),
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(lists).values({
      id: "agent-list",
      name: "Beta testers",
      description: null,
      fromAddress: ALLOWED,
      doubleOptIn: 0,
      confirmationTemplateSlug: null,
      archivedAt: null,
      createdAt: now,
      updatedAt: now,
    });

    expect(JSON.stringify(await execute(tools, "list_sequences"))).toContain(
      "Onboarding",
    );
    expect(JSON.stringify(await execute(tools, "list_lists"))).toContain(
      "Beta testers",
    );
    expect(
      await execute(tools, "get_customer", {
        personId: allowedPerson.id,
      }),
    ).toEqual({ customer: null });

    for (const name of [
      "enroll_in_sequence",
      "cancel_sequence_enrollment",
      "add_to_list",
      "assign_conversation",
      "link_customer",
    ]) {
      expect((tools as any)[name].needsApproval).toBe(true);
    }
  });

  it("re-checks permission when an approved CRM action executes", async () => {
    const { db, member, tools, allowedPerson } = await fixture();
    const now = Math.floor(Date.now() / 1000);
    await db.insert(lists).values({
      id: "agent-list-revoked",
      name: "Revoked list",
      description: null,
      fromAddress: ALLOWED,
      doubleOptIn: 0,
      confirmationTemplateSlug: null,
      archivedAt: null,
      createdAt: now,
      updatedAt: now,
    });

    await db
      .delete(inboxPermissions)
      .where(eq(inboxPermissions.userId, member.userId));

    await expect(
      execute(tools, "add_to_list", {
        personId: allowedPerson.id,
        listId: "agent-list-revoked",
      }),
    ).rejects.toThrow(/not found|visible|permission/i);

    const rows = await db
      .select()
      .from(listMembers)
      .where(eq(listMembers.listId, "agent-list-revoked"));
    expect(rows).toEqual([]);
  });

  it("refuses to re-subscribe an unsubscribed list member", async () => {
    const { db, tools, allowedPerson } = await fixture();
    const now = Math.floor(Date.now() / 1000);
    await db.insert(lists).values({
      id: "agent-list-unsubscribed",
      name: "Beta unsubscribed",
      description: null,
      fromAddress: ALLOWED,
      doubleOptIn: 0,
      confirmationTemplateSlug: null,
      archivedAt: null,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(listMembers).values({
      id: "agent-member-unsubscribed",
      listId: "agent-list-unsubscribed",
      contactId: "agent-contact-unsubscribed",
      email: allowedPerson.email.toLowerCase(),
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

    await expect(
      execute(tools, "add_to_list", {
        personId: allowedPerson.id,
        listId: "agent-list-unsubscribed",
      }),
    ).rejects.toThrow(
      "This person unsubscribed from 'Beta unsubscribed'; the agent can't re-subscribe them",
    );

    const [after] = await db
      .select()
      .from(listMembers)
      .where(eq(listMembers.id, "agent-member-unsubscribed"));
    expect(after).toMatchObject({
      status: "unsubscribed",
      unsubscribedAt: now - 10,
      unsubscribeReason: "user",
    });
  });

  it("refuses to add a suppressed address to a list", async () => {
    const { db, tools, allowedPerson } = await fixture();
    const now = Math.floor(Date.now() / 1000);
    await db.insert(lists).values({
      id: "agent-list-suppressed",
      name: "Beta suppressed",
      description: null,
      fromAddress: ALLOWED,
      doubleOptIn: 0,
      confirmationTemplateSlug: null,
      archivedAt: null,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(suppressions).values({
      id: "agent-suppression",
      email: allowedPerson.email.toLowerCase(),
      reason: "unsubscribe",
      source: "test",
      note: null,
      createdAt: now,
    });

    await expect(
      execute(tools, "add_to_list", {
        personId: allowedPerson.id,
        listId: "agent-list-suppressed",
      }),
    ).rejects.toThrow(
      "This person is suppressed; the agent can't subscribe them to 'Beta suppressed'",
    );

    const rows = await db
      .select()
      .from(listMembers)
      .where(eq(listMembers.listId, "agent-list-suppressed"));
    expect(rows).toEqual([]);
  });

  it("treats subscribed and pending list members as no-ops", async () => {
    const { db, tools, allowedPerson } = await fixture();
    const now = Math.floor(Date.now() / 1000);

    for (const status of ["subscribed", "pending"] as const) {
      const listId = `agent-list-${status}`;
      const memberId = `agent-member-${status}`;
      await db.insert(lists).values({
        id: listId,
        name: `Beta ${status}`,
        description: null,
        fromAddress: ALLOWED,
        doubleOptIn: 0,
        confirmationTemplateSlug: null,
        archivedAt: null,
        createdAt: now,
        updatedAt: now,
      });
      await db.insert(listMembers).values({
        id: memberId,
        listId,
        contactId: `agent-contact-${status}`,
        email: allowedPerson.email.toLowerCase(),
        status,
        source: "api",
        formId: null,
        submittedIp: null,
        consentSource: "api",
        consentAt: now - 100,
        importJobId: null,
        subscribedAt: status === "subscribed" ? now - 100 : null,
        confirmedAt: null,
        unsubscribedAt: null,
        unsubscribeReason: null,
        createdAt: now - 100,
      });

      const result = await execute(tools, "add_to_list", {
        personId: allowedPerson.id,
        listId,
      });
      expect(result).toMatchObject({
        success: true,
        alreadyMember: true,
        listId,
        personId: allowedPerson.id,
        memberId,
      });

      const [after] = await db
        .select()
        .from(listMembers)
        .where(eq(listMembers.id, memberId));
      expect(after.status).toBe(status);
      expect(after.subscribedAt).toBe(
        status === "subscribed" ? now - 100 : null,
      );
    }
  });

  it("returns the guard error on a sixth approval-gated execution", async () => {
    const { allowedPerson } = await fixture();
    const guarded = createAgentTools({
      db: getDb(),
      user: {
        id: "agent-tools-member",
        name: "Agent Member",
        email: "agent-tools-member@example.com",
        role: "member",
      },
      gatedCallsAlready: 5,
    });

    const result = await execute(guarded, "cancel_sequence_enrollment", {
      personId: allowedPerson.id,
    });
    expect(result).toMatchObject({
      success: false,
      error: expect.stringMatching(/5 CRM actions.*Ask the user/i),
    });
  });

  it("rejects organise and draft actions against a denied inbox", async () => {
    const { tools } = await fixture();
    const deniedRef = ["received:agent-email-denied"];

    for (const [name, input] of [
      ["set_seen", { refs: deniedRef, seen: true }],
      ["set_starred", { refs: deniedRef, starred: true }],
      ["set_archived", { refs: deniedRef, archived: true }],
      ["set_spam", { refs: deniedRef, spam: true }],
      [
        "snooze",
        {
          refs: deniedRef,
          until: Math.floor(Date.now() / 1000) + 3600,
        },
      ],
      [
        "move_to_folder",
        { refs: deniedRef, mailboxId: "agent-folder-allowed" },
      ],
    ] as const) {
      await expect(execute(tools, name, input as any)).rejects.toThrow();
    }

    await expect(
      execute(tools, "draft_reply", {
        emailId: "agent-email-denied",
        bodyText: "No access",
      }),
    ).rejects.toThrow("Message not found");

    await expect(
      execute(tools, "draft_message", {
        fromAddress: DENIED,
        to: "someone@example.net",
        bodyText: "No access",
      }),
    ).rejects.toThrow();
  });

  it("writes reply and new-message drafts only into the caller's drafts", async () => {
    const { db, member, other, tools } = await fixture();

    const reply = (await execute(tools, "draft_reply", {
      emailId: "agent-email-allowed",
      bodyText: "Reply body",
    })) as { saved: boolean; contextKey: string };
    expect(reply.saved).toBe(true);
    expect(reply.contextKey).toBe("reply:agent-email-allowed");

    const fresh = (await execute(tools, "draft_message", {
      fromAddress: ALLOWED,
      to: "new-customer@example.net",
      subject: "New draft",
      bodyText: "Draft body",
    })) as { id: string; contextKey: string };
    expect(fresh.contextKey).toBe(`draft:${fresh.id}`);

    const mine = await db
      .select()
      .from(drafts)
      .where(eq(drafts.userId, member.userId));
    expect(mine.map((row) => row.contextKey).sort()).toEqual(
      [fresh.contextKey, reply.contextKey].sort(),
    );

    const theirs = await db
      .select()
      .from(drafts)
      .where(eq(drafts.userId, other.userId));
    expect(theirs).toEqual([]);
  });

  it("preserves a caller's non-empty human reply draft", async () => {
    const { db, member, tools } = await fixture();

    const existing = await upsertDraft(db, member.userId, {
      contextKey: "reply:agent-email-allowed",
      fromAddress: ALLOWED,
      to: "allowed-customer@example.net",
      subject: "Human subject",
      bodyHtml: "<p>Human in-progress reply</p>",
      bodyText: "Human in-progress reply",
      replyToEmailId: "agent-email-allowed",
    });

    const result = await execute(tools, "draft_reply", {
      emailId: "agent-email-allowed",
      bodyText: "Agent replacement",
    });

    expect(result).toEqual({
      saved: false,
      reason: "existing_draft",
      draftId: existing.id,
    });

    const [after] = await db
      .select()
      .from(drafts)
      .where(eq(drafts.id, existing.id));
    expect(after).toMatchObject({
      toAddress: "allowed-customer@example.net",
      subject: "Human subject",
      bodyHtml: "<p>Human in-progress reply</p>",
      bodyText: "Human in-progress reply",
    });
  });

  it("returns typed customer-link errors cleanly for non-admin merges and self-links", async () => {
    const { db, tools, allowedPerson } = await fixture();
    const now = Math.floor(Date.now() / 1000);
    for (const id of ["agent-merge-a", "agent-merge-b"]) {
      await createTestPerson({ id, email: `${id}@example.net` });
      await createTestEmail({
        id: `${id}-mail`,
        personId: id,
        recipient: ALLOWED,
        messageId: `${id}@example.test`,
      });
    }
    const primaryAlias = await createTestPerson({
      id: "agent-primary-alias",
      email: "agent-primary-alias@example.net",
    });
    await createTestEmail({
      id: "agent-primary-alias-mail",
      personId: primaryAlias.id,
      recipient: ALLOWED,
      messageId: "agent-primary-alias@example.test",
    });
    await db.insert(customers).values([
      {
        id: "agent-primary-customer",
        displayName: null,
        createdBy: null,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: "agent-other-customer",
        displayName: null,
        createdBy: null,
        createdAt: now,
        updatedAt: now,
      },
    ]);
    await db.insert(customerPeople).values([
      {
        customerId: "agent-primary-customer",
        personId: allowedPerson.id,
        linkedBy: null,
        linkedAt: now,
      },
      {
        customerId: "agent-primary-customer",
        personId: primaryAlias.id,
        linkedBy: null,
        linkedAt: now,
      },
      {
        customerId: "agent-other-customer",
        personId: "agent-merge-a",
        linkedBy: null,
        linkedAt: now,
      },
      {
        customerId: "agent-other-customer",
        personId: "agent-merge-b",
        linkedBy: null,
        linkedAt: now,
      },
    ]);

    expect(
      await execute(tools, "link_customer", {
        personId: allowedPerson.id,
        otherPersonId: "agent-merge-a",
      }),
    ).toEqual({
      success: false,
      error: "Merging two customers requires an admin",
      code: "CUSTOMER_MERGE_REQUIRES_ADMIN",
    });

    expect(
      await execute(tools, "link_customer", {
        personId: allowedPerson.id,
        otherPersonId: allowedPerson.id,
      }),
    ).toEqual({
      success: false,
      error: "Cannot link a person to themselves",
    });
  });
});
