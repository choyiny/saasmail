import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import {
  applyMigrations,
  cleanDb,
  createTestUser,
  createTestPerson,
  createTestEmail,
  authFetch,
  getDb,
} from "./helpers";
import { emails } from "../db/emails.schema";
import { eq } from "drizzle-orm";

function patchState(apiKey: string, body: Record<string, unknown>) {
  return authFetch("/api/mail-state", {
    apiKey,
    method: "PATCH",
    body: JSON.stringify(body),
  });
}

async function grouped(apiKey: string, folder?: string) {
  const qs = folder ? `?folder=${folder}` : "";
  const res = await authFetch(`/api/people/grouped${qs}`, { apiKey });
  expect(res.status).toBe(200);
  const body = await res.json();
  return body.data as Array<Record<string, any>>;
}

describe("mail state", () => {
  let apiKey: string;

  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDb();
    ({ apiKey } = await createTestUser());
    await createTestPerson({ id: "p-alice", email: "alice@example.com" });
    await createTestPerson({
      id: "p-bob",
      email: "bob@example.com",
      name: "Bob",
    });
    await createTestEmail({
      id: "e-alice",
      personId: "p-alice",
      messageId: "a@x",
      subject: "Invoice question",
      bodyText: "Hi there,\n\n  could you resend the invoice?",
    });
    await createTestEmail({ id: "e-bob", personId: "p-bob", messageId: "b@x" });
  });

  it("returns default state, subject and snippet on grouped rows", async () => {
    const rows = await grouped(apiKey);
    const alice = rows.find((r) => r.id === "p-alice")!;
    expect(alice.starred).toBe(false);
    expect(alice.pinned).toBe(false);
    expect(alice.archivedAt).toBeNull();
    expect(alice.snoozedUntil).toBeNull();
    expect(alice.hasSent).toBe(false);
    expect(alice.latestSubject).toBe("Invoice question");
    expect(alice.snippet).toBe("Hi there, could you resend the invoice?");
  });

  it("stars and pins rows; starred folder and inbox pin order follow", async () => {
    let res = await patchState(apiKey, {
      items: [{ type: "person", id: "p-alice" }],
      starred: true,
    });
    expect(res.status).toBe(200);
    const { data } = await res.json();
    expect(data).toEqual([
      expect.objectContaining({ id: "p-alice", starred: true, pinned: false }),
    ]);

    const starred = await grouped(apiKey, "starred");
    expect(starred.map((r) => r.id)).toEqual(["p-alice"]);

    res = await patchState(apiKey, {
      items: [{ type: "person", id: "p-bob" }],
      pinned: true,
    });
    expect(res.status).toBe(200);
    const inbox = await grouped(apiKey, "inbox");
    expect(inbox[0].id).toBe("p-bob");
    expect(inbox[0].pinned).toBe(true);
    // Starring did not clear when another field changed on another row.
    expect(inbox.find((r) => r.id === "p-alice")!.starred).toBe(true);
  });

  it("archive hides a row from the inbox until new mail arrives", async () => {
    await patchState(apiKey, {
      items: [{ type: "person", id: "p-alice" }],
      archived: true,
    });
    expect((await grouped(apiKey, "inbox")).map((r) => r.id)).toEqual([
      "p-bob",
    ]);
    expect((await grouped(apiKey, "archive")).map((r) => r.id)).toEqual([
      "p-alice",
    ]);
    // "all" ignores state, so existing callers see every row.
    expect(await grouped(apiKey)).toHaveLength(2);

    // A newer email brings the thread back.
    await createTestEmail({
      id: "e-alice-2",
      personId: "p-alice",
      messageId: "a2@x",
    });
    await getDb()
      .update(emails)
      .set({ receivedAt: Math.floor(Date.now() / 1000) + 60 })
      .where(eq(emails.id, "e-alice-2"));
    const inbox = await grouped(apiKey, "inbox");
    expect(inbox.map((r) => r.id).sort()).toEqual(["p-alice", "p-bob"]);
    expect(await grouped(apiKey, "archive")).toHaveLength(0);
  });

  it("snooze hides a row until the time passes; unsnooze brings it back", async () => {
    const later = Math.floor(Date.now() / 1000) + 3600;
    await patchState(apiKey, {
      items: [{ type: "person", id: "p-alice" }],
      snoozedUntil: later,
    });
    expect((await grouped(apiKey, "inbox")).map((r) => r.id)).toEqual([
      "p-bob",
    ]);
    const snoozed = await grouped(apiKey, "snoozed");
    expect(snoozed.map((r) => r.id)).toEqual(["p-alice"]);
    expect(snoozed[0].snoozedUntil).toBe(later);

    // A snooze time in the past counts as awake.
    await patchState(apiKey, {
      items: [{ type: "person", id: "p-alice" }],
      snoozedUntil: Math.floor(Date.now() / 1000) - 5,
    });
    expect(await grouped(apiKey, "inbox")).toHaveLength(2);

    await patchState(apiKey, {
      items: [{ type: "person", id: "p-alice" }],
      snoozedUntil: null,
    });
    expect(await grouped(apiKey, "snoozed")).toHaveLength(0);
  });

  it("keeps state per user", async () => {
    const other = await createTestUser({
      id: "test-user-2",
      email: "two@example.com",
    });
    await patchState(apiKey, {
      items: [{ type: "person", id: "p-alice" }],
      archived: true,
    });
    expect(await grouped(other.apiKey, "inbox")).toHaveLength(2);
    expect(await grouped(apiKey, "inbox")).toHaveLength(1);
  });

  it("rejects an empty item list", async () => {
    const res = await patchState(apiKey, { items: [], starred: true });
    expect(res.status).toBe(400);
  });
});

describe("user preferences", () => {
  let apiKey: string;

  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDb();
    ({ apiKey } = await createTestUser());
  });

  it("returns defaults, then saves a partial update", async () => {
    let res = await authFetch("/api/user/preferences", { apiKey });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      uiTheme: "default",
      colorMode: "system",
      density: "comfortable",
      palette: "navy",
      layoutSettings: {},
      tabSeen: {},
    });

    res = await authFetch("/api/user/preferences", {
      apiKey,
      method: "PATCH",
      body: JSON.stringify({ uiTheme: "outlook" }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).uiTheme).toBe("outlook");

    res = await authFetch("/api/user/preferences", {
      apiKey,
      method: "PATCH",
      body: JSON.stringify({ colorMode: "dark" }),
    });
    expect(await res.json()).toEqual({
      uiTheme: "outlook",
      colorMode: "dark",
      density: "comfortable",
      palette: "navy",
      layoutSettings: {},
      tabSeen: {},
    });
  });

  it("rejects an unknown theme", async () => {
    const res = await authFetch("/api/user/preferences", {
      apiKey,
      method: "PATCH",
      body: JSON.stringify({ uiTheme: "yahoo" }),
    });
    expect(res.status).toBe(400);
  });
});

describe("grouped list filters for the mail layouts", () => {
  let apiKey: string;

  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDb();
    ({ apiKey } = await createTestUser());
    await createTestPerson({
      id: "p-ann",
      email: "ann@example.com",
      name: "Ann",
    });
    await createTestPerson({
      id: "p-news",
      email: "news@shop.example",
      name: "Shop",
    });
    await createTestPerson({
      id: "p-bot",
      email: "no-reply@service.example",
      name: "Service",
    });
    await createTestPerson({
      id: "p-li",
      email: "messages@linkedin.com",
      name: "LinkedIn",
    });
    await createTestEmail({ id: "e-ann", personId: "p-ann", messageId: "1@x" });
    await createTestEmail({
      id: "e-news",
      personId: "p-news",
      messageId: "2@x",
      recipient: "sales@saasmail.test",
      rawHeaders: JSON.stringify({ "list-unsubscribe": "<mailto:u@x>" }),
    });
    await createTestEmail({ id: "e-bot", personId: "p-bot", messageId: "3@x" });
    await createTestEmail({
      id: "e-li",
      personId: "p-li",
      messageId: "4@x",
      isRead: 1,
    });
  });

  it("assigns Gmail-style categories and filters by them", async () => {
    const all = await grouped(apiKey);
    const cat = Object.fromEntries(all.map((r) => [r.id, r.category]));
    expect(cat).toEqual({
      "p-ann": "primary",
      "p-news": "promotions",
      "p-bot": "updates",
      "p-li": "social",
    });
    const res = await authFetch("/api/people/grouped?category=promotions", {
      apiKey,
    });
    const { data } = await res.json();
    expect(data.map((r: any) => r.id)).toEqual(["p-news"]);
  });

  it("filters by sender", async () => {
    const res = await authFetch("/api/people/grouped?from=linkedin", {
      apiKey,
    });
    const { data } = await res.json();
    expect(data.map((r: any) => r.id)).toEqual(["p-li"]);
  });

  it("reports unread counts per inbox in stats", async () => {
    const res = await authFetch("/api/stats", { apiKey });
    const body = await res.json();
    expect(body.inboxUnread).toEqual({
      "inbox@saasmail.test": 2,
      "sales@saasmail.test": 1,
    });
  });
});

describe("categorize", () => {
  it("follows bulk and notification inboxes only when every inbox agrees", async () => {
    const { categorize } = await import("../routers/people-router");
    expect(categorize(["ann@acme.test"], false, ["newsletter@us.com"])).toBe(
      "promotions",
    );
    expect(categorize(["ann@acme.test"], false, ["notifications@us.com"])).toBe(
      "updates",
    );
    expect(
      categorize(["ann@acme.test"], false, [
        "newsletter@us.com",
        "support@us.com",
      ]),
    ).toBe("primary");
  });
});

describe("trash, whole-folder ids, overrides, tab counts, settings", () => {
  let apiKey: string;

  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDb();
    ({ apiKey } = await createTestUser());
    await createTestPerson({ id: "p-a", email: "a@acme.test", name: "A" });
    await createTestPerson({ id: "p-b", email: "b@acme.test", name: "B" });
    await createTestEmail({
      id: "e-a",
      personId: "p-a",
      messageId: "a@m",
      subject: "Invoice overdue",
    });
    await createTestEmail({
      id: "e-b",
      personId: "p-b",
      messageId: "b@m",
      subject: "Hello",
      isRead: 1,
    });
  });

  const get = async (qs: string) => {
    const res = await authFetch(`/api/people/grouped?${qs}`, { apiKey });
    expect(res.status).toBe(200);
    return res.json();
  };

  it("trash hides a row everywhere but Trash, and untrash restores it", async () => {
    await patchState(apiKey, {
      items: [{ type: "person", id: "p-a" }],
      trashed: true,
    });
    expect((await get("folder=inbox")).data.map((r: any) => r.id)).toEqual([
      "p-b",
    ]);
    expect((await get("folder=trash")).data.map((r: any) => r.id)).toEqual([
      "p-a",
    ]);
    await patchState(apiKey, {
      items: [{ type: "person", id: "p-a" }],
      trashed: false,
    });
    expect((await get("folder=inbox")).data).toHaveLength(2);
  });

  it("filters by subject, starred, and date window on the server", async () => {
    expect((await get("subject=invoice")).data.map((r: any) => r.id)).toEqual([
      "p-a",
    ]);
    await patchState(apiKey, {
      items: [{ type: "person", id: "p-b" }],
      starred: true,
    });
    expect((await get("starred=1")).data.map((r: any) => r.id)).toEqual([
      "p-b",
    ]);
    const future = Math.floor(Date.now() / 1000) + 3600;
    expect((await get(`after=${future}`)).data).toHaveLength(0);
    expect((await get(`before=${future}`)).data).toHaveLength(2);
  });

  it("lists every matching id for whole-folder actions", async () => {
    const res = await authFetch("/api/people/grouped/ids?unread=1", {
      apiKey,
    });
    const body = await res.json();
    expect(body.data).toEqual([{ type: "person", id: "p-a", unread: true }]);
    expect(body.truncated).toBe(false);
  });

  it("applies the caller's category corrections", async () => {
    const res = await authFetch("/api/people/category", {
      apiKey,
      method: "PUT",
      body: JSON.stringify({ senders: ["A@acme.test"], category: "updates" }),
    });
    expect(res.status).toBe(200);
    const rows = (await get("category=updates")).data;
    expect(rows.map((r: any) => r.id)).toEqual(["p-a"]);
  });

  it("counts unread and new-since-viewed per tab", async () => {
    let body = await get("folder=inbox&withTabCounts=1");
    expect(body.tabCounts.primary).toEqual({ unread: 1, new: 1 });
    await authFetch("/api/user/preferences", {
      apiKey,
      method: "PATCH",
      body: JSON.stringify({
        tabSeen: { primary: Math.floor(Date.now() / 1000) + 60 },
      }),
    });
    body = await get("folder=inbox&withTabCounts=1");
    expect(body.tabCounts.primary).toEqual({ unread: 1, new: 0 });
  });

  it("merges layout settings by layout", async () => {
    const patch = (b: unknown) =>
      authFetch("/api/user/preferences", {
        apiKey,
        method: "PATCH",
        body: JSON.stringify(b),
      });
    await patch({ layoutSettings: { gmail: { readingPane: "right" } } });
    const res = await patch({ layoutSettings: { outlook: { pane: "off" } } });
    const body = await res.json();
    expect(body.layoutSettings).toEqual({
      gmail: { readingPane: "right" },
      outlook: { pane: "off" },
    });
  });
});
