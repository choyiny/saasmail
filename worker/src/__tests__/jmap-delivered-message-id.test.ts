// Live QA 2026-09-27 J1/J2. Cloudflare replaces a message's Message-ID with its
// own, so a JMAP-sent message has two ids: the Email's own (immutable, in its
// content row) and the one recipients received (on the Sent row). A follow-up
// must cite the delivered one on the wire and still thread by the Email's own.
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import {
  applyMigrations,
  cleanDb,
  createTestSentEmail,
  createTestUser,
  getDb,
} from "./helpers";
import { attachments } from "../db/attachments.schema";
import { outboxEmails } from "../db/outbox-emails.schema";
import { senderIdentities } from "../db/sender-identities.schema";
import { sentEmails } from "../db/sent-emails.schema";
import type { SendEmailResult } from "../lib/email-sender";
import { attemptOutboxRow } from "../lib/outbox";
import { parseRawBlobId } from "../jmap/public-ids";
import {
  MINE,
  TRANSIENT,
  addIdentity,
  createDraft,
  recordingSender,
  runJmap,
  submitCall,
  uploadBlob,
} from "./jmap-harness";
import { acct, sid } from "./jmap-ids";

/** What CloudflareSender returns: its own Message-ID, which recipients get. */
function cloudflare(id: string): SendEmailResult {
  return { id: `<${id}>`, deliveredMessageId: `<${id}>`, error: null };
}

async function sentRowFor(blobId: string) {
  const [row] = await getDb()
    .select()
    .from(sentEmails)
    .where(eq(sentEmails.jmapContentId, parseRawBlobId(blobId)!));
  return row;
}

async function emailGet(
  userId: string,
  ids: string[],
  properties: string[],
  extra: Record<string, unknown> = {},
): Promise<Record<string, any>[]> {
  const { sender } = recordingSender();
  const [response] = await runJmap(
    userId,
    [
      [
        "Email/get",
        { accountId: acct(userId), ids, properties, ...extra },
        "g",
      ],
    ],
    sender,
  );
  return (response[1] as Record<string, any>).list;
}

describe("the delivered Message-ID of a JMAP send", () => {
  let userId: string;
  let apiKey: string;

  beforeAll(async () => {
    await applyMigrations();
  });
  beforeEach(async () => {
    await cleanDb();
    ({ userId, apiKey } = await createTestUser({ id: "wire-user" }));
    await addIdentity(MINE);
  });

  /** Send a first message A; the provider delivers it as `<cf-a@cf.test>`. */
  async function sendFirst() {
    const { sender, calls } = recordingSender([cloudflare("cf-a@cf.test")]);
    const draft = await createDraft(userId, sender, {
      references: ["root@example.com"],
    });
    await runJmap(userId, [submitCall(userId, draft.id)], sender);
    const [email] = await emailGet(userId, [draft.id], ["messageId"]);
    return { draft, calls, logicalId: email.messageId[0] as string };
  }

  it("is recorded on the Sent row while the Email keeps its own", async () => {
    const { draft, calls, logicalId } = await sendFirst();

    expect(calls[0].headers?.["Message-ID"]).toBe(`<${logicalId}>`);
    const sent = await sentRowFor(draft.blobId);
    expect(sent.messageId).toBe("<cf-a@cf.test>");
    expect(sent.resendId).toBe("<cf-a@cf.test>");
    // RFC 8621 §4.1.2.1: messageId is immutable. The aliased Sent Email is the
    // draft, so it still answers with the id it had as a draft.
    expect(logicalId).toMatch(/@saasmail\.test$/);
  });

  it("is what a follow-up cites on the wire; the follow-up keeps its own references and thread", async () => {
    const first = await sendFirst();
    const [a] = await emailGet(userId, [first.draft.id], ["threadId"]);

    const { sender, calls } = recordingSender([cloudflare("cf-b@cf.test")]);
    // A different recipient, so only the reference can put B in A's thread.
    const reply = await createDraft(userId, sender, {
      to: [{ name: "Carol", email: "carol@example.com" }],
      subject: "Re: Hello Bob",
      inReplyTo: [first.logicalId],
      references: ["root@example.com", first.logicalId],
    });
    expect(reply.threadId).toBe(a.threadId);

    await runJmap(userId, [submitCall(userId, reply.id)], sender);
    expect(calls[0].headers?.["In-Reply-To"]).toBe("<cf-a@cf.test>");
    expect(calls[0].headers?.References).toBe(
      "<root@example.com> <cf-a@cf.test>",
    );

    const [b] = await emailGet(
      userId,
      [reply.id],
      ["inReplyTo", "references", "threadId"],
    );
    expect(b.inReplyTo).toEqual([first.logicalId]);
    expect(b.references).toEqual(["root@example.com", first.logicalId]);
    expect(b.threadId).toBe(a.threadId);

    const sent = await sentRowFor(reply.blobId);
    expect(sent.inReplyTo).toBe("<cf-a@cf.test>");
    expect(sent.messageId).toBe("<cf-b@cf.test>");
  });

  it("an outbox retry records its own delivered id and cites delivered ids too", async () => {
    const first = await sendFirst();
    const failing = recordingSender([TRANSIENT]);
    const reply = await createDraft(userId, failing.sender, {
      inReplyTo: [first.logicalId],
      references: [first.logicalId],
    });
    await runJmap(userId, [submitCall(userId, reply.id)], failing.sender);
    expect(failing.calls[0].headers?.["In-Reply-To"]).toBe("<cf-a@cf.test>");
    const queued = await sentRowFor(reply.blobId);
    expect(queued.status).toBe("retrying");

    const [row] = await getDb()
      .select()
      .from(outboxEmails)
      .where(eq(outboxEmails.sentEmailId, queued.id));
    await getDb()
      .update(outboxEmails)
      .set({ nextRetryAt: 0 })
      .where(eq(outboxEmails.id, row.id));
    const retry = recordingSender([cloudflare("cf-r@cf.test")]);
    expect(await attemptOutboxRow(getDb(), env, retry.sender, row.id)).toBe(
      "sent",
    );
    expect(retry.calls[0].headers?.["In-Reply-To"]).toBe("<cf-a@cf.test>");
    expect(retry.calls[0].headers?.References).toBe("<cf-a@cf.test>");
    const sent = await sentRowFor(reply.blobId);
    expect(sent.status).toBe("sent");
    expect(sent.messageId).toBe("<cf-r@cf.test>");
  });

  it("leaves an id it doesn't know alone, and keeps the submitted id without a provider one", async () => {
    const { sender, calls } = recordingSender();
    const draft = await createDraft(userId, sender, {
      inReplyTo: ["elsewhere@example.com"],
      references: ["elsewhere@example.com"],
    });
    await runJmap(userId, [submitCall(userId, draft.id)], sender);
    expect(calls[0].headers?.["In-Reply-To"]).toBe("<elsewhere@example.com>");
    const sent = await sentRowFor(draft.blobId);
    expect(sent.messageId).toBe(calls[0].headers?.["Message-ID"]);
  });
});

describe("the web view of a JMAP-sent inline image (J2)", () => {
  let userId: string;
  let apiKey: string;

  beforeAll(async () => {
    await applyMigrations();
  });
  beforeEach(async () => {
    await cleanDb();
    ({ userId, apiKey } = await createTestUser({ id: "cid-user" }));
    await addIdentity(MINE);
  });

  it("points the Sent row's cid: at the staged attachment; the Email keeps cid:", async () => {
    const logo = await uploadBlob(
      userId,
      apiKey,
      new Uint8Array([137, 80, 78, 71]),
      "image/png",
    );
    const html =
      '<p>Hi <img src="cid:logo@mine"> and <img src="CID:logo@mine"></p>';
    const { sender, calls } = recordingSender();
    const draft = await createDraft(userId, sender, {
      bodyValues: { t: { value: "Hi" }, h: { value: html } },
      attachments: [
        {
          blobId: logo,
          type: "image/png",
          name: "logo.png",
          disposition: "inline",
          cid: "logo@mine",
        },
      ],
    });
    await runJmap(userId, [submitCall(userId, draft.id)], sender);

    // The recipient gets the message exactly as stored.
    expect(calls[0].html).toBe(html);

    const sent = await sentRowFor(draft.blobId);
    const [staged] = await getDb()
      .select()
      .from(attachments)
      .where(eq(attachments.emailId, sent.id));
    expect(sent.bodyHtml).toBe(
      `<p>Hi <img src="/api/attachments/${staged.id}/inline"> and <img src="/api/attachments/${staged.id}/inline"></p>`,
    );

    const [email] = await emailGet(
      userId,
      [draft.id],
      ["bodyValues", "htmlBody"],
      { fetchHTMLBodyValues: true },
    );
    const htmlPart = email.htmlBody[0].partId as string;
    expect(email.bodyValues[htmlPart].value).toBe(html);
  });
});

describe("the From name of an ordinary Sent Email (J3)", () => {
  let userId: string;

  beforeAll(async () => {
    await applyMigrations();
  });
  beforeEach(async () => {
    await cleanDb();
    ({ userId } = await createTestUser({ id: "from-user" }));
    await addIdentity(MINE, null);
  });

  it("stays as JMAP first showed it when the web starts naming the sender", async () => {
    await createTestSentEmail({ id: "web-1", fromAddress: MINE });
    const before = await emailGet(userId, [sid("web-1")], ["from", "size"]);

    await getDb()
      .update(senderIdentities)
      .set({ displayName: "Mine Inbox" })
      .where(eq(senderIdentities.email, MINE));
    const after = await emailGet(userId, [sid("web-1")], ["from", "size"]);

    // from and size are immutable (RFC 8621 §4.1): a client that already
    // fetched this Email never refetches them.
    expect(after).toEqual(before);
    expect(after[0].from).toEqual([{ email: MINE, name: null }]);
  });
});
