// The Sent row of a JMAP submission, written identically by the request path
// (spec §3.4 step 3) and by recovery (spec §3.4 table row 1/2): the same person
// row and conversation id the web composer computes, plus the content link and
// the Message-ID the message was delivered with.
import { and, eq } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { attachments } from "../db/attachments.schema";
import { sentEmails } from "../db/sent-emails.schema";
import type { SendEmailResult } from "../lib/email-sender";
import { deliveredMessageId } from "../lib/message-id";
import {
  findOrCreatePersonId,
  outboundConversationId,
} from "../lib/sent-bookkeeping";
import type { SubmissionMessage } from "../lib/submit-message";
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
async function withInlineAttachmentUrls(
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
