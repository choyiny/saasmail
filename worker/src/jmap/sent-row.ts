// The Sent row of a JMAP submission, written identically by the request path
// (spec §3.4 step 3) and by recovery (spec §3.4 table row 1/2): the same person
// row and conversation id the web composer computes, plus the content link and
// the exact Message-ID the message went out with.
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { sentEmails } from "../db/sent-emails.schema";
import {
  findOrCreatePersonId,
  outboundConversationId,
} from "../lib/sent-bookkeeping";
import {
  parseContentJson,
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
    now: number;
  },
): Promise<typeof sentEmails.$inferInsert> {
  const { content, message, now } = input;
  const inReplyTo = parseContentJson<string[] | null>(
    content.inReplyToJson,
    null,
  );
  return {
    id: input.sentEmailId,
    personId: await findOrCreatePersonId(db, message.to, now),
    fromAddress: message.fromAddress,
    toAddress: message.to,
    subject: message.subject,
    bodyHtml: message.html || null,
    bodyText: message.text ?? null,
    inReplyTo:
      inReplyTo && inReplyTo.length > 0
        ? `<${inReplyTo[0].replace(/^<|>$/g, "")}>`
        : null,
    messageId: message.headers["Message-ID"],
    resendId: input.resendId ?? null,
    status: input.status,
    cc: message.cc.length > 0 ? JSON.stringify(message.cc) : null,
    conversationId: await outboundConversationId(
      db,
      message.fromAddress,
      message.to,
      message.cc.map((cc) => cc.email),
    ),
    jmapContentId: content.id,
    sentAt: now,
    createdAt: now,
  };
}
