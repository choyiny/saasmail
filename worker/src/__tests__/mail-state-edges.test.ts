import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  applyMigrations,
  authFetch,
  cleanDb,
  createTestEmail,
  createTestPerson,
  createTestUser,
  getDb,
} from "./helpers";
import { inboxPermissions } from "../db/inbox-permissions.schema";
import { snoozeConversations } from "../lib/messages/conversation-state";

/**
 * Edges of the inbox list's row actions (docs/mailbox-state.md § Rows in the
 * inbox list): a row whose mail spans an inbox the caller cannot see, and
 * Undo replayed after mixed snooze states and another user's edit.
 */

const INBOX = "support@saasmail.test";
const OTHER = "sales@saasmail.test";
const NOW = Math.floor(Date.now() / 1000);

type RowRef = { type: "person" | "group"; id: string };
type MailState = RowRef & {
  starred: boolean;
  pinned: boolean;
  archivedAt: number | null;
  snoozedUntil: number | null;
  trashedAt: number | null;
};
type UndoStep =
  | {
      kind: "mailbox";
      refs: string[];
      change: { archived: boolean } | { trashed: boolean };
    }
  | { kind: "user"; refs: string[]; change: { starred: boolean } }
  | { kind: "snooze"; refs: string[]; until: number | null };

const person = (id: string): RowRef => ({ type: "person", id });
const group = (id: string): RowRef => ({ type: "group", id });

async function patch(apiKey: string, body: Record<string, unknown>) {
  const res = await authFetch("/api/mail-state", {
    method: "PATCH",
    apiKey,
    body: JSON.stringify(body),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as { data: MailState[]; undo: UndoStep[] };
}

async function folderIds(apiKey: string, folder: string) {
  const res = await authFetch(`/api/people/grouped?folder=${folder}`, {
    apiKey,
  });
  expect(res.status).toBe(200);
  return ((await res.json()) as { data: RowRef[] }).data.map((r) => r.id);
}

/** Replay an undo the way the UI does (undoMailState), via /api/messages. */
async function replay(apiKey: string, undo: UndoStep[]) {
  for (const step of [...undo].reverse()) {
    const [path, body] =
      step.kind === "mailbox"
        ? ["/api/messages/mailbox-state", { refs: step.refs, ...step.change }]
        : step.kind === "user"
          ? ["/api/messages/user-state", { refs: step.refs, ...step.change }]
          : ["/api/messages/snooze", { refs: step.refs, until: step.until }];
    const res = await authFetch(path, {
      method: "POST",
      apiKey,
      body: JSON.stringify(body),
    });
    expect(res.status, path).toBe(200);
  }
}

async function mailboxRow(id: string) {
  return env.DB.prepare(
    "SELECT archived_at, trashed_at FROM mailbox_message_state WHERE message_id = ?",
  )
    .bind(id)
    .first<{ archived_at: number | null; trashed_at: number | null }>();
}

async function setTime(
  table: "emails" | "sent_emails",
  id: string,
  at: number,
) {
  const column = table === "emails" ? "received_at" : "sent_at";
  await env.DB.prepare(`UPDATE ${table} SET ${column} = ? WHERE id = ?`)
    .bind(at, id)
    .run();
}

async function snoozes() {
  return (
    await env.DB.prepare(
      "SELECT inbox, conversation_key, snoozed_until FROM inbox_conversation_state ORDER BY inbox, conversation_key",
    ).all<{
      inbox: string;
      conversation_key: string;
      snoozed_until: number | null;
    }>()
  ).results;
}

describe("mail-state row actions at their edges", () => {
  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDb();
  });

  it("a member acting on a row that spans an inbox they cannot see touches and reports only their inbox", async () => {
    const admin = await createTestUser({
      id: "edge-admin",
      email: "edge-admin@example.com",
    });
    const member = await createTestUser({
      id: "edge-member",
      email: "edge-member@example.com",
      role: "member",
    });
    await getDb().insert(inboxPermissions).values({
      userId: member.userId,
      email: INBOX,
      createdAt: NOW,
      createdBy: null,
    });
    await createTestPerson({ id: "p", email: "p@example.com" });
    await createTestEmail({
      id: "e-x",
      personId: "p",
      recipient: INBOX,
      messageId: "e-x@x",
    });
    // The newest message of the row is in the inbox the member cannot see:
    // star must not pick it.
    await createTestEmail({
      id: "e-y",
      personId: "p",
      recipient: OTHER,
      messageId: "e-y@x",
    });
    await setTime("emails", "e-x", NOW - 100);
    await setTime("emails", "e-y", NOW - 10);

    const res = await patch(member.apiKey, {
      items: [person("p")],
      trashed: true,
      starred: true,
      pinned: true,
    });
    expect(res.undo).toEqual([
      { kind: "mailbox", refs: ["received:e-x"], change: { trashed: false } },
      { kind: "user", refs: ["received:e-x"], change: { starred: false } },
    ]);
    // The member sees every message of their part of the row trashed.
    expect(res.data[0]).toMatchObject({ pinned: true, starred: true });
    expect(res.data[0].trashedAt).toBeGreaterThan(0);
    expect(await mailboxRow("e-y")).toBeNull();
    expect(await folderIds(member.apiKey, "trash")).toEqual(["p"]);
    // The admin's view of the same person row still has e-y in its Inbox.
    expect(await folderIds(admin.apiKey, "trash")).toEqual([]);
    expect(await folderIds(admin.apiKey, "inbox")).toEqual(["p"]);

    await patch(member.apiKey, { items: [person("p")], trashed: false });
    const until = NOW + 3600;
    const snoozed = await patch(member.apiKey, {
      items: [person("p")],
      snoozedUntil: until,
    });
    expect(snoozed.undo).toEqual([
      { kind: "snooze", refs: ["received:e-x"], until: null },
    ]);
    // Only the member's inbox's conversation is snoozed.
    expect(await snoozes()).toEqual([
      { inbox: INBOX, conversation_key: "p:p", snoozed_until: until },
    ]);
    expect(await folderIds(member.apiKey, "snoozed")).toEqual(["p"]);
    expect(await folderIds(admin.apiKey, "inbox")).toEqual(["p"]);

    const archived = await patch(member.apiKey, {
      items: [person("p")],
      archived: true,
    });
    expect(archived.undo).toEqual([
      { kind: "mailbox", refs: ["received:e-x"], change: { archived: false } },
    ]);
    expect(await mailboxRow("e-y")).toBeNull();

    // A group row whose conversation id also holds mail in the other inbox:
    // the member's trash stops at their inbox too.
    await createTestEmail({
      id: "g-x",
      personId: "p",
      recipient: INBOX,
      messageId: "g-x@x",
      conversationId: "conv-shared",
    });
    await createTestEmail({
      id: "g-y",
      personId: "p",
      recipient: OTHER,
      messageId: "g-y@x",
      conversationId: "conv-shared",
    });
    const groupRes = await patch(member.apiKey, {
      items: [group("conv-shared")],
      trashed: true,
    });
    expect(groupRes.undo).toEqual([
      { kind: "mailbox", refs: ["received:g-x"], change: { trashed: false } },
    ]);
    expect(await mailboxRow("g-y")).toBeNull();
    // The admin's pins, stars and trash are untouched by the member's.
    const adminRow = (
      (await (
        await authFetch("/api/people/grouped?folder=all", {
          apiKey: admin.apiKey,
        })
      ).json()) as { data: MailState[] }
    ).data.find((r) => r.id === "p")!;
    expect(adminRow).toMatchObject({
      starred: false,
      pinned: false,
      trashedAt: null,
    });
  });

  it("undo restores each conversation's own previous snooze and leaves another user's edit to other messages alone", async () => {
    const { apiKey, userId } = await createTestUser({
      id: "undo-admin",
      email: "undo-admin@example.com",
    });
    const other = await createTestUser({
      id: "undo-other",
      email: "undo-other@example.com",
    });
    await createTestPerson({ id: "p", email: "p@example.com" });
    for (const id of ["ta", "tb", "tc"]) {
      await createTestEmail({
        id,
        personId: "p",
        recipient: INBOX,
        messageId: `${id}@x`,
      });
    }
    await env.DB.prepare(
      "UPDATE emails SET thread_key = 'thread-' || substr(id, 2) WHERE id IN ('ta', 'tb', 'tc')",
    ).run();
    await setTime("emails", "ta", NOW - 30);
    await setTime("emails", "tb", NOW - 20);
    await setTime("emails", "tc", NOW - 10);
    const t1 = NOW + 3600;
    const t2 = NOW + 7200;
    // Thread a was already snoozed to t1; threads b and c are awake.
    await snoozeConversations(
      getDb(),
      { isAdmin: true },
      userId,
      [{ kind: "received", id: "ta" }],
      t1,
    );

    const res = await patch(apiKey, { items: [person("p")], snoozedUntil: t2 });
    expect(res.data[0].snoozedUntil).toBe(t2);
    const steps = res.undo.map((s) => ({
      ...s,
      refs: [...s.refs].sort(),
    }));
    expect(steps).toHaveLength(2);
    expect(steps).toEqual(
      expect.arrayContaining([
        { kind: "snooze", refs: ["received:ta"], until: t1 },
        {
          kind: "snooze",
          refs: ["received:tb", "received:tc"],
          until: null,
        },
      ]),
    );

    // Another user archives tc before the undo.
    const edit = await authFetch("/api/messages/mailbox-state", {
      method: "POST",
      apiKey: other.apiKey,
      body: JSON.stringify({ refs: ["received:tc"], archived: true }),
    });
    expect(edit.status).toBe(200);

    await replay(apiKey, res.undo);
    expect(await snoozes()).toEqual([
      { inbox: INBOX, conversation_key: "thread-a", snoozed_until: t1 },
      { inbox: INBOX, conversation_key: "thread-b", snoozed_until: null },
      { inbox: INBOX, conversation_key: "thread-c", snoozed_until: null },
    ]);
    expect((await mailboxRow("tc"))?.archived_at).toBeGreaterThan(0);
    // Thread b is awake in Inbox again; a is still snoozed to t1.
    expect(await folderIds(apiKey, "inbox")).toEqual(["p"]);
  });
});
