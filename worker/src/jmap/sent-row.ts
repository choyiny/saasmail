// The Sent row of a JMAP submission, written identically by the request path
// (spec §3.4 step 3) and by recovery (spec §3.4 table row 1/2): the same person
// row and conversation id the web composer computes, plus the content link and
// the Message-ID the message was delivered with.
import { and, eq } from "drizzle-orm";
import { jmapMessageContent } from "../db/jmap-message-content.schema";
import type { jmapSubmissions } from "../db/jmap-submissions.schema";
import { outboxEmails } from "../db/outbox-emails.schema";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { attachments } from "../db/attachments.schema";
import { sentEmails } from "../db/sent-emails.schema";
import type { SendEmailResult } from "../lib/email-sender";
import { deliveredMessageId } from "../lib/message-id";
import {
  findOrCreatePersonId,
  outboundConversationId,
} from "../lib/sent-bookkeeping";
import {
  buildSubmissionMessage,
  loadDeliveredMessageIds,
  submissionAttachmentLeaves,
  type SubmissionMessage,
} from "../lib/submit-message";
import type { JmapContentRow } from "./content";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = DrizzleD1Database<any>;

/** Values of the `sent_emails` row for one JMAP submission. */
export async function buildJmapSentRow(
  db: Db,
  input: {
    sentEmailId: string;
    content: JmapContentRow;
    message: SubmissionMessage;
    /** `sent` for a provider-accepted send, `retrying` while the outbox retries. */
    status: string;
    /** The provider's message id, when the first attempt returned one. */
    resendId?: string | null;
    /**
     * The first attempt's provider result, when there was one. A provider that
     * replaced our Message-ID reports the one recipients got; recovery has no
     * result and records the id we submitted.
     */
    providerResult?: SendEmailResult | null;
    now: number;
  },
): Promise<typeof sentEmails.$inferInsert> {
  const { message, now } = input;
  // The wire form: a reply to one of our own JMAP sends cites the id that
  // message was delivered with (buildSubmissionMessage), not the Email's own.
  const inReplyTo = message.headers["In-Reply-To"]?.split(" ")[0] ?? null;
  return {
    id: input.sentEmailId,
    personId: await findOrCreatePersonId(db, message.to, now),
    fromAddress: message.fromAddress,
    toAddress: message.to,
    subject: message.subject,
    bodyHtml: message.html
      ? await withInlineAttachmentUrls(db, input.sentEmailId, message.html)
      : null,
    bodyText: message.text ?? null,
    inReplyTo,
    messageId: deliveredMessageId(
      message.headers["Message-ID"],
      input.providerResult,
    ),
    resendId: input.resendId ?? null,
    status: input.status,
    cc: message.cc.length > 0 ? JSON.stringify(message.cc) : null,
    additionalTo:
      message.additionalTo.length > 0
        ? JSON.stringify(message.additionalTo)
        : null,
    bcc: message.bcc.length > 0 ? JSON.stringify(message.bcc) : null,
    // Every visible recipient takes part in the thread; Bcc does not, since
    // nobody else sees them.
    conversationId: await outboundConversationId(
      db,
      message.fromAddress,
      message.to,
      [...message.additionalTo, ...message.cc].map((address) => address.email),
    ),
    jmapContentId: input.content.id,
    sentAt: now,
    createdAt: now,
  };
}

/**
 * The web shows `sent_emails.body_html`, and a browser can't resolve `cid:`.
 * Point each inline image at its staged Sent attachment, as inbound mail does
 * (email-handler). Only the web copy changes: the JMAP Email keeps `cid:`
 * because it projects from the content row, and the recipient got the content.
 */
export async function withInlineAttachmentUrls(
  db: Db,
  sentEmailId: string,
  html: string,
): Promise<string> {
  if (!/cid:/i.test(html)) return html;
  const inline = await db
    .select({ id: attachments.id, contentId: attachments.contentId })
    .from(attachments)
    .where(
      and(eq(attachments.emailId, sentEmailId), eq(attachments.kind, "sent")),
    );
  let rewritten = html;
  for (const { id, contentId } of inline) {
    if (!contentId) continue;
    const cid = contentId.replace(/^<|>$/g, "");
    rewritten = rewritten.replace(
      new RegExp(`cid:${cid.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "gi"),
      `/api/attachments/${id}/inline`,
    );
  }
  return rewritten;
}

/** Write the Sent row a provider-accepted send is missing, from its content. */
export async function writeSentRow(
  db: Db,
  submission: typeof jmapSubmissions.$inferSelect,
  status: "sent" | "retrying" | "scheduled" | "canceled",
  now: number,
  /** From the held outbox row: the id the accepted message went out with. */
  deliveredId: string | null = null,
) {
  const [content] = await db
    .select()
    .from(jmapMessageContent)
    .where(eq(jmapMessageContent.id, submission.contentId))
    .limit(1);
  if (!content) {
    throw new Error(
      `content ${submission.contentId} missing for ${submission.id}`,
    );
  }
  const leaves = submissionAttachmentLeaves(content);
  const message = buildSubmissionMessage(
    content,
    { email: submission.identityEmail, displayName: null },
    // The staged attachment bytes live under the Sent row's own keys and were
    // already sent (or are owed by the outbox), so only the shape is needed here.
    leaves.map((leaf) => ({
      filename: leaf.name ?? `attachment-${leaf.partId}`,
      contentType: leaf.type,
      content: new ArrayBuffer(0),
      contentId: leaf.cid,
      disposition: leaf.disposition === "inline" ? "inline" : "attachment",
    })),
    await loadDeliveredMessageIds(db, content),
  );
  if (submission.fromHeader) message.from = submission.fromHeader;
  const row = await buildJmapSentRow(db, {
    sentEmailId: submission.sentEmailId,
    content,
    message,
    status,
    providerResult: {
      id: null,
      deliveredMessageId: deliveredId,
      error: null,
    },
    now,
  });
  await db
    .insert(sentEmails)
    .values(
      status === "scheduled" || status === "canceled"
        ? // As scheduleSubmission writes it: sent_at is the release time.
          {
            ...row,
            sentAt: submission.sendAt,
            jmapReceivedAt: submission.createdAt,
          }
        : row,
    )
    .onConflictDoNothing({ target: sentEmails.id });
}

/**
 * Cleanup spec §2: the on-success step never runs without the submission's Sent
 * row. A row deleted while still hidden (its person was deleted in the web UI)
 * is re-created from the durable submission and content, as recovery writes it.
 * Attachments shown in the web view are not restored; the JMAP Email projects
 * from the content row and is complete.
 */
export async function ensureSubmissionSentRow(
  db: Db,
  submission: typeof jmapSubmissions.$inferSelect,
  now: number,
): Promise<boolean> {
  const [existing] = await db
    .select({ id: sentEmails.id })
    .from(sentEmails)
    .where(eq(sentEmails.id, submission.sentEmailId))
    .limit(1);
  if (existing) return true;
  if (submission.attemptState === "scheduled") {
    // A delayed send whose Sent message was deleted before it went out is
    // canceled, never re-created: re-creating it would send it after all. The
    // draft stays a draft (settleDeletedScheduled).
    return false;
  }
  const [outbox] = await db
    .select({
      status: outboxEmails.status,
      deliveredMessageId: outboxEmails.deliveredMessageId,
    })
    .from(outboxEmails)
    .where(eq(outboxEmails.sentEmailId, submission.sentEmailId))
    .limit(1);
  console.warn(
    `[jmap] Sent row ${submission.sentEmailId} of submission ${submission.id} was missing; re-creating it`,
  );
  // A release in progress with no outbox row yet hasn't sent anything.
  const status =
    outbox?.status === "pending"
      ? "retrying"
      : submission.attemptState === "releasing" && !outbox
        ? "scheduled"
        : "sent";
  await writeSentRow(
    db,
    submission,
    status,
    now,
    outbox?.deliveredMessageId ?? null,
  );
  return true;
}
