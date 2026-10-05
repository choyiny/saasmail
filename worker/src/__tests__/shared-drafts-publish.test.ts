import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import {
  applyMigrations,
  authFetch,
  cleanDb,
  createTestPerson,
  getDb,
} from "./helpers";
import { acct, sys } from "./jmap-ids";
import { drafts } from "../db/drafts.schema";
import { emails } from "../db/emails.schema";
import { jmapDrafts } from "../db/jmap-drafts.schema";
import { users } from "../db/auth.schema";
import { resolveAllowedInboxes } from "../lib/inbox-permissions";
import { publicDraftEmailId } from "../jmap/public-ids";
import { publishWebDraft } from "../jmap/web-drafts";
import {
  INBOX,
  changeRows,
  jmapCall,
  seedAccount,
} from "./jmap-submission-fixtures";

type Responses = [string, Record<string, any>, string][];

describe("shared drafts: publishing a web draft to JMAP", () => {
  let authorId: string;
  let apiKey: string;

  beforeAll(async () => {
    await applyMigrations();
  });
  beforeEach(async () => {
    await cleanDb();
    ({ authorId, authorApiKey: apiKey } = await seedAccount());
  });

  async function save(body: Record<string, unknown>) {
    const res = await authFetch("/api/drafts", {
      apiKey,
      method: "PUT",
      body: JSON.stringify({ contextKey: "draft:one", ...body }),
    });
    expect(res.status).toBe(200);
  }

  async function publish(contextKey = "draft:one") {
    const res = await authFetch("/api/drafts/publish", {
      apiKey,
      method: "POST",
      body: JSON.stringify({ contextKey }),
    });
    expect(res.status).toBe(200);
    return (await res.json()) as { status: string; reason?: string };
  }

  async function linkedId(contextKey = "draft:one"): Promise<string | null> {
    const [row] = await getDb()
      .select({ id: drafts.jmapDraftId })
      .from(drafts)
      .where(eq(drafts.contextKey, contextKey));
    return row?.id ?? null;
  }

  async function getEmail(internalId: string) {
    const res = (await jmapCall(authorId, [
      [
        "Email/get",
        {
          accountId: acct(authorId),
          ids: [publicDraftEmailId(internalId)],
          properties: [
            "mailboxIds",
            "keywords",
            "from",
            "to",
            "cc",
            "subject",
            "inReplyTo",
            "references",
            "bodyValues",
            "textBody",
            "htmlBody",
          ],
          fetchAllBodyValues: true,
        },
        "g",
      ],
    ])) as Responses;
    return res[0][1];
  }

  const FULL = {
    fromAddress: INBOX,
    to: "alice@example.com",
    cc: [{ email: "bob@example.com", name: "Bob" }],
    subject: "Plans",
    bodyHtml: "<p>Hello <b>Alice</b></p>",
    bodyText: "Hello Alice",
  };

  it("publishes a web draft as a JMAP draft with its fields, once", async () => {
    await save(FULL);
    expect(await publish()).toEqual({ status: "published" });
    const id = (await linkedId())!;
    const got = await getEmail(id);
    const email = got.list[0];
    expect(email.mailboxIds).toEqual({ [sys(INBOX, "drafts")]: true });
    expect(email.keywords).toEqual({ $draft: true, $seen: true });
    expect(email.from).toEqual([{ name: "Hello Team", email: INBOX }]);
    expect(email.to).toEqual([{ name: null, email: "alice@example.com" }]);
    expect(email.cc).toEqual([{ name: "Bob", email: "bob@example.com" }]);
    expect(email.subject).toBe("Plans");
    const values = Object.values(email.bodyValues).map(
      (value: any) => value.value,
    );
    expect(values).toEqual(
      expect.arrayContaining(["Hello Alice", "<p>Hello <b>Alice</b></p>"]),
    );

    // Nothing changed: no new revision.
    expect(await publish()).toEqual({ status: "unchanged" });
    expect(await linkedId()).toBe(id);
  });

  it("an edit publishes a new revision and destroys the old one", async () => {
    await save(FULL);
    await publish();
    const first = (await linkedId())!;
    await save({ ...FULL, subject: "Plans v2" });
    expect(await publish()).toEqual({ status: "published" });
    const second = (await linkedId())!;
    expect(second).not.toBe(first);
    expect((await getEmail(first)).notFound).toEqual([
      publicDraftEmailId(first),
    ]);
    expect((await getEmail(second)).list[0].subject).toBe("Plans v2");
    expect((await changeRows(`draft:${first}`)).map((r) => r.op)).toEqual([
      "c",
      "d",
    ]);
  });

  it("keeps the folders and flag a JMAP client gave the last revision", async () => {
    await save(FULL);
    await publish();
    const first = (await linkedId())!;
    await jmapCall(authorId, [
      [
        "Email/set",
        {
          accountId: acct(authorId),
          update: {
            [publicDraftEmailId(first)]: {
              "mailboxIds/Mf1": true,
              "keywords/$flagged": true,
            },
          },
        },
        "u",
      ],
    ]);
    await save({ ...FULL, subject: "Moved" });
    await publish();
    const email = (await getEmail((await linkedId())!)).list[0];
    expect(email.mailboxIds).toEqual({
      [sys(INBOX, "drafts")]: true,
      Mf1: true,
    });
    expect(email.keywords.$flagged).toBe(true);
  });

  it("waits for a From and a complete To", async () => {
    await save({ ...FULL, fromAddress: undefined });
    expect(await publish()).toMatchObject({ status: "skipped" });
    await save({ ...FULL, to: "alic" });
    expect(await publish()).toMatchObject({
      status: "skipped",
      reason: "invalid to",
    });
    expect(await linkedId()).toBeNull();
    expect(await getDb().select().from(jmapDrafts)).toEqual([]);
  });

  it("threads a web reply draft to the message it answers", async () => {
    const now = Math.floor(Date.now() / 1000);
    await createTestPerson({ id: "p1", email: "alice@example.com" });
    await getDb().insert(emails).values({
      id: "recv-1",
      personId: "p1",
      recipient: INBOX,
      subject: "Question",
      bodyText: "?",
      rawHeaders: "{}",
      messageId: "<question-1@example.com>",
      isRead: 0,
      conversationId: "conv-1",
      receivedAt: now,
      createdAt: now,
    });
    await save({
      ...FULL,
      contextKey: "reply:recv-1",
      replyToEmailId: "recv-1",
      subject: "Re: Question",
    });
    expect(await publish("reply:recv-1")).toEqual({ status: "published" });
    const email = (await getEmail((await linkedId("reply:recv-1"))!)).list[0];
    expect(email.inReplyTo).toEqual(["question-1@example.com"]);
    expect(email.references).toEqual(["question-1@example.com"]);
  });

  it("deleting the web draft deletes its JMAP draft", async () => {
    await save(FULL);
    await publish();
    const id = (await linkedId())!;
    const res = await authFetch("/api/drafts?contextKey=draft%3Aone", {
      apiKey,
      method: "DELETE",
    });
    expect(res.status).toBe(200);
    expect((await getEmail(id)).notFound).toEqual([publicDraftEmailId(id)]);
  });

  it("a draft deleted in JMAP is gone for the web: publishing stops", async () => {
    await save(FULL);
    await publish();
    const id = (await linkedId())!;
    await jmapCall(authorId, [
      [
        "Email/set",
        { accountId: acct(authorId), destroy: [publicDraftEmailId(id)] },
        "d",
      ],
    ]);
    await save({ ...FULL, subject: "Edited after" });
    expect(await publish()).toEqual({ status: "gone" });
    expect(await publish()).toEqual({ status: "gone" });
    expect(await getDb().select().from(jmapDrafts)).toEqual([]);
  });

  it("two publishes racing leave exactly one JMAP draft", async () => {
    await save(FULL);
    const db = getDb();
    const [user] = await db.select().from(users).where(eq(users.id, authorId));
    const allowed = await resolveAllowedInboxes(db, user);
    const outcomes = await Promise.all([
      publishWebDraft(db, env, allowed, authorId, "draft:one"),
      publishWebDraft(db, env, allowed, authorId, "draft:one"),
    ]);
    expect(outcomes.map((o) => o.status).sort()).toEqual(
      expect.arrayContaining(["published"]),
    );
    const rows = await db.select().from(jmapDrafts);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(await linkedId());
  });
});
