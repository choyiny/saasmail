// docs/inboxes.md, "Test inboxes": an admin turns an empty, Cloudflare-routed
// inbox into a test inbox; the switch is checked on the resulting state.
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
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
import { senderIdentities } from "../db/sender-identities.schema";
import { emails } from "../db/emails.schema";
import { pruneTestMail } from "../lib/test-mail";

const INBOX = "e2e@saasmail.test";

function patch(apiKey: string, body: unknown, inbox = INBOX) {
  return authFetch(`/api/admin/inboxes/${encodeURIComponent(inbox)}`, {
    apiKey,
    method: "PATCH",
    body: JSON.stringify(body),
  });
}

async function identity(inbox = INBOX) {
  const [row] = await getDb()
    .select()
    .from(senderIdentities)
    .where(eq(senderIdentities.email, inbox));
  return row;
}

async function addIdentity(
  values: Partial<typeof senderIdentities.$inferInsert> = {},
) {
  const now = Math.floor(Date.now() / 1000);
  await getDb()
    .insert(senderIdentities)
    .values({ email: INBOX, createdAt: now, updatedAt: now, ...values });
}

let apiKey = "";

beforeAll(async () => {
  await applyMigrations();
});

beforeEach(async () => {
  await cleanDb();
  apiKey = (await createTestUser({ role: "admin" })).apiKey;
});

describe("PATCH /api/admin/inboxes/{email} — purpose", () => {
  it("turns an empty inbox into a test inbox, lists it, and audits the change", async () => {
    const res = await patch(apiKey, { purpose: "test", testRetentionDays: 5 });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      purpose: "test",
      testRetentionDays: 5,
    });
    expect(await identity()).toMatchObject({
      purpose: "test",
      testRetentionDays: 5,
    });

    const list = (await (
      await authFetch("/api/admin/inboxes", { apiKey })
    ).json()) as Array<{ email: string; purpose: string }>;
    expect(list.find((r) => r.email === INBOX)?.purpose).toBe("test");

    const audit = await env.DB.prepare(
      "SELECT details FROM audit_events WHERE action = 'inbox.updated' AND target_id = ?",
    )
      .bind(INBOX)
      .first<{ details: string }>();
    expect(JSON.parse(audit!.details)).toMatchObject({
      purpose: { from: "mail", to: "test" },
    });
  });

  it("refuses purpose test on a Gmail-mapped inbox (400)", async () => {
    await addIdentity({ source: "gmail", gmailAccountId: "g-1" });
    const res = await patch(apiKey, { purpose: "test" });
    expect(res.status).toBe(400);
    expect((await identity()).purpose).toBe("mail");
  });

  it("refuses purpose test in the same PATCH that maps the inbox to Gmail (400)", async () => {
    const res = await patch(apiKey, {
      source: "gmail",
      gmailAccountId: "g-1",
      purpose: "test",
    });
    expect(res.status).toBe(400);
    expect(await identity()).toBeUndefined();
  });

  it("refuses mapping an existing test inbox to Outlook (400)", async () => {
    await addIdentity({ purpose: "test" });
    const res = await patch(apiKey, { outlookAccountId: "o-1" });
    expect(res.status).toBe(400);
    expect(await identity()).toMatchObject({
      purpose: "test",
      source: "cloudflare",
    });
  });

  it("refuses retention days on a normal inbox (400)", async () => {
    const res = await patch(apiKey, { testRetentionDays: 5 });
    expect(res.status).toBe(400);
  });

  it("refuses retention outside 1–30 (400)", async () => {
    expect(
      (await patch(apiKey, { purpose: "test", testRetentionDays: 0 })).status,
    ).toBe(400);
    expect(
      (await patch(apiKey, { purpose: "test", testRetentionDays: 31 })).status,
    ).toBe(400);
  });

  // Retention deletes by the inbox's current purpose, so the switch counts
  // every received message, archived or trashed ones included, and no sent
  // one; an inbox switched back to mail keeps what it has.
  it("counts archived and trashed mail but not sent mail, and stops pruning once switched back", async () => {
    const now = Math.floor(Date.now() / 1000);
    const day = 24 * 60 * 60;
    await createTestPerson();

    // Only sent mail: still an empty inbox.
    await createTestSentEmail({ fromAddress: INBOX });
    expect((await patch(apiKey, { purpose: "test" })).status).toBe(200);

    // Only archived and trashed received mail: not empty.
    const ARCHIVED = "archived@saasmail.test";
    await createTestEmail({
      id: "archived-1",
      recipient: ARCHIVED,
      messageId: "archived-1@example.com",
    });
    await env.DB.prepare(
      "INSERT INTO mailbox_message_state (inbox, message_kind, message_id, archived_at, trashed_at, updated_at) VALUES (?, 'received', 'archived-1', ?, ?, ?)",
    )
      .bind(ARCHIVED, now, now, now)
      .run();
    expect((await patch(apiKey, { purpose: "test" }, ARCHIVED)).status).toBe(
      409,
    );
    expect(await identity(ARCHIVED)).toBeUndefined();

    const oldMail = (id: string) =>
      getDb()
        .insert(emails)
        .values({
          id,
          personId: "sender-1",
          recipient: INBOX,
          subject: "old",
          messageId: `<${id}@example.com>`,
          receivedAt: now - 10 * day,
          createdAt: now - 10 * day,
        });
    const ids = async () =>
      (await getDb().select({ id: emails.id }).from(emails)).map((r) => r.id);

    // While it is a test inbox, old mail goes...
    await oldMail("old-while-test");
    expect(await pruneTestMail(getDb(), env as never, now)).toBe(1);
    expect(await ids()).not.toContain("old-while-test");

    // ...and once it is a normal inbox again, old mail stays.
    await oldMail("old-after-switch");
    expect((await patch(apiKey, { purpose: "mail" })).status).toBe(200);
    expect(await pruneTestMail(getDb(), env as never, now)).toBe(0);
    expect(await ids()).toEqual(
      expect.arrayContaining(["old-after-switch", "archived-1"]),
    );
  });
});
