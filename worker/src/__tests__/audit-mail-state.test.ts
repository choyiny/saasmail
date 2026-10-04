// docs/specs/SPEC-audit-log.md §2 and §3: who is recorded as acting, and the
// events for changes to shared mail state.
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { asc, sql } from "drizzle-orm";
import { auditEvents } from "../db/audit-events.schema";
import { httpActor, ruleActor } from "../lib/audit/actors";
import { runWithAudit } from "../lib/audit/context";
import { collectAudit } from "../lib/audit/record";
import {
  assignConversations,
  snoozeConversations,
} from "../lib/messages/conversation-state";
import {
  createMailbox,
  setMailboxMembership,
  setMailboxState,
  setSystemSpamState,
} from "../lib/messages/state";
import type { MessageRef } from "../lib/messages/types";
import {
  applyMigrations,
  authFetch,
  cleanDb,
  createTestEmail,
  createTestPerson,
  createTestUser,
  getDb,
} from "./helpers";

const ADMIN = { isAdmin: true as const };
const INBOX = "support@saasmail.test";
const OTHER = "billing@saasmail.test";

const received = (id: string): MessageRef => ({ kind: "received", id });

async function events() {
  const rows = await getDb()
    .select()
    .from(auditEvents)
    .orderBy(asc(auditEvents.action), asc(auditEvents.inbox));
  return rows.map((row) => ({
    ...row,
    details: row.details ? JSON.parse(row.details) : null,
  }));
}

describe("httpActor", () => {
  const user = { id: "u1", email: "jane@acme.com", name: "Jane" };
  const request = new Request("https://mail.test/api/x", {
    headers: { "cf-connecting-ip": "203.0.113.7", "user-agent": "Firefox" },
  });

  it("is the person on the web for a session", () => {
    expect(httpActor({ user, authMethod: "session" }, request)).toEqual({
      actorType: "user",
      actorUserId: "u1",
      actorLabel: "jane@acme.com",
      channel: "web",
      ip: "203.0.113.7",
      userAgent: "Firefox",
    });
  });

  it("names the admin behind an impersonated session", () => {
    expect(
      httpActor(
        {
          user,
          authMethod: "session",
          impersonatedBy: { id: "u-admin", email: "admin@acme.com" },
        },
        request,
      ),
    ).toMatchObject({
      actorType: "user",
      actorUserId: "u-admin",
      actorLabel: "admin@acme.com as jane@acme.com",
      channel: "web",
    });
  });

  it("is the API key, named by its prefix, for a key", () => {
    expect(
      httpActor(
        {
          user,
          authMethod: "apiKey",
          apiKey: { id: "k1", prefix: "sk_abcde..." },
        },
        request,
      ),
    ).toMatchObject({
      actorType: "api_key",
      actorUserId: "u1",
      actorLabel: "API key sk_abcde...",
      channel: "api",
      apiKeyId: "k1",
    });
  });
});

describe("audit events for shared mail state", () => {
  let userId: string;
  let apiKey: string;

  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDb();
    ({ userId, apiKey } = await createTestUser());
    await createTestPerson({ id: "p1", email: "alice@example.com" });
    for (const id of ["e1", "e2", "e3"]) {
      await createTestEmail({
        id,
        personId: "p1",
        recipient: INBOX,
        messageId: `${id}@example.com`,
      });
    }
    await createTestEmail({
      id: "o1",
      personId: "p1",
      recipient: OTHER,
      messageId: "o1@example.com",
    });
  });

  it("records a request made with an API key as that key, once for the batch", async () => {
    const res = await authFetch("/api/messages/mailbox-state", {
      apiKey,
      method: "POST",
      headers: { "cf-connecting-ip": "203.0.113.9" },
      body: JSON.stringify({
        refs: ["received:e1", "received:e2", "received:e3"],
        archived: true,
      }),
    });
    expect(res.status).toBe(200);

    const rows = await events();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actorType: "api_key",
      actorUserId: userId,
      channel: "api",
      action: "mail.archived",
      targetType: "message",
      targetId: null,
      inbox: INBOX,
      summary: `Archived 3 messages in ${INBOX}`,
      ip: "203.0.113.9",
    });
    expect(rows[0].actorLabel).toMatch(/^API key sk_/);
    expect(rows[0].details).toEqual({
      count: 3,
      refs: ["received:e1", "received:e2", "received:e3"],
    });
  });

  it("names the one message when there is only one", async () => {
    await setMailboxState(getDb(), ADMIN, userId, [received("e1")], {
      trashed: true,
    });
    const [row] = await events();
    expect(row).toMatchObject({
      action: "mail.trashed",
      targetId: "received:e1",
      summary: `Moved 1 message to Trash in ${INBOX}`,
      details: null,
    });
  });

  it("writes one row per inbox", async () => {
    await setMailboxState(
      getDb(),
      ADMIN,
      userId,
      [received("e1"), received("o1")],
      { spam: true },
    );
    const rows = await events();
    expect(rows.map((row) => [row.action, row.inbox])).toEqual([
      ["mail.spam", OTHER],
      ["mail.spam", INBOX],
    ]);
  });

  it("records nothing for the system's own junk filing", async () => {
    await setSystemSpamState(getDb(), INBOX, "e1");
    await setMailboxState(getDb(), ADMIN, null, [received("e2")], {
      archived: true,
    });
    expect(await events()).toEqual([]);
  });

  it("records a rule's junk mark under the rule's name, and not its filing", async () => {
    await runWithAudit(
      ruleActor({ id: "r1", name: "Block vendors" }),
      async () => {
        await setMailboxState(getDb(), ADMIN, null, [received("e1")], {
          spam: true,
        });
        await setMailboxState(getDb(), ADMIN, null, [received("e2")], {
          archived: true,
        });
      },
    );
    const rows = await events();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actorType: "rule",
      actorUserId: null,
      actorLabel: "rule Block vendors",
      channel: "rule",
      action: "mail.spam",
      targetId: "received:e1",
    });
  });

  it("records a cleared flag only for messages that had it", async () => {
    await setMailboxState(getDb(), ADMIN, userId, [received("e1")], {
      archived: true,
    });
    await getDb().delete(auditEvents);

    // What a JMAP move to Inbox sends: every flag cleared, for a message that
    // was archived and one that was in none of these states.
    await setMailboxState(
      getDb(),
      ADMIN,
      userId,
      [received("e1"), received("e2")],
      { archived: false, spam: false, trashed: false },
    );
    const rows = await events();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: "mail.unarchived",
      targetId: "received:e1",
      summary: `Moved 1 message out of Archive in ${INBOX}`,
    });
  });

  it("records nothing when nothing changes", async () => {
    const folder = await createMailbox(getDb(), ADMIN, userId, {
      inbox: INBOX,
      name: "Invoices",
    });
    const until = Math.floor(Date.now() / 1000) + 3600;
    await setMailboxState(getDb(), ADMIN, userId, [received("e1")], {
      archived: true,
    });
    await setMailboxMembership(getDb(), ADMIN, userId, [received("e1")], {
      add: [folder.id],
    });
    await snoozeConversations(getDb(), ADMIN, userId, [received("e1")], until);
    await assignConversations(getDb(), ADMIN, userId, [received("e1")], userId);
    await getDb().delete(auditEvents);

    // The same again: every one of these is already so.
    await setMailboxState(getDb(), ADMIN, userId, [received("e1")], {
      archived: true,
    });
    await setMailboxMembership(getDb(), ADMIN, userId, [received("e1")], {
      add: [folder.id],
    });
    await snoozeConversations(getDb(), ADMIN, userId, [received("e1")], until);
    await assignConversations(getDb(), ADMIN, userId, [received("e1")], userId);
    // And undoing what was never done.
    await setMailboxState(getDb(), ADMIN, userId, [received("e2")], {
      trashed: false,
    });
    await setMailboxMembership(getDb(), ADMIN, userId, [received("e2")], {
      remove: [folder.id],
    });
    expect(await events()).toEqual([]);
  });

  it("counts only the messages that changed in a mixed batch", async () => {
    await setMailboxState(getDb(), ADMIN, userId, [received("e1")], {
      archived: true,
    });
    await getDb().delete(auditEvents);

    await setMailboxState(
      getDb(),
      ADMIN,
      userId,
      [received("e1"), received("e2"), received("e3")],
      { archived: true },
    );
    const [row] = await events();
    expect(row.summary).toBe(`Archived 2 messages in ${INBOX}`);
    expect(row.details).toEqual({
      count: 2,
      refs: ["received:e2", "received:e3"],
    });
  });

  it("still changes the state when the audit's own read fails", async () => {
    await setMailboxState(getDb(), ADMIN, userId, [received("e1")], {
      archived: true,
    });
    await getDb().delete(auditEvents);

    // The only raw query on this path is the audit's look at the old flags.
    const real = getDb();
    const flaky = new Proxy(real, {
      get(target, property, receiver) {
        if (property === "all") {
          return () => {
            throw new Error("D1 hiccup");
          };
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(
      setMailboxState(flaky, ADMIN, userId, [received("e1")], {
        archived: false,
      }),
    ).resolves.toBeUndefined();
    warn.mockRestore();

    const [state] = await real.all<{ archived_at: number | null }>(
      sql`SELECT archived_at FROM mailbox_message_state WHERE message_id = 'e1'`,
    );
    expect(state.archived_at).toBeNull();
    // What changed is unknown, so nothing is claimed.
    expect(await events()).toEqual([]);
  });

  it("merges per-message calls into one row inside collectAudit", async () => {
    await collectAudit(getDb(), async () => {
      for (const id of ["e1", "e2", "e3"]) {
        await setMailboxState(getDb(), ADMIN, userId, [received(id)], {
          archived: true,
        });
      }
    });
    const rows = await events();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: "mail.archived",
      targetId: null,
      summary: `Archived 3 messages in ${INBOX}`,
    });
    expect(rows[0].details.count).toBe(3);
  });

  it("records filing into and out of a folder", async () => {
    const folder = await createMailbox(getDb(), ADMIN, userId, {
      inbox: INBOX,
      name: "Invoices",
    });
    await getDb().delete(auditEvents);

    await setMailboxMembership(getDb(), ADMIN, userId, [received("e1")], {
      add: [folder.id],
    });
    await setMailboxMembership(
      getDb(),
      ADMIN,
      userId,
      [received("e1"), received("e2")],
      { remove: [folder.id] },
    );
    // A rule filing mail is routine and not recorded.
    await setMailboxMembership(getDb(), ADMIN, null, [received("e3")], {
      add: [folder.id],
    });

    // Only e1 was in the folder, so only e1 was removed from it.
    const rows = await events();
    expect(rows.map((row) => row.summary).sort()).toEqual([
      "Filed 1 message into 'Invoices'",
      "Removed 1 message from 'Invoices'",
    ]);
    expect(rows.every((row) => row.action === "mail.moved")).toBe(true);
    expect(rows.every((row) => row.inbox === INBOX)).toBe(true);
  });

  it("records snooze, unsnooze, assign and unassign", async () => {
    const until = Math.floor(Date.now() / 1000) + 3600;
    await snoozeConversations(getDb(), ADMIN, userId, [received("e1")], until);
    await snoozeConversations(getDb(), ADMIN, userId, [received("e1")], null);
    await assignConversations(getDb(), ADMIN, userId, [received("e1")], userId);
    await assignConversations(getDb(), ADMIN, userId, [received("e1")], null);
    // A rule's snooze and assignment are routine.
    await snoozeConversations(getDb(), ADMIN, null, [received("e1")], until);
    await assignConversations(getDb(), ADMIN, null, [received("e1")], userId);

    const rows = await events();
    expect(rows.map((row) => row.action)).toEqual([
      "mail.assigned",
      "mail.snoozed",
      "mail.unassigned",
      "mail.unsnoozed",
    ]);
    expect(rows.every((row) => row.targetType === "conversation")).toBe(true);
    expect(rows[0].details).toMatchObject({ assigneeUserId: userId });
    expect(rows[0].summary).toBe(
      `Assigned 1 conversation in ${INBOX} to test@example.com`,
    );
    expect(rows[1].details).toEqual({ until });
  });
});
