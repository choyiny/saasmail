import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
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
import { emails } from "../db/emails.schema";
import { inboxPermissions } from "../db/inbox-permissions.schema";
import { senderIdentities } from "../db/sender-identities.schema";

/**
 * The grouped list (GET /api/people/grouped and /grouped/ids) reads each
 * row's latest subject and snippet, its group participants and its subject
 * matches only from the caller's inboxes; its state folders hold only rows
 * whose messages carry that state (docs/mailbox-state.md). A member
 * granted one inbox must not learn the subject or body of mail that the
 * same person sent to an inbox they cannot see.
 */

type Row = {
  type: "person" | "group";
  id: string;
  latestSubject?: string | null;
  snippet?: string | null;
  participants?: Array<{ email: string }>;
  starred: boolean;
  pinned: boolean;
  archivedAt: number | null;
  snoozedUntil: number | null;
  trashedAt: number | null;
};

const NOW = Math.floor(Date.now() / 1000);

async function grantInbox(userId: string, email: string) {
  await getDb().insert(inboxPermissions).values({
    userId,
    email,
    createdAt: NOW,
    createdBy: null,
  });
}

async function createInbox(email: string) {
  await getDb().insert(senderIdentities).values({
    email,
    displayName: null,
    createdAt: NOW,
    updatedAt: NOW,
  });
}

async function receivedAt(id: string, at: number) {
  await getDb().update(emails).set({ receivedAt: at }).where(eq(emails.id, id));
}

async function grouped(apiKey: string, qs = "") {
  const res = await authFetch(`/api/people/grouped${qs}`, { apiKey });
  expect(res.status).toBe(200);
  return (await res.json()) as { data: Row[]; total: number };
}

beforeEach(async () => {
  await applyMigrations();
  await cleanDb();
});

describe("grouped list for a member with one inbox", () => {
  it("reads subjects, snippets, participants and subject matches only from the member's inboxes, and takes no state folder", async () => {
    const admin = await createTestUser({ id: "u-admin", role: "admin" });
    const member = await createTestUser({
      id: "u-mem",
      role: "member",
      email: "m@x.com",
    });
    await createInbox("a@x.com");
    await createInbox("b@x.com");
    await grantInbox(member.userId, "a@x.com");

    // Alice wrote to both inboxes; the newest mail is in b@ (not granted).
    await createTestPerson({ id: "p-alice", email: "alice@ext.test" });
    await createTestEmail({
      id: "e-pub",
      personId: "p-alice",
      recipient: "a@x.com",
      subject: "Public hello",
      bodyText: "visible body",
      messageId: "pub@ext.test",
    });
    await receivedAt("e-pub", NOW - 300);
    await createTestEmail({
      id: "e-priv",
      personId: "p-alice",
      recipient: "b@x.com",
      subject: "Private payroll",
      bodyText: "secret body",
      messageId: "priv@ext.test",
    });
    await receivedAt("e-priv", NOW - 100);
    await createTestSentEmail({
      id: "s-priv",
      personId: "p-alice",
      fromAddress: "b@x.com",
      toAddress: "alice@ext.test",
      subject: "Private sent",
      bodyText: "secret sent body",
      sentAt: NOW - 50,
    });

    // A group thread with mail in both inboxes; Bob only wrote to b@.
    await createTestPerson({ id: "p-carol", email: "carol@ext.test" });
    await createTestPerson({ id: "p-bob", email: "bob@ext.test" });
    await createTestEmail({
      id: "e-g1",
      personId: "p-carol",
      recipient: "a@x.com",
      conversationId: "conv-1",
      subject: "Shared group",
      messageId: "g1@ext.test",
    });
    await receivedAt("e-g1", NOW - 200);
    await createTestEmail({
      id: "e-g2",
      personId: "p-bob",
      recipient: "b@x.com",
      conversationId: "conv-1",
      subject: "Private group reply",
      messageId: "g2@ext.test",
    });
    await receivedAt("e-g2", NOW - 20);

    const mine = await grouped(member.apiKey);
    const alice = mine.data.find((r) => r.id === "p-alice")!;
    expect(alice.latestSubject).toBe("Public hello");
    expect(alice.snippet).toBe("visible body");
    const conv = mine.data.find((r) => r.id === "conv-1")!;
    expect(conv.type).toBe("group");
    expect(conv.latestSubject).toBe("Shared group");
    expect(conv.participants!.map((p) => p.email)).toEqual(["carol@ext.test"]);
    // No row carries mail state yet.
    for (const r of mine.data) {
      expect(r).toMatchObject({
        starred: false,
        pinned: false,
        archivedAt: null,
        snoozedUntil: null,
        trashedAt: null,
      });
    }

    // Subject search: a match only in b@ finds nothing for the member.
    expect((await grouped(member.apiKey, "?subject=Private")).total).toBe(0);
    expect(
      (await grouped(member.apiKey, "?subject=Public")).data.map((r) => r.id),
    ).toEqual(["p-alice"]);
    const ids = await authFetch("/api/people/grouped/ids?subject=Private", {
      apiKey: member.apiKey,
    });
    expect(((await ids.json()) as { total: number }).total).toBe(0);
    // Mail sent from b@ does not make Alice a Sent row for the member.
    expect((await grouped(member.apiKey, "?folder=sent")).total).toBe(0);

    // The admin sees every inbox: the newest subjects, every match.
    const all = await grouped(admin.apiKey);
    expect(all.data.find((r) => r.id === "p-alice")!.latestSubject).toBe(
      "Private sent",
    );
    expect(all.data.find((r) => r.id === "conv-1")!.latestSubject).toBe(
      "Private group reply",
    );
    // (A thread with mail in two inboxes is one row per inbox.)
    const adminHits = (await grouped(admin.apiKey, "?subject=Private")).data;
    expect([...new Set(adminHits.map((r) => r.id))].sort()).toEqual([
      "conv-1",
      "p-alice",
    ]);
    expect(
      (await grouped(admin.apiKey, "?folder=sent")).data.map((r) => r.id),
    ).toEqual(["p-alice"]);
    // Outlook's "Empty Deleted Items" deletes every person that
    // /grouped/ids?folder=trash returns: with nothing starred, snoozed,
    // archived or trashed, a state folder is empty, never every row.
    for (const path of ["/api/people/grouped", "/api/people/grouped/ids"]) {
      for (const folder of ["starred", "snoozed", "archive", "trash"]) {
        const res = await authFetch(`${path}?folder=${folder}`, {
          apiKey: admin.apiKey,
        });
        expect(res.status, `${path}?folder=${folder}`).toBe(200);
        expect(((await res.json()) as { total: number }).total).toBe(0);
      }
      const inbox = await authFetch(`${path}?folder=inbox`, {
        apiKey: admin.apiKey,
      });
      expect(inbox.status).toBe(200);
      expect(((await inbox.json()) as { total: number }).total).toBe(3);
    }
  });
});
