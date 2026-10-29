import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  applyMigrations,
  authFetch,
  cleanDb,
  createTestEmail,
  createTestPerson,
  createTestSentEmail,
  createTestUser,
  getDb,
} from "./helpers";
import { inboxPermissions } from "../db/inbox-permissions.schema";
import { queryMessages } from "../lib/messages/query";
import { setMailboxState, setUserState } from "../lib/messages/state";
import { snoozeConversations } from "../lib/messages/conversation-state";

/**
 * PATCH /api/mail-state: the inbox list's row actions, stored in the per-message state that /mail and JMAP read
 * (docs/mailbox-state.md § Rows in the inbox list).
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
type Row = RowRef & { unreadCount: number } & Omit<MailState, "type" | "id">;

async function patch(apiKey: string, body: Record<string, unknown>) {
  const res = await authFetch("/api/mail-state", {
    method: "PATCH",
    apiKey,
    body: JSON.stringify(body),
  });
  return {
    status: res.status,
    body: (await res.json()) as {
      data: MailState[];
      undo: UndoStep[];
      error?: string;
      partial?: boolean;
    },
  };
}

async function grouped(apiKey: string, query = "") {
  const res = await authFetch(`/api/people/grouped${query}`, { apiKey });
  expect(res.status).toBe(200);
  return (await res.json()) as { data: Row[]; total: number };
}

async function folderIds(apiKey: string, folder: string) {
  return (await grouped(apiKey, `?folder=${folder}`)).data.map((r) => r.id);
}

/** Replay an undo the way the UI does, through /api/messages. */
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

async function receivedAt(id: string, at: number) {
  await env.DB.prepare("UPDATE emails SET received_at = ? WHERE id = ?")
    .bind(at, id)
    .run();
}

async function mailboxRow(id: string) {
  return env.DB.prepare(
    "SELECT archived_at, trashed_at, spam_at FROM mailbox_message_state WHERE message_id = ?",
  )
    .bind(id)
    .first<{
      archived_at: number | null;
      trashed_at: number | null;
      spam_at: number | null;
    }>();
}

async function grant(userId: string, email: string) {
  await getDb()
    .insert(inboxPermissions)
    .values({ userId, email, createdAt: NOW, createdBy: null });
}

const person = (id: string): RowRef => ({ type: "person", id });
const group = (id: string): RowRef => ({ type: "group", id });

describe("mail-state router", () => {
  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDb();
  });

  async function admin() {
    return createTestUser({ id: "ms-admin", email: "ms-admin@example.com" });
  }

  it("1. archives a person row everywhere; new mail brings the row back", async () => {
    const { apiKey, userId } = await admin();
    await createTestPerson({ id: "p1", email: "p1@example.com" });
    await createTestEmail({ id: "e1", personId: "p1", recipient: INBOX });
    await createTestEmail({
      id: "e2",
      personId: "p1",
      recipient: INBOX,
      messageId: "m2",
    });
    const changesBefore = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM jmap_changes WHERE object_id = 'received:e1'",
    ).first<{ n: number }>();

    const res = await patch(apiKey, { items: [person("p1")], archived: true });
    expect(res.status).toBe(200);
    expect(res.body.data[0]).toMatchObject({ type: "person", id: "p1" });
    expect(res.body.data[0].archivedAt).toBeGreaterThan(0);
    expect((await mailboxRow("e1"))?.archived_at).toBeGreaterThan(0);
    expect((await mailboxRow("e2"))?.archived_at).toBeGreaterThan(0);
    expect(await folderIds(apiKey, "archive")).toEqual(["p1"]);
    expect(await folderIds(apiKey, "inbox")).toEqual([]);

    const page = await queryMessages(
      getDb(),
      { isAdmin: true },
      {
        folder: "archive",
        viewer: { userId },
      },
    );
    expect(page.messages.map((m) => m.ref.id).sort()).toEqual(["e1", "e2"]);
    const changesAfter = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM jmap_changes WHERE object_id = 'received:e1'",
    ).first<{ n: number }>();
    expect(changesAfter!.n).toBeGreaterThan(changesBefore!.n);

    await createTestEmail({
      id: "e3",
      personId: "p1",
      recipient: INBOX,
      messageId: "m3",
    });
    expect(await folderIds(apiKey, "inbox")).toEqual(["p1"]);
    expect(await folderIds(apiKey, "archive")).toEqual([]);
    expect((await mailboxRow("e1"))?.archived_at).toBeGreaterThan(0);
  });

  it("2. undo restores exactly what the action changed", async () => {
    const { apiKey, userId } = await admin();
    await createTestPerson({ id: "p1", email: "p1@example.com" });
    await createTestEmail({ id: "a", personId: "p1", recipient: INBOX });
    await createTestEmail({
      id: "b",
      personId: "p1",
      recipient: INBOX,
      messageId: "mb",
    });
    const refA = [{ kind: "received" as const, id: "a" }];
    await setMailboxState(getDb(), { isAdmin: true }, userId, refA, {
      archived: true,
    });

    // Archive, then undo: B is back in Inbox, A stays archived.
    let res = await patch(apiKey, { items: [person("p1")], archived: true });
    expect(res.body.undo).toEqual([
      { kind: "mailbox", refs: ["received:b"], change: { archived: false } },
    ]);
    await replay(apiKey, res.body.undo);
    expect((await mailboxRow("a"))?.archived_at).toBeGreaterThan(0);
    expect((await mailboxRow("b"))?.archived_at).toBeNull();

    // Trash, then undo: only what was untrashed comes back.
    await setMailboxState(getDb(), { isAdmin: true }, userId, refA, {
      trashed: true,
    });
    res = await patch(apiKey, { items: [person("p1")], trashed: true });
    expect(res.body.undo).toEqual([
      { kind: "mailbox", refs: ["received:b"], change: { trashed: false } },
    ]);
    expect(await folderIds(apiKey, "trash")).toEqual(["p1"]);
    await replay(apiKey, res.body.undo);
    expect((await mailboxRow("a"))?.trashed_at).toBeGreaterThan(0);
    expect((await mailboxRow("b"))?.trashed_at).toBeNull();
    await setMailboxState(getDb(), { isAdmin: true }, userId, refA, {
      trashed: false,
    });

    // Snooze then archive in one request: undo un-archives B and wakes the
    // conversation, and A stays archived.
    const until = NOW + 3600;
    res = await patch(apiKey, {
      items: [person("p1")],
      snoozedUntil: until,
    });
    expect(res.status).toBe(200);
    // Snooze moved the row out of Archive: A was un-archived.
    expect((await mailboxRow("a"))?.archived_at).toBeNull();
    expect(await folderIds(apiKey, "snoozed")).toEqual(["p1"]);
    await replay(apiKey, res.body.undo);
    expect((await mailboxRow("a"))?.archived_at).toBeGreaterThan(0);
    expect(await folderIds(apiKey, "snoozed")).toEqual([]);
    expect(await folderIds(apiKey, "inbox")).toEqual(["p1"]);

    res = await patch(apiKey, {
      items: [person("p1")],
      snoozedUntil: until,
    });
    expect(res.status).toBe(200);
    const archived = await patch(apiKey, {
      items: [person("p1")],
      archived: true,
    });
    await replay(apiKey, archived.body.undo);
    // Undoing the archive leaves the snooze from before it.
    expect(await folderIds(apiKey, "snoozed")).toEqual(["p1"]);
    expect((await mailboxRow("b"))?.archived_at).toBeNull();
  });

  it("3. trashes and restores a group row with received and sent messages", async () => {
    const { apiKey } = await admin();
    await createTestPerson({ id: "p1", email: "p1@example.com" });
    await createTestEmail({
      id: "g-in",
      personId: "p1",
      recipient: INBOX,
      conversationId: "conv-1",
    });
    await createTestSentEmail({
      id: "g-out",
      personId: "p1",
      fromAddress: INBOX,
      conversationId: "conv-1",
    });

    const res = await patch(apiKey, {
      items: [group("conv-1")],
      trashed: true,
    });
    expect(res.status).toBe(200);
    expect(res.body.data[0].trashedAt).toBeGreaterThan(0);
    expect((await mailboxRow("g-in"))?.trashed_at).toBeGreaterThan(0);
    expect((await mailboxRow("g-out"))?.trashed_at).toBeGreaterThan(0);
    expect(await folderIds(apiKey, "trash")).toEqual(["conv-1"]);
    expect(await folderIds(apiKey, "all")).toEqual([]);

    const back = await patch(apiKey, {
      items: [group("conv-1")],
      trashed: false,
    });
    expect(back.body.data[0].trashedAt).toBeNull();
    expect((await mailboxRow("g-in"))?.trashed_at).toBeNull();
    expect((await mailboxRow("g-out"))?.trashed_at).toBeNull();
    expect(await folderIds(apiKey, "inbox")).toEqual(["conv-1"]);
  });

  it("4. star is personal; unstar clears every starred message of the row", async () => {
    const { apiKey, userId } = await admin();
    const other = await createTestUser({
      id: "ms-other",
      email: "ms-other@example.com",
    });
    await createTestPerson({ id: "p1", email: "p1@example.com" });
    await createTestEmail({ id: "old", personId: "p1", recipient: INBOX });
    await createTestEmail({
      id: "new",
      personId: "p1",
      recipient: INBOX,
      messageId: "m-new",
    });
    await receivedAt("old", NOW - 100);
    await setUserState(getDb(), userId, [{ kind: "received", id: "old" }], {
      starred: true,
    });

    const res = await patch(apiKey, { items: [person("p1")], starred: true });
    expect(res.body.data[0].starred).toBe(true);
    // Only the latest message is starred by the request.
    expect(res.body.undo).toEqual([
      { kind: "user", refs: ["received:new"], change: { starred: false } },
    ]);
    expect(await folderIds(apiKey, "starred")).toEqual(["p1"]);
    expect(await folderIds(other.apiKey, "starred")).toEqual([]);
    expect(
      (await grouped(other.apiKey)).data.find((r) => r.id === "p1")!.starred,
    ).toBe(false);

    const off = await patch(apiKey, { items: [person("p1")], starred: false });
    expect(off.body.data[0].starred).toBe(false);
    expect(off.body.undo[0].refs.sort()).toEqual(
      ["received:new", "received:old"].sort(),
    );
    expect(await folderIds(apiKey, "starred")).toEqual([]);
  });

  it("5. snoozes every thread of a row and wakes them", async () => {
    const { apiKey } = await admin();
    await createTestPerson({ id: "p1", email: "p1@example.com" });
    await createTestEmail({ id: "t1", personId: "p1", recipient: INBOX });
    await createTestEmail({
      id: "t2",
      personId: "p1",
      recipient: INBOX,
      messageId: "m-t2",
    });
    await env.DB.prepare(
      "UPDATE emails SET thread_key = CASE id WHEN 't1' THEN 'thread-a' ELSE 'thread-b' END WHERE id IN ('t1', 't2')",
    ).run();
    const until = NOW + 7200;

    const res = await patch(apiKey, {
      items: [person("p1")],
      snoozedUntil: until,
    });
    expect(res.status).toBe(200);
    const keys = await env.DB.prepare(
      "SELECT conversation_key, snoozed_until FROM inbox_conversation_state ORDER BY conversation_key",
    ).all<{ conversation_key: string; snoozed_until: number }>();
    expect(keys.results).toEqual([
      { conversation_key: "thread-a", snoozed_until: until },
      { conversation_key: "thread-b", snoozed_until: until },
    ]);
    expect(res.body.data[0].snoozedUntil).toBe(until);
    expect(await folderIds(apiKey, "snoozed")).toEqual(["p1"]);
    expect(await folderIds(apiKey, "inbox")).toEqual([]);

    // One thread snoozed later: the row shows the earlier wake time.
    await env.DB.prepare(
      "UPDATE inbox_conversation_state SET snoozed_until = ? WHERE conversation_key = 'thread-b'",
    )
      .bind(until + 600)
      .run();
    const snoozed = await grouped(apiKey, "?folder=snoozed");
    expect(snoozed.data[0].snoozedUntil).toBe(until);

    const woken = await patch(apiKey, {
      items: [person("p1")],
      snoozedUntil: null,
    });
    expect(woken.body.data[0].snoozedUntil).toBeNull();
    expect(await folderIds(apiKey, "inbox")).toEqual(["p1"]);
  });

  it("6. a 400 writes nothing", async () => {
    const { apiKey } = await admin();
    await createTestPerson({ id: "p1", email: "p1@example.com" });
    await createTestEmail({ id: "e1", personId: "p1", recipient: INBOX });

    const res = await patch(apiKey, {
      items: [person("p1")],
      trashed: true,
      snoozedUntil: NOW - 60,
    });
    expect(res.status).toBe(400);
    expect(await mailboxRow("e1")).toBeNull();

    // 5,001 messages in one row.
    await createTestPerson({ id: "big", email: "big@example.com" });
    const values: string[] = [];
    for (let i = 0; i < 5001; i++) {
      values.push(
        `('big-${i}', 'big', '${INBOX}', 's', '', '{}', 'big-${i}@x', 0, ${NOW}, ${NOW})`,
      );
    }
    for (let start = 0; start < values.length; start += 500) {
      await env.DB.prepare(
        `INSERT INTO emails (id, person_id, recipient, subject, body_text, raw_headers, message_id, is_read, received_at, created_at) VALUES ${values
          .slice(start, start + 500)
          .join(",")}`,
      ).run();
    }
    const big = await patch(apiKey, { items: [person("big")], trashed: true });
    expect(big.status).toBe(400);
    const touched = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM mailbox_message_state",
    ).first<{ n: number }>();
    expect(touched!.n).toBe(0);
  });

  it("7. a failure in the second chunk answers 500 partial; the same request finishes", async () => {
    const { apiKey } = await admin();
    await createTestPerson({ id: "p1", email: "p1@example.com" });
    for (let i = 0; i < 45; i++) {
      await createTestEmail({
        id: `c-${String(i).padStart(2, "0")}`,
        personId: "p1",
        recipient: INBOX,
        messageId: `c-${i}@x`,
      });
    }
    // Messages come newest first, then by id descending: c-00 is in the
    // second chunk of 40.
    await env.DB.exec(
      "CREATE TRIGGER fail_c00 BEFORE INSERT ON mailbox_message_state WHEN NEW.message_id = 'c-00' BEGIN SELECT RAISE(ABORT, 'injected'); END",
    );
    const body = { items: [person("p1")], archived: true };
    const failed = await patch(apiKey, body);
    expect(failed.status).toBe(500);
    expect(failed.body.partial).toBe(true);
    const half = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM mailbox_message_state WHERE archived_at IS NOT NULL",
    ).first<{ n: number }>();
    expect(half!.n).toBe(40);

    await env.DB.exec("DROP TRIGGER fail_c00");
    const done = await patch(apiKey, body);
    expect(done.status).toBe(200);
    const all = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM mailbox_message_state WHERE archived_at IS NOT NULL",
    ).first<{ n: number }>();
    expect(all!.n).toBe(45);
    expect(await folderIds(apiKey, "archive")).toEqual(["p1"]);

    // A failure in the response's state read, after the write committed, is
    // partial too: user_row_pins is missing only while that read runs.
    await env.DB.exec("ALTER TABLE user_row_pins RENAME TO user_row_pins_off");
    let unarchive: Awaited<ReturnType<typeof patch>>;
    try {
      unarchive = await patch(apiKey, {
        items: [person("p1")],
        archived: false,
      });
    } finally {
      await env.DB.exec(
        "ALTER TABLE user_row_pins_off RENAME TO user_row_pins",
      );
    }
    expect(unarchive.status).toBe(500);
    expect(unarchive.body.partial).toBe(true);
    const unarchived = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM mailbox_message_state WHERE archived_at IS NOT NULL",
    ).first<{ n: number }>();
    expect(unarchived!.n).toBe(0);
  });

  it("8. spam puts a row in no folder", async () => {
    const { apiKey, userId } = await admin();
    await createTestPerson({ id: "spammy", email: "spammy@example.com" });
    await createTestEmail({ id: "s1", personId: "spammy", recipient: INBOX });
    const ref = [{ kind: "received" as const, id: "s1" }];
    await setUserState(getDb(), userId, ref, { starred: true });
    await setMailboxState(getDb(), { isAdmin: true }, userId, ref, {
      spam: true,
    });
    for (const folder of ["all", "inbox", "starred", "trash", "archive"]) {
      expect(await folderIds(apiKey, folder), folder).toEqual([]);
    }

    await createTestPerson({ id: "p2", email: "p2@example.com" });
    await createTestEmail({
      id: "keep",
      personId: "p2",
      recipient: INBOX,
      messageId: "keep",
    });
    await createTestEmail({
      id: "junk",
      personId: "p2",
      recipient: INBOX,
      messageId: "junk",
    });
    const junk = [{ kind: "received" as const, id: "junk" }];
    await setMailboxState(getDb(), { isAdmin: true }, userId, junk, {
      spam: true,
      trashed: true,
    });
    expect(await folderIds(apiKey, "trash")).toEqual([]);
    expect(await folderIds(apiKey, "inbox")).toEqual(["p2"]);
  });

  it("9. filters and orders before paging; totals, ids and the badge agree", async () => {
    const { apiKey } = await admin();
    for (let i = 1; i <= 4; i++) {
      await createTestPerson({ id: `p${i}`, email: `p${i}@example.com` });
      await createTestEmail({
        id: `e${i}`,
        personId: `p${i}`,
        recipient: INBOX,
        messageId: `e${i}@x`,
        isRead: i === 3 ? 1 : 0,
      });
      await receivedAt(`e${i}`, NOW - 1000 + i);
    }
    // p1 is the oldest row: pin it. p4 (newest) is archived.
    await patch(apiKey, { items: [person("p1")], pinned: true });
    await patch(apiKey, { items: [person("p4")], archived: true });
    // p2's only unread message is archived too, but p2 also has a read one.
    await createTestEmail({
      id: "e2-read",
      personId: "p2",
      recipient: INBOX,
      messageId: "e2-read@x",
      isRead: 1,
    });
    await receivedAt("e2-read", NOW - 2000);
    await setMailboxState(
      getDb(),
      { isAdmin: true },
      null,
      [{ kind: "received", id: "e2" }],
      { archived: true },
    );
    // p5 has an awake read thread and a snoozed unread one: in Inbox, but
    // with nothing unread there (the snoozed thread is hidden, as in /mail).
    await createTestPerson({ id: "p5", email: "p5@example.com" });
    await createTestEmail({
      id: "e5-read",
      personId: "p5",
      recipient: INBOX,
      messageId: "e5-read@x",
      isRead: 1,
    });
    await createTestEmail({
      id: "e5-snoozed",
      personId: "p5",
      recipient: INBOX,
      messageId: "e5-snoozed@x",
      isRead: 0,
    });
    await env.DB.prepare(
      "UPDATE emails SET thread_key = CASE id WHEN 'e5-read' THEN 'thread-r' ELSE 'thread-s' END, received_at = ? WHERE id IN ('e5-read', 'e5-snoozed')",
    )
      .bind(NOW - 3000)
      .run();
    await snoozeConversations(
      getDb(),
      { isAdmin: true },
      null,
      [{ kind: "received", id: "e5-snoozed" }],
      NOW + 3600,
    );

    const first = await grouped(apiKey, "?folder=inbox&limit=1");
    expect(first.total).toBe(4);
    expect(first.data.map((r) => r.id)).toEqual(["p1"]);
    const all = await grouped(apiKey, "?folder=inbox&limit=10");
    expect(all.data.map((r) => r.id)).toEqual(["p1", "p3", "p2", "p5"]);
    expect(all.data.find((r) => r.id === "p2")!.unreadCount).toBe(0);
    expect(all.data.find((r) => r.id === "p3")!.unreadCount).toBe(0);
    expect(all.data.find((r) => r.id === "p5")!.unreadCount).toBe(0);

    // The ids carry each row's pin, so a whole-folder pin can be undone.
    expect(
      (await patch(apiKey, { items: [person("p3")], pinned: true })).status,
    ).toBe(200);
    const ids = await authFetch("/api/people/grouped/ids?folder=inbox", {
      apiKey,
    });
    const idsBody = (await ids.json()) as {
      total: number;
      data: Array<{ id: string; pinned: boolean }>;
    };
    expect(idsBody.total).toBe(4);
    expect(
      Object.fromEntries(idsBody.data.map((r) => [r.id, r.pinned])),
    ).toEqual({ p1: true, p2: false, p3: true, p5: false });

    const unread = await grouped(apiKey, "?folder=inbox&unread=1");
    expect(unread.data.map((r) => r.id)).toEqual(["p1"]);
    const stats = await authFetch("/api/stats", { apiKey });
    expect(((await stats.json()) as { unreadCount: number }).unreadCount).toBe(
      1,
    );
  });

  it("10. a row in an inbox the caller cannot see is skipped", async () => {
    await admin();
    const member = await createTestUser({
      id: "ms-member",
      email: "ms-member@example.com",
      role: "member",
    });
    await grant(member.userId, INBOX);
    await createTestPerson({ id: "py", email: "py@example.com" });
    await createTestEmail({ id: "y1", personId: "py", recipient: OTHER });

    const res = await patch(member.apiKey, {
      items: [person("py")],
      trashed: true,
      starred: true,
      pinned: true,
    });
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([
      {
        type: "person",
        id: "py",
        starred: false,
        pinned: false,
        archivedAt: null,
        snoozedUntil: null,
        trashedAt: null,
      },
    ]);
    expect(res.body.undo).toEqual([]);
    expect(await mailboxRow("y1")).toBeNull();
    const pins = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM user_row_pins",
    ).first<{ n: number }>();
    expect(pins!.n).toBe(0);
  });

  it("12. pins are personal, put the row first in inbox, and go with the person", async () => {
    const { apiKey } = await admin();
    const other = await createTestUser({
      id: "ms-other",
      email: "ms-other@example.com",
    });
    for (const [id, at] of [
      ["p-old", NOW - 500],
      ["p-new", NOW - 10],
    ] as const) {
      await createTestPerson({ id, email: `${id}@example.com` });
      await createTestEmail({
        id: `${id}-m`,
        personId: id,
        recipient: INBOX,
        messageId: `${id}@x`,
      });
      await receivedAt(`${id}-m`, at);
    }
    const res = await patch(apiKey, { items: [person("p-old")], pinned: true });
    expect(res.body.data[0].pinned).toBe(true);
    expect(await folderIds(apiKey, "inbox")).toEqual(["p-old", "p-new"]);
    expect(await folderIds(other.apiKey, "inbox")).toEqual(["p-new", "p-old"]);

    const del = await authFetch("/api/people/p-old", {
      method: "DELETE",
      apiKey,
    });
    expect(del.status).toBe(200);
    const pins = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM user_row_pins",
    ).first<{ n: number }>();
    expect(pins!.n).toBe(0);
  });
});
