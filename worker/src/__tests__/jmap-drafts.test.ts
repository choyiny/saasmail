import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import {
  applyMigrations,
  authFetch,
  cleanDb,
  createTestEmail,
  createTestPerson,
  createTestUser,
  getDb,
} from "./helpers";
import { emails } from "../db/emails.schema";
import { inboxPermissions } from "../db/inbox-permissions.schema";
import { jmapBlobs } from "../db/jmap-blobs.schema";
import { jmapDrafts } from "../db/jmap-drafts.schema";
import { jmapMessageContent } from "../db/jmap-message-content.schema";
import { mailboxes } from "../db/mailboxes.schema";
import { senderIdentities } from "../db/sender-identities.schema";
import { collectUnreferencedContent } from "../jmap/content";
import { CORE_CAPABILITY, MAIL_CAPABILITY } from "../jmap/constants";
import { createDraftEmail, Rejection } from "../jmap/email-create";
import { publicBodyPartBlobId } from "../jmap/public-ids";
import worker from "../index";
import { computeConversationId } from "../lib/conversation-id";
import {
  acct,
  drf,
  expectAllJmapIdsValid,
  mbx,
  rid,
  sys,
  thread,
} from "./jmap-ids";

const MINE = "drafts@saasmail.test";

async function addIdentity(email = MINE, displayName = "Drafts Inbox") {
  const now = Math.floor(Date.now() / 1000);
  await getDb().insert(senderIdentities).values({
    email,
    displayName,
    createdAt: now,
    updatedAt: now,
  });
}

async function member(id: string, email: string) {
  const auth = await createTestUser({ id, role: "member", email });
  await getDb()
    .insert(inboxPermissions)
    .values({
      userId: auth.userId,
      email: MINE,
      createdAt: Math.floor(Date.now() / 1000),
      createdBy: null,
    });
  return auth;
}

async function jmapJson(apiKey: string, methodCalls: unknown[]) {
  const response = await authFetch("/jmap/api", {
    method: "POST",
    apiKey,
    body: JSON.stringify({
      using: [CORE_CAPABILITY, MAIL_CAPABILITY],
      methodCalls,
    }),
  });
  expect(response.status).toBe(200);
  return response.json() as Promise<{
    methodResponses: [string, Record<string, any>, string][];
  }>;
}

async function upload(
  apiKey: string,
  userId: string,
  body: string,
  type = "text/plain",
): Promise<string> {
  const response = await authFetch(`/jmap/upload/${acct(userId)}/`, {
    method: "POST",
    apiKey,
    body,
    headers: { "Content-Type": type },
  });
  expect([200, 201]).toContain(response.status);
  return ((await response.json()) as { blobId: string }).blobId;
}

function draft(overrides: Record<string, unknown> = {}) {
  return {
    mailboxIds: { [sys(MINE, "drafts")]: true },
    keywords: { $draft: true },
    from: [{ name: "Drafts Inbox", email: MINE }],
    to: [{ name: "Alice", email: "alice@example.com" }],
    subject: "Hello",
    textBody: [{ partId: "t", type: "text/plain" }],
    bodyValues: { t: { value: "Hi there" } },
    ...overrides,
  };
}

type Created = { id: string; blobId: string; threadId: string; size: number };

async function createDraft(
  apiKey: string,
  userId: string,
  overrides: Record<string, unknown> = {},
): Promise<Created> {
  const res = await jmapJson(apiKey, [
    [
      "Email/set",
      { accountId: acct(userId), create: { c1: draft(overrides) } },
      "s",
    ],
  ]);
  const result = res.methodResponses[0][1];
  expect(result.notCreated).toBeNull();
  return result.created.c1 as Created;
}

function envWithFailingPut(failOnCall: number): CloudflareBindings {
  let calls = 0;
  const r2 = new Proxy(env.R2, {
    get(target, prop) {
      if (prop === "put") {
        return async (...args: unknown[]) => {
          calls += 1;
          if (calls === failOnCall) throw new Error("r2 down");
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          return (target as any).put(...args);
        };
      }
      const value = Reflect.get(target, prop);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return new Proxy(env, {
    get(target, prop) {
      return prop === "R2" ? r2 : Reflect.get(target, prop);
    },
  }) as CloudflareBindings;
}

/**
 * cleanDb() only empties D1; R2 objects outlive it, and every test in this file
 * uses the same user id, so a test that lists the whole content prefix would
 * see an earlier test's objects. Wipe both prefixes between tests, the same
 * way jmap-upload.test.ts clears its own.
 */
async function clearR2Prefix(prefix: string): Promise<void> {
  let cursor: string | undefined;
  do {
    const listed = await env.R2.list({ prefix, cursor });
    const keys = listed.objects.map((object) => object.key);
    if (keys.length > 0) await env.R2.delete(keys);
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);
}

async function clearContentObjects(): Promise<void> {
  await clearR2Prefix("jmap-content/");
  await clearR2Prefix("jmap-uploads/");
}

describe("JMAP drafts", () => {
  beforeAll(async () => {
    await applyMigrations();
  });
  beforeEach(async () => {
    await cleanDb();
    await clearContentObjects();
    await addIdentity();
  });

  describe("create", () => {
    it("creates a draft and returns id, blobId, threadId and size", async () => {
      const { userId, apiKey } = await createTestUser({ id: "drafter" });
      const res = await jmapJson(apiKey, [
        [
          "Email/set",
          { accountId: acct(userId), create: { c1: draft() } },
          "s",
        ],
      ]);
      expectAllJmapIdsValid(res);
      const created = res.methodResponses[0][1].created.c1 as Created;
      expect(created.id).toMatch(/^D/);
      expect(created.blobId).toMatch(/^X/);
      expect(created.threadId).toMatch(/^T/);
      expect(created.size).toBeGreaterThan(0);

      const [row] = await getDb().select().from(jmapDrafts);
      expect(row.id).toBe(created.id.slice(1));
      expect(row.contentId).toBe(created.blobId.slice(1));
      const [content] = await getDb().select().from(jmapMessageContent);
      expect(content.size).toBe(created.size);
      const object = await env.R2.get(content.rawR2Key);
      expect((await object!.arrayBuffer()).byteLength).toBe(created.size);
    });

    it("requires the identity's Drafts mailbox and a usable identity", async () => {
      const { userId, apiKey } = await createTestUser({ id: "drafter" });
      const res = await jmapJson(apiKey, [
        [
          "Email/set",
          {
            accountId: acct(userId),
            create: {
              inbox: draft({ mailboxIds: { [sys(MINE, "inbox")]: true } }),
              stranger: draft({ from: [{ email: "stranger@example.com" }] }),
            },
          },
          "s",
        ],
      ]);
      expect(res.methodResponses[0][1].notCreated).toEqual({
        inbox: { type: "invalidProperties", properties: ["mailboxIds"] },
        stranger: { type: "invalidProperties", properties: ["from"] },
      });
    });

    it("reports every missing blob in blobNotFound", async () => {
      const { userId, apiKey } = await createTestUser({ id: "drafter" });
      const other = await createTestUser({
        id: "otheruser",
        email: "other@example.com",
      });
      const foreign = await upload(other.apiKey, other.userId, "not yours");
      const res = await jmapJson(apiKey, [
        [
          "Email/set",
          {
            accountId: acct(userId),
            create: {
              c1: draft({
                attachments: [{ blobId: "Umissing" }, { blobId: foreign }],
              }),
            },
          },
          "s",
        ],
      ]);
      expect(res.methodResponses[0][1].notCreated.c1).toEqual({
        type: "blobNotFound",
        notFound: ["Umissing", foreign],
      });
      expect(await getDb().select().from(jmapMessageContent)).toEqual([]);
    });

    it("rejects attachments over maxSizeAttachmentsPerEmail with tooLarge", async () => {
      const { userId, apiKey } = await createTestUser({ id: "drafter" });
      const blobId = await upload(apiKey, userId, "four");
      const result = await createDraftEmail(
        {
          db: getDb(),
          env,
          allowed: { isAdmin: true },
          userId,
          maxAttachmentBytes: 3,
          now: Math.floor(Date.now() / 1000),
        },
        draft({ attachments: [{ blobId }] }),
      );
      expect(result).toBeInstanceOf(Rejection);
      expect((result as Rejection).error.type).toBe("tooLarge");
    });

    it("refuses oversized attachments before reading any of their bytes", async () => {
      const { userId, apiKey } = await createTestUser({ id: "drafter" });
      const blobId = await upload(apiKey, userId, "four");
      const r2 = new Proxy(env.R2, {
        get(target, prop) {
          if (prop === "get") {
            return async () => {
              throw new Error("attachment bytes read before the size check");
            };
          }
          const value = Reflect.get(target, prop);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      const noReads = new Proxy(env, {
        get(target, prop) {
          return prop === "R2" ? r2 : Reflect.get(target, prop);
        },
      }) as CloudflareBindings;
      const result = await createDraftEmail(
        {
          db: getDb(),
          env: noReads,
          allowed: { isAdmin: true },
          userId,
          maxAttachmentBytes: 3,
          now: Math.floor(Date.now() / 1000),
        },
        draft({ attachments: [{ blobId }, { blobId }] }),
      );
      expect(result).toBeInstanceOf(Rejection);
      expect((result as Rejection).error.type).toBe("tooLarge");
    });

    it("leaves neither rows nor R2 objects when an R2 write fails", async () => {
      const { userId, apiKey } = await createTestUser({ id: "drafter" });
      const blobId = await upload(apiKey, userId, "hello");
      await expect(
        createDraftEmail(
          {
            db: getDb(),
            env: envWithFailingPut(1),
            allowed: { isAdmin: true },
            userId,
            maxAttachmentBytes: 1_000_000,
            now: Math.floor(Date.now() / 1000),
          },
          draft({ attachments: [{ blobId }] }),
        ),
      ).rejects.toThrow("r2 down");
      expect(await getDb().select().from(jmapMessageContent)).toEqual([]);
      expect(await getDb().select().from(jmapDrafts)).toEqual([]);
      const listed = await env.R2.list({ prefix: `jmap-content/${userId}/` });
      expect(listed.objects).toEqual([]);
    });

    it("joins the thread of the message it replies to (either Message-ID form)", async () => {
      const { userId, apiKey } = await createTestUser({ id: "drafter" });
      await createTestPerson();
      await createTestEmail({
        id: "orig",
        recipient: MINE,
        messageId: "<orig@example.com>",
        conversationId: "c_0123456789abcdef",
      });
      const created = await createDraft(apiKey, userId, {
        inReplyTo: ["orig@example.com"],
      });
      expect(created.threadId).toBe(thread("c_0123456789abcdef"));
    });

    it("otherwise uses the conversation key, then the person key, then its own thread", async () => {
      const { userId, apiKey } = await createTestUser({ id: "drafter" });
      const group = await createDraft(apiKey, userId, {
        cc: [{ email: "bob@example.com" }],
      });
      const conversation = await computeConversationId(MINE, [
        "alice@example.com",
        "bob@example.com",
      ]);
      expect(group.threadId).toBe(thread(conversation!));

      await createTestPerson({
        id: "person-alice",
        email: "alice@example.com",
      });
      const person = await createDraft(apiKey, userId);
      expect(person.threadId).toBe(thread("p:person-alice"));

      const alone = await createDraft(apiKey, userId, {
        to: [{ email: "nobody@example.com" }],
      });
      expect(alone.threadId).toBe(`Td${alone.id.slice(1)}`);
    });
  });

  describe("get", () => {
    it("returns a draft's immutable properties and server-set values", async () => {
      const { userId, apiKey } = await createTestUser({ id: "drafter" });
      const created = await createDraft(apiKey, userId);
      const res = await jmapJson(apiKey, [
        [
          "Email/get",
          {
            accountId: acct(userId),
            ids: [created.id],
            fetchAllBodyValues: true,
          },
          "g",
        ],
      ]);
      expectAllJmapIdsValid(res);
      const email = res.methodResponses[0][1].list[0];
      expect(email).toMatchObject({
        id: created.id,
        blobId: created.blobId,
        threadId: created.threadId,
        size: created.size,
        mailboxIds: { [sys(MINE, "drafts")]: true },
        keywords: { $draft: true },
        from: [{ name: "Drafts Inbox", email: MINE }],
        to: [{ name: "Alice", email: "alice@example.com" }],
        cc: null,
        subject: "Hello",
        hasAttachment: false,
        preview: "Hi there",
        textBody: [
          {
            partId: "1",
            type: "text/plain",
            size: 8,
            blobId: publicBodyPartBlobId(created.id, "1"),
          },
        ],
        bodyValues: {
          "1": {
            value: "Hi there",
            isEncodingProblem: false,
            isTruncated: false,
          },
        },
      });
      expect(email.messageId).toEqual([
        expect.stringMatching(/^[A-Za-z0-9_-]+@saasmail\.test$/),
      ]);
      expect(email.sentAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
      expect(email.receivedAt).toMatch(
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/,
      );
    });

    it("keeps client-set messageId, sentAt and receivedAt", async () => {
      const { userId, apiKey } = await createTestUser({ id: "drafter" });
      const created = await createDraft(apiKey, userId, {
        messageId: ["client-id@example.com"],
        sentAt: "2026-09-26T12:00:00+02:00",
        receivedAt: "2026-09-20T08:00:00Z",
      });
      const res = await jmapJson(apiKey, [
        [
          "Email/get",
          {
            accountId: acct(userId),
            ids: [created.id],
            properties: ["messageId", "sentAt", "receivedAt"],
          },
          "g",
        ],
      ]);
      expect(res.methodResponses[0][1].list[0]).toEqual({
        id: created.id,
        messageId: ["client-id@example.com"],
        sentAt: "2026-09-26T12:00:00+02:00",
        receivedAt: "2026-09-20T08:00:00Z",
      });
    });

    it("projects text, html and an attachment into structure and lists", async () => {
      const { userId, apiKey } = await createTestUser({ id: "drafter" });
      const blobId = await upload(apiKey, userId, "hello");
      const created = await createDraft(apiKey, userId, {
        htmlBody: [{ partId: "h", type: "text/html" }],
        bodyValues: { t: { value: "Hi" }, h: { value: "<p>Hi</p>" } },
        attachments: [{ blobId, type: "text/plain", name: "a.txt" }],
      });
      const res = await jmapJson(apiKey, [
        ["Email/get", { accountId: acct(userId), ids: [created.id] }, "g"],
      ]);
      const email = res.methodResponses[0][1].list[0];
      expect(email.bodyStructure.type).toBe("multipart/mixed");
      expect(email.bodyStructure.subParts[0].type).toBe(
        "multipart/alternative",
      );
      expect(email.textBody.map((part: any) => part.partId)).toEqual(["1"]);
      expect(email.htmlBody.map((part: any) => part.partId)).toEqual(["2"]);
      expect(email.attachments).toEqual([
        {
          partId: "3",
          blobId: publicBodyPartBlobId(created.id, "3"),
          size: 5,
          name: "a.txt",
          type: "text/plain",
          charset: null,
          disposition: "attachment",
          cid: null,
          language: null,
          location: null,
        },
      ]);
      expect(email.hasAttachment).toBe(true);
    });

    it("truncates body values to maxBodyValueBytes on a character boundary", async () => {
      const { userId, apiKey } = await createTestUser({ id: "drafter" });
      const created = await createDraft(apiKey, userId, {
        bodyValues: { t: { value: "héllo" } },
      });
      const res = await jmapJson(apiKey, [
        [
          "Email/get",
          {
            accountId: acct(userId),
            ids: [created.id],
            fetchTextBodyValues: true,
            maxBodyValueBytes: 2,
          },
          "g",
        ],
      ]);
      // "h" (1 octet) + "é" (2 octets) would be 3 > 2, so only "h" survives.
      expect(res.methodResponses[0][1].list[0].bodyValues["1"]).toEqual({
        value: "h",
        isEncodingProblem: false,
        isTruncated: true,
      });
    });

    it("lists drafts with ids: null and reports malformed or unknown draft ids as notFound", async () => {
      const { userId, apiKey } = await createTestUser({ id: "drafter" });
      const created = await createDraft(apiKey, userId);
      const res = await jmapJson(apiKey, [
        [
          "Email/get",
          { accountId: acct(userId), ids: null, properties: ["id"] },
          "all",
        ],
        [
          "Email/get",
          { accountId: acct(userId), ids: ["D", "Dnope", "d!!", drf("x")] },
          "bad",
        ],
      ]);
      expect(res.methodResponses[0][1].list).toEqual([{ id: created.id }]);
      expect(res.methodResponses[1][1].notFound).toEqual([
        "D",
        "Dnope",
        "d!!",
        drf("x"),
      ]);
    });
  });

  describe("update and destroy", () => {
    async function setEmail(
      apiKey: string,
      userId: string,
      args: Record<string, unknown>,
    ) {
      const res = await jmapJson(apiKey, [
        ["Email/set", { accountId: acct(userId), ...args }, "s"],
      ]);
      return res.methodResponses[0];
    }

    it("flags a draft and moves it to Trash and back", async () => {
      const { userId, apiKey } = await createTestUser({ id: "drafter" });
      const created = await createDraft(apiKey, userId);
      let response = await setEmail(apiKey, userId, {
        update: {
          [created.id]: {
            "keywords/$flagged": true,
            mailboxIds: { [sys(MINE, "trash")]: true },
          },
        },
      });
      expect(response[1].updated).toEqual({ [created.id]: null });
      let [row] = await getDb().select().from(jmapDrafts);
      expect(row).toMatchObject({ flagged: 1, mailboxRole: "trash" });

      response = await setEmail(apiKey, userId, {
        update: {
          [created.id]: {
            [`mailboxIds/${sys(MINE, "trash")}`]: null,
            [`mailboxIds/${sys(MINE, "drafts")}`]: true,
          },
        },
      });
      expect(response[1].updated).toEqual({ [created.id]: null });
      [row] = await getDb().select().from(jmapDrafts);
      expect(row.mailboxRole).toBe("drafts");
    });

    it("rejects every update that breaks the draft rules, changing nothing", async () => {
      const { userId, apiKey } = await createTestUser({ id: "drafter" });
      await getDb().insert(mailboxes).values({
        id: "draft-folder",
        inbox: MINE,
        name: "Folder",
        role: null,
        parentId: null,
        sortOrder: 0,
        createdBy: userId,
        createdAt: 1,
        updatedAt: 1,
      });
      const created = await createDraft(apiKey, userId);
      const cases: [Record<string, unknown>, string][] = [
        // A draft may be in a custom folder now (jmap-drafts-folders.test.ts),
        // but never in two system mailboxes, and never in a folder alone.
        [
          {
            mailboxIds: {
              [sys(MINE, "drafts")]: true,
              [sys(MINE, "trash")]: true,
            },
          },
          "mailboxIds",
        ],
        [{ mailboxIds: { [mbx("draft-folder")]: true } }, "mailboxIds"],
        [{ mailboxIds: { [sys(MINE, "inbox")]: true } }, "mailboxIds"],
        [{ mailboxIds: { [sys(MINE, "sent")]: true } }, "mailboxIds"],
        [{ mailboxIds: {} }, "mailboxIds"],
        [{ "keywords/$draft": null }, "keywords"],
        [{ "keywords/$answered": true }, "keywords"],
      ];
      for (const [patch, property] of cases) {
        const response = await setEmail(apiKey, userId, {
          update: { [created.id]: patch },
        });
        expect(response[1].notUpdated[created.id]).toEqual({
          type: "invalidProperties",
          properties: [property],
        });
      }
      const [row] = await getDb().select().from(jmapDrafts);
      expect(row).toMatchObject({ mailboxRole: "drafts", seen: 0, flagged: 0 });
    });

    it("destroys a draft with its content row and R2 objects", async () => {
      const { userId, apiKey } = await createTestUser({ id: "drafter" });
      const blobId = await upload(apiKey, userId, "hello");
      const created = await createDraft(apiKey, userId, {
        attachments: [{ blobId }],
      });
      const response = await setEmail(apiKey, userId, {
        destroy: [created.id],
      });
      expect(response[1].destroyed).toEqual([created.id]);
      expect(await getDb().select().from(jmapDrafts)).toEqual([]);
      expect(await getDb().select().from(jmapMessageContent)).toEqual([]);
      const listed = await env.R2.list({ prefix: `jmap-content/${userId}/` });
      expect(listed.objects).toEqual([]);
      const get = await jmapJson(apiKey, [
        ["Email/get", { accountId: acct(userId), ids: [created.id] }, "g"],
      ]);
      expect(get.methodResponses[0][1].notFound).toEqual([created.id]);
    });

    it("keeps received-mail destroy forbidden and reports unknown drafts as notFound", async () => {
      const { userId, apiKey } = await createTestUser({ id: "drafter" });
      await createTestPerson();
      await createTestEmail({
        id: "kept",
        recipient: MINE,
        messageId: "kept@example.com",
      });
      const response = await setEmail(apiKey, userId, {
        destroy: [rid("kept"), "Dnope"],
      });
      expect(response[1].notDestroyed).toEqual({
        [rid("kept")]: { type: "forbidden" },
        Dnope: { type: "notFound" },
      });
    });

    it("resolves creation references within the call and from earlier calls", async () => {
      const { userId, apiKey } = await createTestUser({ id: "drafter" });
      const res = await jmapJson(apiKey, [
        [
          "Email/set",
          {
            accountId: acct(userId),
            create: { c1: draft() },
            update: { "#c1": { "keywords/$flagged": true } },
          },
          "a",
        ],
        [
          "Email/get",
          {
            accountId: acct(userId),
            ids: ["#c1"],
            properties: ["keywords"],
          },
          "b",
        ],
        ["Email/set", { accountId: acct(userId), destroy: ["#c1"] }, "c"],
      ]);
      const id = res.methodResponses[0][1].created.c1.id;
      expect(res.methodResponses[0][1].updated).toEqual({ [id]: null });
      expect(res.methodResponses[1][1].list[0].keywords).toEqual({
        $draft: true,
        $flagged: true,
      });
      expect(res.methodResponses[2][1].destroyed).toEqual([id]);
    });

    it("fails the whole call on an ifInState mismatch", async () => {
      const { userId, apiKey } = await createTestUser({ id: "drafter" });
      const response = await setEmail(apiKey, userId, {
        ifInState: "j2-0-0-0000000000000000",
        create: { c1: draft() },
      });
      expect(response).toEqual(["error", { type: "stateMismatch" }, "s"]);
      expect(await getDb().select().from(jmapDrafts)).toEqual([]);
    });

    it("collects only old, unreferenced content (R2 first, then the row)", async () => {
      const { userId, apiKey } = await createTestUser({ id: "drafter" });
      const kept = await createDraft(apiKey, userId);
      const orphan = await createDraft(apiKey, userId);
      const young = await createDraft(apiKey, userId);
      const now = Math.floor(Date.now() / 1000);
      // Make two drafts' content unreferenced: orphan's is old, young's is new.
      await getDb()
        .delete(jmapDrafts)
        .where(eq(jmapDrafts.id, orphan.id.slice(1)));
      await getDb()
        .delete(jmapDrafts)
        .where(eq(jmapDrafts.id, young.id.slice(1)));
      for (const created of [kept, orphan]) {
        await getDb()
          .update(jmapMessageContent)
          .set({ createdAt: now - 7200 })
          .where(eq(jmapMessageContent.id, created.blobId.slice(1)));
      }

      expect(await collectUnreferencedContent(getDb(), env, now)).toBe(1);
      const remaining = (await getDb().select().from(jmapMessageContent))
        .map((row) => row.id)
        .sort();
      expect(remaining).toEqual(
        [kept.blobId.slice(1), young.blobId.slice(1)].sort(),
      );
      expect(
        await env.R2.get(
          `jmap-content/${userId}/${orphan.blobId.slice(1)}.eml`,
        ),
      ).toBeNull();
    });

    // The GC is destructive (it deletes R2 objects and rows), so pin the cron
    // wiring directly rather than relying on another reaper's cron test to
    // happen to traverse the same chain.
    it("reaps unreferenced content from the hourly cron", async () => {
      const { userId, apiKey } = await createTestUser({ id: "drafter" });
      const orphan = await createDraft(apiKey, userId);
      // The draft's own id is its public D… id; the content row has a separate
      // id, which is what the X… blob id wraps.
      const draftId = orphan.id.slice(1);
      const contentId = orphan.blobId.slice(1);
      await getDb().delete(jmapDrafts).where(eq(jmapDrafts.id, draftId));
      const now = Math.floor(Date.now() / 1000);
      await getDb()
        .update(jmapMessageContent)
        .set({ createdAt: now - 7200 })
        .where(eq(jmapMessageContent.id, contentId));
      expect(
        await env.R2.get(`jmap-content/${userId}/${contentId}.eml`),
      ).not.toBeNull();

      const waits: Promise<unknown>[] = [];
      await worker.scheduled!(
        { cron: "0 * * * *", scheduledTime: Date.now() } as ScheduledEvent,
        env,
        {
          waitUntil: (p: Promise<unknown>) => {
            waits.push(p);
          },
        } as ExecutionContext,
      );
      await Promise.all(waits);

      expect(await getDb().select().from(jmapMessageContent)).toEqual([]);
      expect(
        await env.R2.get(`jmap-content/${userId}/${contentId}.eml`),
      ).toBeNull();
    });
  });

  describe("query, threads and mailboxes", () => {
    it("keeps the JMAP state under D1's 100 bound parameters for a member with 8 inboxes", async () => {
      const auth = await createTestUser({
        id: "manyinboxes",
        role: "member",
        email: "many@example.com",
      });
      const now = Math.floor(Date.now() / 1000);
      await getDb()
        .insert(inboxPermissions)
        .values(
          [
            MINE,
            ...Array.from({ length: 7 }, (_, i) => `box${i}@example.com`),
          ].map((email) => ({
            userId: auth.userId,
            email,
            createdAt: now,
            createdBy: null,
          })),
        );
      const session = await authFetch("/.well-known/jmap", {
        apiKey: auth.apiKey,
      });
      expect(session.status).toBe(200);
      const res = await jmapJson(auth.apiKey, [
        ["Mailbox/query", { accountId: acct(auth.userId) }, "q"],
      ]);
      expect(res.methodResponses[0][0]).toBe("Mailbox/query");
    });

    const BASE = 1_790_000_000;
    const iso = (seconds: number) =>
      new Date(seconds * 1000).toISOString().replace(".000Z", "Z");

    async function seedMessage(id: string, at: number) {
      await createTestEmail({
        id,
        recipient: MINE,
        messageId: `${id}@example.com`,
      });
      await getDb()
        .update(emails)
        .set({ receivedAt: at })
        .where(eq(emails.id, id));
    }

    async function query(
      apiKey: string,
      userId: string,
      args: Record<string, unknown> = {},
    ) {
      const res = await jmapJson(apiKey, [
        ["Email/query", { accountId: acct(userId), ...args }, "q"],
      ]);
      return res.methodResponses[0][1];
    }

    it("merges drafts and messages by receivedAt with exact paging and total", async () => {
      const { userId, apiKey } = await createTestUser({ id: "drafter" });
      await createTestPerson();
      await seedMessage("m1", BASE + 100);
      await seedMessage("m2", BASE + 300);
      const d1 = await createDraft(apiKey, userId, {
        receivedAt: iso(BASE + 200),
      });
      const d2 = await createDraft(apiKey, userId, {
        receivedAt: iso(BASE + 400),
      });

      expect((await query(apiKey, userId)).ids).toEqual([
        d2.id,
        rid("m2"),
        d1.id,
        rid("m1"),
      ]);
      const page = await query(apiKey, userId, {
        position: 1,
        limit: 2,
        calculateTotal: true,
      });
      expect(page).toMatchObject({
        ids: [rid("m2"), d1.id],
        position: 1,
        total: 4,
      });
      const last = await query(apiKey, userId, { position: -1, limit: 1 });
      expect(last).toMatchObject({ ids: [rid("m1")], position: 3 });
    });

    it("never repeats or drops an id across a same-receivedAt boundary", async () => {
      const { userId, apiKey } = await createTestUser({ id: "drafter" });
      await createTestPerson();
      await seedMessage("same", BASE + 100);
      const draftSame = await createDraft(apiKey, userId, {
        receivedAt: iso(BASE + 100),
      });
      const first = await query(apiKey, userId, { position: 0, limit: 1 });
      const second = await query(apiKey, userId, { position: 1, limit: 1 });
      expect([...first.ids, ...second.ids].sort()).toEqual(
        [draftSame.id, rid("same")].sort(),
      );
    });

    it("filters drafts by mailbox, $draft, text, from and keywords", async () => {
      const { userId, apiKey } = await createTestUser({ id: "drafter" });
      await createTestPerson();
      await seedMessage("m1", BASE + 100);
      const plan = await createDraft(apiKey, userId, {
        subject: "Quarterly plan",
        receivedAt: iso(BASE + 200),
      });
      const flagged = await createDraft(apiKey, userId, {
        keywords: { $draft: true, $flagged: true },
        receivedAt: iso(BASE + 300),
        bodyValues: { t: { value: 'Say "yes"' } },
      });

      expect(
        (
          await query(apiKey, userId, {
            filter: { inMailbox: sys(MINE, "drafts") },
          })
        ).ids,
      ).toEqual([flagged.id, plan.id]);
      expect(
        (await query(apiKey, userId, { filter: { hasKeyword: "$draft" } })).ids,
      ).toEqual([flagged.id, plan.id]);
      expect(
        (await query(apiKey, userId, { filter: { notKeyword: "$draft" } })).ids,
      ).toEqual([rid("m1")]);
      expect(
        (await query(apiKey, userId, { filter: { text: "Quarterly" } })).ids,
      ).toEqual([plan.id]);
      // Body text matches the text itself, not its JSON storage: a part id key
      // is not text, and a quote matches unescaped.
      expect(
        (await query(apiKey, userId, { filter: { text: "Hi there" } })).ids,
      ).toEqual([plan.id]);
      expect(
        (await query(apiKey, userId, { filter: { text: '"1"' } })).ids,
      ).toEqual([]);
      expect(
        (await query(apiKey, userId, { filter: { text: 'Say "yes"' } })).ids,
      ).toEqual([flagged.id]);
      expect(
        (await query(apiKey, userId, { filter: { from: "drafts@" } })).ids,
      ).toEqual([flagged.id, plan.id]);
      expect(
        (await query(apiKey, userId, { filter: { hasKeyword: "$flagged" } }))
          .ids,
      ).toEqual([flagged.id]);
      expect(
        (
          await query(apiKey, userId, {
            filter: { inMailbox: sys(MINE, "inbox") },
          })
        ).ids,
      ).toEqual([rid("m1")]);
    });

    it("shows trashed drafts and trashed mail together in Trash", async () => {
      const { userId, apiKey } = await createTestUser({ id: "drafter" });
      await createTestPerson();
      await seedMessage("m1", BASE + 100);
      const d1 = await createDraft(apiKey, userId, {
        receivedAt: iso(BASE + 200),
      });
      await jmapJson(apiKey, [
        [
          "Email/set",
          {
            accountId: acct(userId),
            update: {
              [d1.id]: { mailboxIds: { [sys(MINE, "trash")]: true } },
              [rid("m1")]: { mailboxIds: { [sys(MINE, "trash")]: true } },
            },
          },
          "s",
        ],
      ]);
      expect(
        (
          await query(apiKey, userId, {
            filter: { inMailbox: sys(MINE, "trash") },
          })
        ).ids,
      ).toEqual([d1.id, rid("m1")]);
    });

    it("puts a reply draft in its original's thread, ordered by time", async () => {
      const { userId, apiKey } = await createTestUser({ id: "drafter" });
      await createTestPerson();
      await createTestEmail({
        id: "orig",
        recipient: MINE,
        messageId: "<orig@example.com>",
        conversationId: "c_0123456789abcdef",
      });
      await getDb()
        .update(emails)
        .set({ receivedAt: BASE + 100 })
        .where(eq(emails.id, "orig"));
      const reply = await createDraft(apiKey, userId, {
        inReplyTo: ["orig@example.com"],
        receivedAt: iso(BASE + 200),
      });
      const alone = await createDraft(apiKey, userId, {
        to: [{ email: "nobody@example.com" }],
      });

      const res = await jmapJson(apiKey, [
        [
          "Thread/get",
          {
            accountId: acct(userId),
            ids: [thread("c_0123456789abcdef")],
          },
          "t",
        ],
        ["Thread/get", { accountId: acct(userId), ids: null }, "all"],
      ]);
      expect(res.methodResponses[0][1].list).toEqual([
        { id: thread("c_0123456789abcdef"), emailIds: [rid("orig"), reply.id] },
      ]);
      expect(res.methodResponses[1][1].list).toContainEqual({
        id: alone.threadId,
        emailIds: [alone.id],
      });
    });

    it("counts drafts in Drafts and Trash, grants Drafts rights, and moves the state", async () => {
      const { userId, apiKey } = await createTestUser({ id: "drafter" });
      const before = await jmapJson(apiKey, [
        ["Mailbox/query", { accountId: acct(userId) }, "q"],
      ]);
      await createDraft(apiKey, userId, { to: [{ email: "one@example.com" }] });
      const seen = await createDraft(apiKey, userId, {
        to: [{ email: "two@example.com" }],
        keywords: { $draft: true, $seen: true },
      });
      await jmapJson(apiKey, [
        [
          "Email/set",
          {
            accountId: acct(userId),
            update: {
              [seen.id]: { mailboxIds: { [sys(MINE, "trash")]: true } },
            },
          },
          "s",
        ],
      ]);
      const res = await jmapJson(apiKey, [
        [
          "Mailbox/get",
          {
            accountId: acct(userId),
            ids: [sys(MINE, "drafts"), sys(MINE, "trash")],
          },
          "m",
        ],
        ["Mailbox/query", { accountId: acct(userId) }, "q"],
      ]);
      const [drafts, trash] = res.methodResponses[0][1].list;
      // RFC 8621 §2: an Email counts as unread only with neither $seen nor
      // $draft, so the unseen draft is not unread.
      expect(drafts).toMatchObject({
        totalEmails: 1,
        unreadEmails: 0,
        totalThreads: 1,
        unreadThreads: 0,
        myRights: {
          mayAddItems: true,
          mayRemoveItems: true,
          maySetSeen: true,
          maySetKeywords: true,
          maySubmit: false,
        },
      });
      expect(trash).toMatchObject({
        totalEmails: 1,
        unreadEmails: 0,
        totalThreads: 1,
        unreadThreads: 0,
      });
      expect(res.methodResponses[1][1].queryState).not.toBe(
        before.methodResponses[0][1].queryState,
      );
    });
  });

  describe("blobs, changes and isolation", () => {
    const download = (apiKey: string, userId: string, blobId: string) =>
      authFetch(`/jmap/download/${acct(userId)}/${blobId}/blob.bin`, {
        apiKey,
      });

    it("downloads the raw message with exactly size octets and the draft's parts", async () => {
      const { userId, apiKey } = await createTestUser({ id: "drafter" });
      const blobId = await upload(apiKey, userId, "hello");
      const created = await createDraft(apiKey, userId, {
        attachments: [{ blobId, name: "a.txt" }],
      });

      const rawResponse = await download(apiKey, userId, created.blobId);
      expect(rawResponse.status).toBe(200);
      const rawBytes = new Uint8Array(await rawResponse.arrayBuffer());
      expect(rawBytes.byteLength).toBe(created.size);
      const rawText = new TextDecoder().decode(rawBytes);
      expect(rawText).toContain("Subject: Hello\r\n");
      expect(rawText).toContain('filename="a.txt"');

      const text = await download(
        apiKey,
        userId,
        publicBodyPartBlobId(created.id, "1"),
      );
      expect(await text.text()).toBe("Hi there");
      const attachment = await download(
        apiKey,
        userId,
        publicBodyPartBlobId(created.id, "2"),
      );
      expect(await attachment.text()).toBe("hello");
      expect(
        (await download(apiKey, userId, publicBodyPartBlobId(created.id, "9")))
          .status,
      ).toBe(404);
    });

    it("downloads text and html body parts of received mail", async () => {
      const { userId, apiKey } = await createTestUser({ id: "drafter" });
      await createTestPerson();
      await createTestEmail({
        id: "body",
        recipient: MINE,
        messageId: "body@example.com",
        bodyText: "Plain",
      });
      expect(
        await (
          await download(
            apiKey,
            userId,
            publicBodyPartBlobId(rid("body"), "text"),
          )
        ).text(),
      ).toBe("Plain");
      expect(
        await (
          await download(
            apiKey,
            userId,
            publicBodyPartBlobId(rid("body"), "html"),
          )
        ).text(),
      ).toBe("<p>Hello</p>");
      expect(
        (await download(apiKey, userId, publicBodyPartBlobId(rid("body"), "1")))
          .status,
      ).toBe(404);
    });

    it("keeps a draft's attachment after its upload is reaped", async () => {
      const { userId, apiKey } = await createTestUser({ id: "drafter" });
      const blobId = await upload(apiKey, userId, "keep me");
      const created = await createDraft(apiKey, userId, {
        attachments: [{ blobId }],
      });
      // What the upload reaper does: the row and its R2 object go.
      const uploadId = blobId.slice(1);
      await getDb().delete(jmapBlobs).where(eq(jmapBlobs.id, uploadId));
      await env.R2.delete(`jmap-uploads/${userId}/${uploadId}`);

      const attachment = await download(
        apiKey,
        userId,
        publicBodyPartBlobId(created.id, "2"),
      );
      expect(await attachment.text()).toBe("keep me");
      expect((await download(apiKey, userId, created.blobId)).status).toBe(200);
    });

    it("reports draft create, update and destroy through Email/changes and Mailbox/changes", async () => {
      const { userId, apiKey } = await createTestUser({ id: "drafter" });
      const stateOf = async () =>
        (
          await jmapJson(apiKey, [
            ["Email/get", { accountId: acct(userId), ids: [] }, "g"],
          ])
        ).methodResponses[0][1].state as string;
      const changesSince = async (sinceState: string) =>
        (
          await jmapJson(apiKey, [
            ["Email/changes", { accountId: acct(userId), sinceState }, "e"],
            ["Mailbox/changes", { accountId: acct(userId), sinceState }, "m"],
          ])
        ).methodResponses;

      const start = await stateOf();
      const created = await createDraft(apiKey, userId);
      let [email, mailbox] = await changesSince(start);
      expect(email[1]).toMatchObject({
        created: [created.id],
        updated: [],
        destroyed: [],
      });
      expect(mailbox[1].updated).toContain(sys(MINE, "drafts"));

      const afterCreate = await stateOf();
      await jmapJson(apiKey, [
        [
          "Email/set",
          {
            accountId: acct(userId),
            update: { [created.id]: { "keywords/$seen": true } },
          },
          "s",
        ],
      ]);
      [email] = await changesSince(afterCreate);
      expect(email[1]).toMatchObject({
        created: [],
        updated: [created.id],
        destroyed: [],
      });

      const afterUpdate = await stateOf();
      await jmapJson(apiKey, [
        ["Email/set", { accountId: acct(userId), destroy: [created.id] }, "s"],
      ]);
      [email] = await changesSince(afterUpdate);
      expect(email[1]).toMatchObject({
        created: [],
        updated: [],
        destroyed: [created.id],
      });
    });

    it("never shows one member's draft to another member of the same inbox", async () => {
      const author = await member("draftmember-a", "author@example.com");
      const other = await member("draftmember-b", "other@example.com");
      const otherState = (
        await jmapJson(other.apiKey, [
          ["Email/get", { accountId: acct(other.userId), ids: [] }, "g"],
        ])
      ).methodResponses[0][1].state;
      const created = await createDraft(author.apiKey, author.userId, {
        to: [{ email: "nobody@example.com" }],
      });

      const res = await jmapJson(other.apiKey, [
        [
          "Email/get",
          { accountId: acct(other.userId), ids: [created.id] },
          "g",
        ],
        ["Email/query", { accountId: acct(other.userId) }, "q"],
        [
          "Thread/get",
          { accountId: acct(other.userId), ids: [created.threadId] },
          "t",
        ],
        [
          "Email/changes",
          { accountId: acct(other.userId), sinceState: otherState },
          "c",
        ],
        [
          "Mailbox/get",
          { accountId: acct(other.userId), ids: [sys(MINE, "drafts")] },
          "m",
        ],
      ]);
      expect(res.methodResponses[0][1].notFound).toEqual([created.id]);
      expect(res.methodResponses[1][1].ids).not.toContain(created.id);
      expect(res.methodResponses[2][1].notFound).toEqual([created.threadId]);
      expect(res.methodResponses[3][1].created).not.toContain(created.id);
      expect(res.methodResponses[4][1].list[0].totalEmails).toBe(0);
      expect(
        (await download(other.apiKey, other.userId, created.blobId)).status,
      ).toBe(404);
      expect(
        (
          await download(
            other.apiKey,
            other.userId,
            publicBodyPartBlobId(created.id, "1"),
          )
        ).status,
      ).toBe(404);
    });
  });
});
