// Live QA 2026-09-27 J1: Cloudflare replaces the Message-ID we send. The Sent
// row records the one recipients got, so a reply to our own sent message cites
// an id they have.
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { applyMigrations, cleanDb, getDb } from "./helpers";
import { outboxEmails } from "../db/outbox-emails.schema";
import { sentEmails } from "../db/sent-emails.schema";
import { replyToEmail, sendEmail } from "../lib/send-email";
import { attemptOutboxRow } from "../lib/outbox";
import type {
  EmailSender,
  SendEmailParams,
  SendEmailResult,
} from "../lib/email-sender";

const ADMIN = { isAdmin: true } as const;

function sender(...results: SendEmailResult[]) {
  const calls: SendEmailParams[] = [];
  const s: EmailSender = {
    provider: "cloudflare" as const,
    async send(params: SendEmailParams) {
      calls.push(params);
      return results[Math.min(calls.length - 1, results.length - 1)];
    },
    maxAttachmentBytes: () => 25 * 1024 * 1024,
    maxMessageBytes: () => 5 * 1024 * 1024,
  };
  return { sender: s, calls };
}

function cloudflare(id: string): SendEmailResult {
  return { id: `<${id}>`, deliveredMessageId: `<${id}>`, error: null };
}

const payload = {
  to: "to@example.com",
  fromAddress: "me@saasmail.test",
  subject: "Hello",
  bodyHtml: "<p>hi</p>",
  transactional: true,
};

async function sentRow(id: string) {
  const [row] = await getDb()
    .select()
    .from(sentEmails)
    .where(eq(sentEmails.id, id));
  return row;
}

describe("the delivered Message-ID of a web send", () => {
  beforeAll(async () => {
    await applyMigrations();
  });
  beforeEach(async () => {
    await cleanDb();
  });

  it("is recorded on the Sent row, and a reply to it cites it", async () => {
    const first = sender(cloudflare("cf-1@cf.test"));
    const sent = await sendEmail({
      db: getDb(),
      env,
      payload,
      files: [],
      allowed: ADMIN,
      sender: first.sender,
    });
    if (!sent.ok || !sent.id) throw new Error("send failed");
    expect(first.calls[0].headers?.["Message-ID"]).toMatch(
      /^<.+@saasmail\.test>$/,
    );
    expect((await sentRow(sent.id)).messageId).toBe("<cf-1@cf.test>");

    const second = sender(cloudflare("cf-2@cf.test"));
    const reply = await replyToEmail({
      db: getDb(),
      env,
      emailId: sent.id,
      payload: { fromAddress: "me@saasmail.test", bodyHtml: "<p>again</p>" },
      files: [],
      allowed: ADMIN,
      sender: second.sender,
    });
    if (!reply.ok) throw new Error("reply failed");
    expect(second.calls[0].headers?.["In-Reply-To"]).toBe("<cf-1@cf.test>");
    const replyRow = await sentRow(reply.id);
    expect(replyRow.inReplyTo).toBe("<cf-1@cf.test>");
    expect(replyRow.messageId).toBe("<cf-2@cf.test>");
  });

  it("keeps the submitted id when the provider reports none", async () => {
    const plain = sender({ id: "tracking-1", error: null });
    const sent = await sendEmail({
      db: getDb(),
      env,
      payload,
      files: [],
      allowed: ADMIN,
      sender: plain.sender,
    });
    if (!sent.ok || !sent.id) throw new Error("send failed");
    expect((await sentRow(sent.id)).messageId).toBe(
      plain.calls[0].headers?.["Message-ID"],
    );
  });

  it("an outbox retry records the id of the attempt that was delivered", async () => {
    const failing = sender({
      id: null,
      error: { message: "quota exceeded", transient: true },
    });
    const sent = await sendEmail({
      db: getDb(),
      env,
      payload,
      files: [],
      allowed: ADMIN,
      sender: failing.sender,
    });
    if (!sent.ok || !sent.id) throw new Error("send failed");
    const submitted = failing.calls[0].headers?.["Message-ID"];
    expect((await sentRow(sent.id)).messageId).toBe(submitted);

    const [row] = await getDb()
      .select()
      .from(outboxEmails)
      .where(eq(outboxEmails.sentEmailId, sent.id));
    await getDb()
      .update(outboxEmails)
      .set({ nextRetryAt: 0 })
      .where(eq(outboxEmails.id, row.id));
    const retry = sender(cloudflare("cf-r@cf.test"));
    expect(await attemptOutboxRow(getDb(), env, retry.sender, row.id)).toBe(
      "sent",
    );
    expect(retry.calls[0].headers?.["Message-ID"]).toBe(submitted);
    expect((await sentRow(sent.id)).messageId).toBe("<cf-r@cf.test>");
  });
});
