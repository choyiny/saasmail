import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import {
  applyMigrations,
  authFetch,
  cleanDb,
  createTestUser,
  getDb,
} from "./helpers";
import { inboxPermissions } from "../db/inbox-permissions.schema";
import { jmapMessageContent } from "../db/jmap-message-content.schema";
import { sentEmails } from "../db/sent-emails.schema";
import { queryMessages } from "../lib/messages/query";
import { collectUnreferencedContent } from "../jmap/content";
import { parseRawBlobId } from "../jmap/public-ids";
import {
  MINE,
  addIdentity,
  createDraft,
  recordingSender,
  runJmap,
  submitCall,
  uploadBlob,
} from "./jmap-harness";
import { acct, sid, sys } from "./jmap-ids";

const IMMUTABLE = [
  "size",
  "threadId",
  "messageId",
  "inReplyTo",
  "references",
  "sender",
  "from",
  "to",
  "cc",
  "bcc",
  "replyTo",
  "subject",
  "sentAt",
  "hasAttachment",
  "preview",
  "bodyValues",
  "textBody",
  "htmlBody",
  "attachments",
  "bodyStructure",
];

/** Part blob ids embed the Email id (P<id>_<part>), so they differ by design. */
function withoutPartBlobIds(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutPartBlobIds);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => key !== "blobId")
        .map(([key, child]) => [key, withoutPartBlobIds(child)]),
    );
  }
  return value;
}

describe("JMAP-sent Emails project from their content", () => {
  let userId: string;
  let apiKey: string;

  beforeAll(async () => {
    await applyMigrations();
  });
  beforeEach(async () => {
    await cleanDb();
    ({ userId, apiKey } = await createTestUser({
      id: "sent-content-user",
    }));
    await addIdentity(MINE);
  });

  async function sendWithAttachment(to = "bob@example.com") {
    const blob = await uploadBlob(
      userId,
      apiKey,
      new TextEncoder().encode("%PDF-1.4"),
      "application/pdf",
    );
    const { sender } = recordingSender();
    const draft = await createDraft(userId, sender, {
      to: [{ name: "Recipient", email: to }],
      attachments: [{ blobId: blob, type: "application/pdf", name: "doc.pdf" }],
    });
    const getArgs = (ids: string[]) => ({
      accountId: acct(userId),
      ids,
      properties: [
        ...IMMUTABLE,
        "blobId",
        "receivedAt",
        "mailboxIds",
        "keywords",
      ],
      fetchTextBodyValues: true,
      fetchHTMLBodyValues: true,
    });
    const [before] = await runJmap(
      userId,
      [["Email/get", getArgs([draft.id]), "g"]],
      sender,
    );
    await runJmap(userId, [submitCall(userId, draft.id)], sender);
    const [sent] = await getDb()
      .select()
      .from(sentEmails)
      .where(eq(sentEmails.jmapContentId, parseRawBlobId(draft.blobId)!));
    const [after] = await runJmap(
      userId,
      [["Email/get", getArgs([sid(sent.id)]), "g"]],
      sender,
    );
    return {
      draft,
      sent,
      sender,
      draftEmail: (before[1] as Record<string, any>).list[0],
      sentEmail: (after[1] as Record<string, any>).list[0],
    };
  }

  it("keeps every immutable property of the draft, with receivedAt = send time", async () => {
    const { draft, sent, draftEmail, sentEmail } = await sendWithAttachment();
    expect(sentEmail.id).toBe(sid(sent.id));
    expect(sentEmail.blobId).toBe(draft.blobId);
    for (const property of IMMUTABLE) {
      expect(withoutPartBlobIds(sentEmail[property]), property).toEqual(
        withoutPartBlobIds(draftEmail[property]),
      );
    }
    expect(Math.floor(Date.parse(sentEmail.receivedAt) / 1000)).toBe(
      sent.sentAt,
    );
    expect(sentEmail.mailboxIds).toEqual({ [sys(MINE, "sent")]: true });
    expect(sentEmail.keywords).toEqual({ $seen: true });
  });

  it("threads JMAP-sent mail by its content key, even when its natural key differs", async () => {
    // No person row exists for this address when the draft is created, so the
    // draft starts its own thread (Td…); sending creates the person, whose
    // natural key p:<id> is different.
    const { draft, sent, sender } = await sendWithAttachment(
      "newcontact@example.com",
    );
    expect(draft.threadId.startsWith("Td")).toBe(true);
    const [threads] = await runJmap(
      userId,
      [["Thread/get", { accountId: acct(userId), ids: [draft.threadId] }, "t"]],
      sender,
    );
    expect((threads[1] as Record<string, any>).list[0].emailIds).toEqual([
      draft.id,
      sid(sent.id),
    ]);

    // With the draft gone, only the content key keeps the thread listed.
    await runJmap(
      userId,
      [["Email/set", { accountId: acct(userId), destroy: [draft.id] }, "d"]],
      sender,
    );
    const [only, all] = await runJmap(
      userId,
      [
        ["Thread/get", { accountId: acct(userId), ids: [draft.threadId] }, "t"],
        ["Thread/get", { accountId: acct(userId) }, "all"],
      ],
      sender,
    );
    expect((only[1] as Record<string, any>).list[0].emailIds).toEqual([
      sid(sent.id),
    ]);
    const allIds = (all[1] as Record<string, any>).list.map(
      (thread: { id: string }) => thread.id,
    );
    expect(allIds).toContain(draft.threadId);
  });

  it("serves the raw blob and parts through the Sent row, after the draft is gone", async () => {
    const { draft, sentEmail, sender } = await sendWithAttachment();
    await runJmap(
      userId,
      [["Email/set", { accountId: acct(userId), destroy: [draft.id] }, "d"]],
      sender,
    );

    const raw = await authFetch(
      `/jmap/download/${acct(userId)}/${draft.blobId}/message.eml`,
      { apiKey },
    );
    expect(raw.status).toBe(200);
    expect((await raw.arrayBuffer()).byteLength).toBe(draft.size);

    const textPart = sentEmail.textBody[0].blobId as string;
    const text = await authFetch(
      `/jmap/download/${acct(userId)}/${textPart}/body.txt`,
      { apiKey },
    );
    expect(text.status).toBe(200);
    expect(await text.text()).toBe("Hi Bob");

    const outsider = await createTestUser({
      id: "outsider",
      role: "member",
      email: "outsider@example.com",
    });
    const denied = await authFetch(
      `/jmap/download/${acct(outsider.userId)}/${draft.blobId}/message.eml`,
      { apiKey: outsider.apiKey },
    );
    expect(denied.status).toBe(404);

    const teammate = await createTestUser({
      id: "teammate",
      role: "member",
      email: "teammate@example.com",
    });
    await getDb().insert(inboxPermissions).values({
      userId: teammate.userId,
      email: MINE,
      createdAt: 1,
      createdBy: null,
    });
    const shared = await authFetch(
      `/jmap/download/${acct(teammate.userId)}/${draft.blobId}/message.eml`,
      { apiKey: teammate.apiKey },
    );
    expect(shared.status).toBe(200);
  });

  it("content GC keeps content a Sent row references and collects it afterwards", async () => {
    const { draft, sent, sender } = await sendWithAttachment();
    await runJmap(
      userId,
      [["Email/set", { accountId: acct(userId), destroy: [draft.id] }, "d"]],
      sender,
    );
    const contentId = parseRawBlobId(draft.blobId)!;
    const later = Math.floor(Date.now() / 1000) + 10 * 3600;

    await collectUnreferencedContent(getDb(), env, later);
    const [kept] = await getDb()
      .select()
      .from(jmapMessageContent)
      .where(eq(jmapMessageContent.id, contentId));
    expect(kept).toBeDefined();
    expect(await env.R2.head(kept.rawR2Key)).not.toBeNull();

    await getDb().delete(sentEmails).where(eq(sentEmails.id, sent.id));
    await collectUnreferencedContent(getDb(), env, later);
    expect(
      await getDb()
        .select()
        .from(jmapMessageContent)
        .where(eq(jmapMessageContent.id, contentId)),
    ).toHaveLength(0);
    expect(await env.R2.head(kept.rawR2Key)).toBeNull();
  });

  it("exposes JMAP columns only to queries that ask for them", async () => {
    const { sent } = await sendWithAttachment();
    const plain = await queryMessages(
      getDb(),
      { isAdmin: true },
      { direction: "outbound" },
    );
    expect(plain.messages[0].jmap).toBeUndefined();
    const jmap = await queryMessages(
      getDb(),
      { isAdmin: true },
      {
        direction: "outbound",
        withJmap: true,
      },
    );
    expect(jmap.messages[0].ref.id).toBe(sent.id);
    // PR 6 widened the field with the alias (emailId/receivedAt); a row that
    // was not aliased carries both as null.
    expect(jmap.messages[0].jmap).toEqual({
      contentId: sent.jmapContentId,
      threadKey: expect.any(String),
      emailId: null,
      receivedAt: null,
    });
  });
});
