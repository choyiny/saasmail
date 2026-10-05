import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { applyMigrations, cleanDb, createTestUser, getDb } from "./helpers";
import { users } from "../db/auth.schema";
import { jmapDrafts } from "../db/jmap-drafts.schema";
import { jmapMessageContent } from "../db/jmap-message-content.schema";

const INBOX = "drafts@saasmail.test";

async function seedContent(id: string, createdBy: string | null) {
  await getDb()
    .insert(jmapMessageContent)
    .values({
      id,
      createdBy,
      inbox: INBOX,
      fromJson: JSON.stringify([{ name: null, email: INBOX }]),
      toJson: "[]",
      ccJson: "[]",
      bccJson: "[]",
      replyToJson: null,
      subject: "",
      messageId: `${id}@saasmail.test`,
      inReplyToJson: null,
      referencesJson: null,
      sentAt: "2026-09-26T10:00:00Z",
      partsJson: JSON.stringify({
        partId: "1",
        type: "text/plain",
        charset: "utf-8",
        name: null,
        disposition: null,
        cid: null,
        size: 0,
        r2Key: null,
      }),
      textBodyJson: '["1"]',
      htmlBodyJson: '["1"]',
      attachmentsJson: "[]",
      bodyValuesJson: '{"1":""}',
      preview: "",
      threadKey: `draft:${id}`,
      rawR2Key: `jmap-content/u/${id}.eml`,
      size: 1,
      createdAt: 1,
    });
}

async function seedDraft(id: string, userId: string, contentId: string) {
  await getDb().insert(jmapDrafts).values({
    id,
    userId,
    contentId,
    inbox: INBOX,
    receivedAt: 1,
    mailboxRole: "drafts",
    seen: 0,
    flagged: 0,
    createdAt: 1,
    updatedAt: 1,
  });
}

async function changes() {
  const result = await env.DB.prepare(
    "SELECT object_type, object_id, inbox, user_id, op FROM jmap_changes ORDER BY seq",
  ).all();
  return result.results;
}

describe("jmap_drafts and jmap_message_content", () => {
  beforeAll(async () => {
    await applyMigrations();
  });
  beforeEach(async () => {
    await cleanDb();
  });

  it("writes user-scoped change rows for create, state changes and delete only", async () => {
    const { userId } = await createTestUser({ id: "schema-user" });
    await seedContent("content-a", userId);
    await seedDraft("draft-a", userId, "content-a");
    await getDb()
      .update(jmapDrafts)
      .set({ seen: 1 })
      .where(eq(jmapDrafts.id, "draft-a"));
    // Not a JMAP-visible change: no row.
    await getDb()
      .update(jmapDrafts)
      .set({ updatedAt: 99 })
      .where(eq(jmapDrafts.id, "draft-a"));
    await getDb().delete(jmapDrafts).where(eq(jmapDrafts.id, "draft-a"));

    const expected = (op: string) => ({
      object_type: "email",
      object_id: "draft:draft-a",
      inbox: INBOX,
      user_id: userId,
      op,
    });
    expect(await changes()).toEqual([
      expected("c"),
      expected("u"),
      expected("d"),
    ]);
  });

  it("deletes a user's drafts with the user but keeps the content", async () => {
    const { userId } = await createTestUser({ id: "schema-gone" });
    await seedContent("content-b", userId);
    await seedDraft("draft-b", userId, "content-b");
    await getDb().delete(users).where(eq(users.id, userId));

    expect(await getDb().select().from(jmapDrafts)).toEqual([]);
    const [content] = await getDb()
      .select()
      .from(jmapMessageContent)
      .where(eq(jmapMessageContent.id, "content-b"));
    expect(content.createdBy).toBeNull();
  });

  it("refuses to delete content a draft still references", async () => {
    const { userId } = await createTestUser({ id: "schema-ref" });
    await seedContent("content-c", userId);
    await seedDraft("draft-c", userId, "content-c");
    await expect(
      getDb()
        .delete(jmapMessageContent)
        .where(eq(jmapMessageContent.id, "content-c")),
    ).rejects.toThrow();
  });
});
