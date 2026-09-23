import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { users } from "../db/auth.schema";
import { drafts } from "../db/drafts.schema";
import { emailTemplates } from "../db/email-templates.schema";
import { inboxPermissions } from "../db/inbox-permissions.schema";
import { mailboxes } from "../db/mailboxes.schema";
import { senderIdentities } from "../db/sender-identities.schema";
import { createAgentTools, AGENT_TOOL_NAMES } from "../lib/agent/tools";
import { AGENT_PLAYBOOK_INTRO, AGENT_PLAYBOOKS } from "../lib/agent/playbook";
import { upsertDraft } from "../lib/drafts";
import {
  applyMigrations,
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

  it("exposes the locked Stage 2 tool surface with no send/trash/delete tool", async () => {
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
});
