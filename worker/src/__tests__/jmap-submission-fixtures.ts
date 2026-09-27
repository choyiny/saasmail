// Test-only builders for PR 6. Real JMAP calls go through jmapCall(); rows the
// tests need in a specific crash state are inserted directly.
import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { users } from "../db/auth.schema";
import { attachments } from "../db/attachments.schema";
import { inboxPermissions } from "../db/inbox-permissions.schema";
import { jmapDrafts } from "../db/jmap-drafts.schema";
import { jmapMessageContent } from "../db/jmap-message-content.schema";
import { jmapSubmissions } from "../db/jmap-submissions.schema";
import { mailboxes } from "../db/mailboxes.schema";
import { outboxEmails } from "../db/outbox-emails.schema";
import { senderIdentities } from "../db/sender-identities.schema";
import { sentEmails } from "../db/sent-emails.schema";
import { CORE_CAPABILITY, MAIL_CAPABILITY } from "../jmap/constants";
import { executeJmapCalls } from "../jmap/http";
import { resolveAllowedInboxes } from "../lib/inbox-permissions";
import type {
  EmailSender,
  SendEmailParams,
  SendEmailResult,
} from "../lib/email-sender";
import { createTestUser, getDb } from "./helpers";
import { sys } from "./jmap-ids";

export const INBOX = "hello@saasmail.test";
export const SUBMISSION_CAPABILITY = "urn:ietf:params:jmap:submission";
export const USING = [CORE_CAPABILITY, MAIL_CAPABILITY, SUBMISSION_CAPABILITY];

export const OK: SendEmailResult = { id: "prov-1", error: null };
export const TRANSIENT: SendEmailResult = {
  id: null,
  error: { message: "quota exceeded", transient: true },
};
export const TERMINAL: SendEmailResult = {
  id: null,
  error: { message: "mailbox does not exist", transient: false },
};

/** A sender that records every call; returns `results` in order, then OK. */
export function recordingSender(...results: SendEmailResult[]) {
  const calls: SendEmailParams[] = [];
  const queue = [...results];
  const sender: EmailSender = {
    provider: "cloudflare" as const,
    async send(params: SendEmailParams) {
      calls.push(params);
      return queue.shift() ?? OK;
    },
    maxAttachmentBytes: () => 25 * 1024 * 1024,
    maxMessageBytes: () => 25 * 1024 * 1024,
  };
  return { sender, calls };
}

/**
 * An admin author, a member with access to INBOX, the INBOX identity (display
 * name "Hello Team") and one custom folder "f1" in INBOX.
 */
export async function seedAccount() {
  const now = Math.floor(Date.now() / 1000);
  const author = await createTestUser({ id: "jmap-author", role: "admin" });
  const member = await createTestUser({
    id: "jmap-member",
    role: "member",
    email: "member@example.com",
  });
  await getDb().insert(inboxPermissions).values({
    userId: member.userId,
    email: INBOX,
    createdAt: now,
    createdBy: null,
  });
  await getDb().insert(senderIdentities).values({
    email: INBOX,
    displayName: "Hello Team",
    createdAt: now,
    updatedAt: now,
  });
  await getDb().insert(mailboxes).values({
    id: "f1",
    inbox: INBOX,
    name: "Folder 1",
    role: null,
    parentId: null,
    sortOrder: 1,
    createdBy: author.userId,
    createdAt: now,
    updatedAt: now,
  });
  return {
    authorId: author.userId,
    authorApiKey: author.apiKey,
    memberId: member.userId,
  };
}

/** Run a JMAP request as `userId`, exactly like POST /jmap/api does. */
export async function jmapCall(
  userId: string,
  methodCalls: [string, Record<string, unknown>, string][],
  options: { sender?: EmailSender; createdIds?: Map<string, string> } = {},
) {
  const db = getDb();
  const [user] = await db.select().from(users).where(eq(users.id, userId));
  const allowed = await resolveAllowedInboxes(db, user);
  return executeJmapCalls(db, allowed, user, USING, methodCalls, {
    env,
    createdIds: options.createdIds ?? new Map(),
    sender: options.sender,
  });
}

/** A valid Email/set create for a draft in INBOX (flattened body form). */
export function draftCreate(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    mailboxIds: { [sys(INBOX, "drafts")]: true },
    keywords: { $draft: true, $seen: true },
    from: [{ name: "Hello Team", email: INBOX }],
    to: [{ name: "Alice Example", email: "alice@example.com" }],
    cc: [{ name: "Bob, Jr.", email: "bob@example.com" }],
    subject: "Quarterly numbers",
    inReplyTo: ["orig-1@example.com"],
    references: ["root-1@example.com", "orig-1@example.com"],
    textBody: [{ partId: "t", type: "text/plain" }],
    bodyValues: { t: { value: "Numbers attached." } },
    ...overrides,
  };
}

type ContentOptions = {
  id: string;
  userId: string;
  inbox?: string;
  threadKey?: string;
  toName?: string | null;
};

/** A minimal immutable content row plus its raw R2 object. */
export async function insertTestContent(opts: ContentOptions) {
  const inbox = opts.inbox ?? INBOX;
  const raw = new TextEncoder().encode(
    `From: ${inbox}\r\nTo: alice@example.com\r\nSubject: Hello\r\n\r\nhello\r\n`,
  );
  const rawR2Key = `jmap-content/${opts.userId}/${opts.id}.eml`;
  const now = Math.floor(Date.now() / 1000);
  await getDb()
    .insert(jmapMessageContent)
    .values({
      id: opts.id,
      createdBy: opts.userId,
      inbox,
      fromJson: JSON.stringify([{ name: "Hello Team", email: inbox }]),
      toJson: JSON.stringify([
        { name: opts.toName ?? "Alice Example", email: "alice@example.com" },
      ]),
      ccJson: "[]",
      bccJson: "[]",
      replyToJson: null,
      subject: "Hello",
      messageId: `${opts.id}@saasmail.test`,
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
        size: 5,
        r2Key: null,
      }),
      textBodyJson: '["1"]',
      htmlBodyJson: '["1"]',
      attachmentsJson: "[]",
      bodyValuesJson: '{"1":"hello"}',
      preview: "hello",
      threadKey: opts.threadKey ?? `draft:d-${opts.id}`,
      rawR2Key,
      size: raw.byteLength,
      createdAt: now,
    });
  await env.R2.put(rawR2Key, raw);
  return { rawR2Key, size: raw.byteLength };
}

export async function insertTestDraft(opts: {
  id: string;
  userId: string;
  contentId: string;
  inbox?: string;
  submitState?: "submitting" | "queued" | null;
  submitAttemptId?: string | null;
  seen?: 0 | 1;
  receivedAt?: number;
}) {
  const now = Math.floor(Date.now() / 1000);
  await getDb()
    .insert(jmapDrafts)
    .values({
      id: opts.id,
      userId: opts.userId,
      contentId: opts.contentId,
      inbox: opts.inbox ?? INBOX,
      receivedAt: opts.receivedAt ?? now - 600,
      mailboxRole: "drafts",
      seen: opts.seen ?? 1,
      flagged: 0,
      submitState: opts.submitState ?? null,
      submitAttemptId: opts.submitAttemptId ?? null,
      createdAt: now,
      updatedAt: now,
    });
}

export async function insertTestSubmission(opts: {
  id: string;
  userId: string;
  draftId: string;
  contentId: string;
  sentEmailId: string;
  attemptState: "claimed" | "accepted";
  onSuccessState?: "pending" | "applied";
  onSuccessMode?: "none" | "update" | "destroy" | "both";
  onSuccessPatch?: Record<string, unknown> | null;
  createdAt?: number;
  sendAt?: number;
}) {
  const now = Math.floor(Date.now() / 1000);
  await getDb()
    .insert(jmapSubmissions)
    .values({
      id: opts.id,
      userId: opts.userId,
      attemptState: opts.attemptState,
      onSuccessState: opts.onSuccessState ?? "pending",
      draftId: opts.draftId,
      contentId: opts.contentId,
      identityId: "i-identity",
      identityEmail: INBOX,
      emailId: `D${opts.draftId}`,
      threadId: `Td${opts.draftId}`,
      sentEmailId: opts.sentEmailId,
      envelopeJson: JSON.stringify({
        mailFrom: { email: INBOX, parameters: null },
        rcptTo: [{ email: "alice@example.com", parameters: null }],
      }),
      onSuccessMode: opts.onSuccessMode ?? "none",
      onSuccessPatchJson: opts.onSuccessPatch
        ? JSON.stringify(opts.onSuccessPatch)
        : null,
      sendAt: opts.sendAt ?? opts.createdAt ?? now,
      undoStatus: "final",
      createdAt: opts.createdAt ?? now,
      fromHeader: `Hello Team <${INBOX}>`,
    });
}

export async function insertTestOutboxRow(opts: {
  sentEmailId: string;
  status: "pending" | "failed" | "bookkeeping_pending";
  owner?: "jmap" | "campaign" | null;
  nextRetryAt?: number;
}) {
  const now = Math.floor(Date.now() / 1000);
  const id = `ob-${opts.sentEmailId}`;
  await getDb()
    .insert(outboxEmails)
    .values({
      id,
      sentEmailId: opts.sentEmailId,
      bookkeepingOwner: opts.owner === undefined ? "jmap" : opts.owner,
      fromAddress: INBOX,
      toAddress: "alice@example.com",
      subject: "Hello",
      bodyHtml: "hello",
      bodyText: "hello",
      headers: JSON.stringify({ "Message-ID": `<${opts.sentEmailId}@x>` }),
      transactional: 1,
      status: opts.status,
      attempts: 1,
      nextRetryAt: opts.nextRetryAt ?? now + 3600,
      createdAt: now - 3600,
      updatedAt: now - 3600,
    });
  return id;
}

/** A staged sent attachment: D1 row plus its R2 object (PR 2 layout). */
export async function insertStagedAttachment(sentEmailId: string) {
  const r2Key = `attachments/sent/${sentEmailId}/att-${sentEmailId}/a.txt`;
  await getDb()
    .insert(attachments)
    .values({
      id: `att-${sentEmailId}`,
      emailId: sentEmailId,
      kind: "sent",
      filename: "a.txt",
      contentType: "text/plain",
      size: 1,
      r2Key,
      contentId: null,
      createdAt: Math.floor(Date.now() / 1000) - 7200,
    });
  await env.R2.put(r2Key, "a");
  return r2Key;
}

/** A JMAP-originated Sent row (as PR 5's after-call batch writes it). */
export async function insertJmapSentRow(opts: {
  id: string;
  contentId: string;
  status?: "sent" | "retrying" | "failed";
  jmapEmailId?: string | null;
  jmapReceivedAt?: number | null;
}) {
  const now = Math.floor(Date.now() / 1000);
  await getDb()
    .insert(sentEmails)
    .values({
      id: opts.id,
      personId: null,
      fromAddress: INBOX,
      toAddress: "alice@example.com",
      subject: "Hello",
      bodyHtml: null,
      bodyText: "hello",
      messageId: `<${opts.contentId}@saasmail.test>`,
      status: opts.status ?? "sent",
      sentAt: now - 60,
      createdAt: now - 60,
      jmapContentId: opts.contentId,
      jmapEmailId: opts.jmapEmailId ?? null,
      jmapReceivedAt: opts.jmapReceivedAt ?? null,
    });
}

/** Every change-log row for one internal object id, oldest first. */
export async function changeRows(objectId: string) {
  const { results } = await env.DB.prepare(
    `SELECT object_id, inbox, user_id, exclude_user_id, op
       FROM jmap_changes WHERE object_id = ? ORDER BY seq`,
  )
    .bind(objectId)
    .all<{
      object_id: string;
      inbox: string | null;
      user_id: string | null;
      exclude_user_id: string | null;
      op: string;
    }>();
  return results;
}
