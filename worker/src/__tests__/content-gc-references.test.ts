import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { applyMigrations, cleanDb, createTestUser, getDb } from "./helpers";
import { jmapDrafts } from "../db/jmap-drafts.schema";
import { jmapMessageContent } from "../db/jmap-message-content.schema";
import { jmapSubmissions } from "../db/jmap-submissions.schema";
import { sentEmails } from "../db/sent-emails.schema";
import {
  collectUnreferencedContent,
  deleteContentIfUnreferenced,
} from "../jmap/content";

/**
 * The hourly content GC decides "still needed" in ONE predicate
 * (`contentReferencedSql` in worker/src/jmap/content.ts). Every kind of
 * reference must be in it: a draft, a JMAP-sent Sent row, and a claimed
 * submission's intention. Missing one silently deletes content a Sent Email
 * still shows.
 */
async function addContent(id: string, inbox: string, userId: string) {
  const rawR2Key = `jmap-content/${userId}/${id}.eml`;
  await env.R2.put(rawR2Key, `raw message for ${id}`);
  await getDb()
    .insert(jmapMessageContent)
    .values({
      id,
      createdBy: userId,
      inbox,
      fromJson: JSON.stringify([{ name: null, email: inbox }]),
      toJson: JSON.stringify([{ name: null, email: "bob@example.com" }]),
      ccJson: "[]",
      bccJson: "[]",
      subject: `subject ${id}`,
      messageId: `${id}@saasmail.test`,
      sentAt: "2026-09-26T10:00:00Z",
      partsJson: JSON.stringify({
        partId: "1",
        type: "text/plain",
        charset: "utf-8",
        name: null,
        disposition: null,
        cid: null,
        size: 5,
        r2Key: null,
      }),
      textBodyJson: JSON.stringify(["1"]),
      htmlBodyJson: "[]",
      attachmentsJson: "[]",
      bodyValuesJson: JSON.stringify({ "1": "hello" }),
      preview: "hello",
      threadKey: `draft:${id}`,
      rawR2Key,
      size: 100,
      createdAt: 1,
    });
  return rawR2Key;
}

async function addSubmission(
  id: string,
  userId: string,
  contentId: string,
  attemptState: "claimed" | "accepted",
) {
  await getDb()
    .insert(jmapSubmissions)
    .values({
      id,
      userId,
      attemptState,
      onSuccessState: attemptState === "claimed" ? "pending" : "applied",
      draftId: `draft-for-${id}`,
      contentId,
      identityId: "iIdentity",
      identityEmail: "mine@saasmail.test",
      emailId: "Ddraft-1",
      threadId: "Tddraft-1",
      sentEmailId: `sent-${id}`,
      envelopeJson: "{}",
      onSuccessMode: "none",
      sendAt: 100,
      createdAt: 100,
    });
}

describe("content GC references", () => {
  beforeAll(async () => {
    await applyMigrations();
  });
  beforeEach(async () => {
    await cleanDb();
    const listed = await env.R2.list({ prefix: "jmap-content/" });
    if (listed.objects.length > 0) {
      await env.R2.delete(listed.objects.map((object) => object.key));
    }
  });

  it("keeps content a draft, a Sent row or a claimed submission references", async () => {
    const { userId } = await createTestUser({ id: "gc-user" });
    const inbox = "mine@saasmail.test";
    const draftContent = await addContent("c-draft", inbox, userId);
    const sentContent = await addContent("c-sent", inbox, userId);
    const claimedContent = await addContent("c-claimed", inbox, userId);
    const acceptedContent = await addContent("c-accepted", inbox, userId);
    const orphanContent = await addContent("c-orphan", inbox, userId);

    await getDb().insert(jmapDrafts).values({
      id: "draft-row",
      userId,
      contentId: "c-draft",
      inbox,
      receivedAt: 1,
      createdAt: 1,
      updatedAt: 1,
    });
    await getDb().insert(sentEmails).values({
      id: "sent-row",
      fromAddress: inbox,
      toAddress: "bob@example.com",
      subject: "hi",
      sentAt: 1,
      createdAt: 1,
      jmapContentId: "c-sent",
    });
    await addSubmission("sub-claimed", userId, "c-claimed", "claimed");
    await addSubmission("sub-accepted", userId, "c-accepted", "accepted");

    expect(await collectUnreferencedContent(getDb(), env, 10_000)).toBe(2);
    const remaining = (await getDb().select().from(jmapMessageContent))
      .map((row) => row.id)
      .sort();
    expect(remaining).toEqual(["c-claimed", "c-draft", "c-sent"]);

    for (const key of [draftContent, sentContent, claimedContent]) {
      expect(await env.R2.head(key)).not.toBeNull();
    }
    expect(await env.R2.head(orphanContent)).toBeNull();
    expect(await env.R2.head(acceptedContent)).toBeNull();
  });

  it("deletes content once the Sent row referencing it is gone", async () => {
    const { userId } = await createTestUser({ id: "gc-user-2" });
    const rawR2Key = await addContent(
      "c-only-sent",
      "mine@saasmail.test",
      userId,
    );
    await getDb().insert(sentEmails).values({
      id: "sent-row-2",
      fromAddress: "mine@saasmail.test",
      toAddress: "bob@example.com",
      subject: "hi",
      sentAt: 1,
      createdAt: 1,
      jmapContentId: "c-only-sent",
    });

    expect(await deleteContentIfUnreferenced(getDb(), env, "c-only-sent")).toBe(
      false,
    );
    await getDb().delete(sentEmails).where(eq(sentEmails.id, "sent-row-2"));
    expect(await deleteContentIfUnreferenced(getDb(), env, "c-only-sent")).toBe(
      true,
    );
    expect(await env.R2.head(rawR2Key)).toBeNull();
  });
});
