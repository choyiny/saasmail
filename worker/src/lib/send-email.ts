import { auditMailSent } from "./audit/mail-events";
import { and, eq, isNull } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { nanoid } from "nanoid";
import { emailTemplates } from "../db/email-templates.schema";
import { emails } from "../db/emails.schema";
import { people } from "../db/people.schema";
import { sentEmails } from "../db/sent-emails.schema";
import { cancelSequencesForPerson } from "./cancel-sequence";
import { createEmailSender, type EmailSender } from "./email-sender";
import { formatFromAddress } from "./format-from-address";
import { assertInboxAllowed, type AllowedInboxes } from "./inbox-permissions";
import { renderTemplate, type TemplateVariables } from "./interpolate";
import { deliveredMessageId, generateMessageId } from "./message-id";
import { replyToOf } from "./messages/adapters";
import type { MailAddress } from "./messages/types";
import type { ParsedFile } from "./multipart-send";
import { sendViaOutbox, type OutboxOutcome } from "./outbox";
import { ownInboxAddresses, replyCandidates } from "./reply-recipients";
import { MAX_CC_ENTRIES } from "./send-limits";
import {
  fetchInternalDomains,
  findOrCreatePersonId,
  outboundConversationId,
} from "./sent-bookkeeping";
import {
  discardSentAttachments,
  discardSentAttachmentsUnlessQueued,
  stageSentAttachments,
} from "./sent-attachments";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = DrizzleD1Database<any>;

export type SendCcEntry = {
  email: string;
  name?: string | null;
};

export type SendEmailPayload = {
  to: string;
  fromAddress: string;
  cc?: SendCcEntry[];
  subject: string;
  bodyHtml: string;
  bodyText?: string;
  replyTo?: string;
  transactional?: boolean;
};

export type SendEmailParams = {
  db: Db;
  env: CloudflareBindings;
  payload: SendEmailPayload;
  files: ParsedFile[];
  allowed: AllowedInboxes;
  /** Test seam; defaults to the configured provider. */
  sender?: EmailSender;
};

export type SendEmailSuccess = {
  ok: true;
  id: string | null;
  resendId: string | null;
  status: OutboxOutcome;
  attachmentIds: string[];
  delivered: string[];
  suppressed: string[];
};

// The compose path has no recoverable failure mode of its own: multipart
// parse errors are handled before this runs, and a disallowed inbox throws
// (HTTPException). Kept as a discriminated union so callers branch on `ok`
// the same way they do for replies.
export type SendEmailResult = SendEmailSuccess;

export type ReplyEmailPayload = {
  fromAddress: string;
  bodyHtml?: string;
  bodyText?: string;
  cc?: SendCcEntry[];
  templateSlug?: string;
  variables?: TemplateVariables;
  replyTo?: string;
};

/** Who a reply to a received message is addressed to. */
export type ReplyRecipient = "reply_to" | "sender";

export type ReplyEmailParams = {
  db: Db;
  env: CloudflareBindings;
  emailId: string;
  payload: ReplyEmailPayload;
  files: ParsedFile[];
  allowed: AllowedInboxes;
  /**
   * "reply_to" (the default) follows the original's Reply-To header when it
   * names someone other than us; "sender" answers its From whatever the
   * header says. Automatic replies pass "sender": Reply-To is set by whoever
   * wrote the message.
   */
  recipient?: ReplyRecipient;
  /** Internal automation override; HTTP callers never set this. */
  subjectOverride?: string;
  /** Internal headers added to the transport payload. */
  extraHeaders?: Record<string, string>;
  /** Internal policy for one-shot sends that must never enter retry state. */
  retryOnFailure?: boolean;
  /** Test seam for automation sends. */
  sender?: EmailSender;
};

export type ReplyEmailSuccess = {
  ok: true;
  id: string;
  resendId: string | null;
  status: OutboxOutcome;
  attachmentIds: string[];
  /** The address the reply was sent to. */
  to: string;
  /** Every address it was copied to: the caller's Cc plus any Reply-To extras. */
  cc: string[];
  /** Whether that address came from the original's Reply-To or is its sender. */
  repliedTo: ReplyRecipient;
};

export type ReplyEmailFailure =
  | {
      ok: false;
      code:
        | "PERSON_NOT_FOUND"
        | "EMAIL_NOT_FOUND"
        | "EMAIL_HAS_NO_PERSON"
        | "TEMPLATE_NOT_FOUND"
        | "MISSING_BODY"
        | "TEMPLATE_PARSE_ERROR";
      message: string;
    }
  | {
      ok: false;
      code: "MISSING_VARIABLES";
      message: string;
      missingVariables: string[];
      requiredVariables: string[];
    };

export type ReplyEmailResult = ReplyEmailSuccess | ReplyEmailFailure;

/**
 * Compose and send a new email, persisting attachments and the sent_emails
 * row. Callers own multipart parsing and hand over the already-parsed
 * payload plus attachment bytes.
 *
 * Only the inbox permission check throws (HTTPException), matching the
 * routers' existing behavior.
 */
export async function sendEmail(
  params: SendEmailParams,
): Promise<SendEmailResult> {
  const { db, env, payload: raw, files, allowed } = params;
  const sender = params.sender ?? createEmailSender(env);

  const fromAddress = raw.fromAddress.trim().toLowerCase();
  const to = raw.to.trim().toLowerCase();
  const cc = raw.cc?.map((c) => ({
    email: c.email.trim().toLowerCase(),
    name: c.name ?? null,
  }));
  const { subject, bodyHtml, bodyText, transactional } = raw;
  const replyTo = raw.replyTo?.trim().toLowerCase();
  assertInboxAllowed(allowed, fromAddress);
  const now = Math.floor(Date.now() / 1000);

  const messageId = generateMessageId(fromAddress);
  const formattedFrom = await formatFromAddress(db, fromAddress);

  const attachmentList =
    files.length > 0
      ? files.map((f) => ({
          filename: f.filename,
          contentType: f.contentType,
          content: f.bytes,
        }))
      : undefined;

  const id = nanoid();
  // Stage BEFORE the provider call: the outbox retry loader reads these rows,
  // so a crash after the outbox insert must never leave them missing.
  const attachmentIds = await stageSentAttachments(db, env, id, files, now);
  let outcome: OutboxOutcome;
  let sendResult: Awaited<ReturnType<typeof sendViaOutbox>>["send"];
  try {
    ({ outcome, send: sendResult } = await sendViaOutbox({
      db,
      env,
      sender,
      sentEmailId: id,
      fromAddress,
      from: formattedFrom,
      to,
      cc,
      subject,
      html: bodyHtml,
      text: bodyText,
      headers: {
        "Message-ID": messageId,
        ...(replyTo ? { "Reply-To": replyTo } : {}),
      },
      attachments: attachmentList,
      transactional,
    }));
  } catch (err) {
    await discardSentAttachmentsUnlessQueued(db, env, id);
    throw err;
  }

  // Every recipient was suppressed — no send happened. Skip sent_emails write,
  // but still cancel any pending sequence enrollments for the recipient so we
  // stop scheduling steps that will all individually re-suppress at dispatch.
  if (sendResult.delivered.length === 0) {
    // The attachments were staged before suppression was known, so nothing
    // references them now. Drop rows and objects, or every suppressed send
    // with a file would leak storage.
    await discardSentAttachments(db, env, id);

    const existingPerson = await db
      .select({ id: people.id })
      .from(people)
      .where(eq(people.email, to))
      .limit(1);
    if (existingPerson[0]) {
      await cancelSequencesForPerson(db, existingPerson[0].id);
    }

    console.log(
      "[send] all recipients suppressed",
      JSON.stringify({ from: fromAddress, suppressed: sendResult.suppressed }),
    );
    return {
      ok: true,
      id: null,
      resendId: null,
      status: "suppressed",
      attachmentIds: [],
      delivered: [],
      suppressed: sendResult.suppressed,
    };
  }

  // The transport was called; reflect its result in sent_emails.
  // When the primary `to` was suppressed, the helper promoted a surviving cc
  // to be the actual primary recipient. Use that for audit + person lookup so
  // the row reflects who actually got the email.
  const recordedTo = sendResult.delivered[0];

  // Find or create the person row for the actual recipient.
  const personId = await findOrCreatePersonId(db, recordedTo, now);

  const conversationId = await outboundConversationId(
    db,
    fromAddress,
    recordedTo,
    (cc ?? []).map((c) => c.email),
  );

  await db.insert(sentEmails).values({
    id,
    personId,
    fromAddress,
    toAddress: recordedTo,
    subject,
    bodyHtml: sendResult.renderedHtml ?? bodyHtml,
    bodyText: sendResult.renderedText ?? bodyText ?? null,
    messageId: deliveredMessageId(messageId, sendResult.result),
    resendId: sendResult.result?.id ?? null,
    status: outcome,
    cc: cc && cc.length > 0 ? JSON.stringify(cc) : null,
    conversationId,
    sentAt: now,
    createdAt: now,
  });

  // Attachments were staged above, before the provider call, so a retrying or
  // failed send can always reload its attachment bytes on a later attempt.

  await cancelSequencesForPerson(db, personId);
  await auditMailSent(db, {
    id,
    from: fromAddress,
    to: recordedTo,
    otherRecipients: sendResult.delivered.length - 1,
    subject,
    status: outcome,
  });

  return {
    ok: true,
    id,
    resendId: sendResult.result?.id ?? null,
    status: outcome,
    attachmentIds,
    delivered: sendResult.delivered,
    suppressed: sendResult.suppressed,
  };
}

/**
 * Reply to an existing email — resolved across both the received and sent
 * tables — threading the reply via In-Reply-To.
 *
 * Failure modes callers must surface are returned rather than thrown so this
 * can back both the HTTP route and the MCP tool; only the inbox permission
 * check throws (HTTPException), matching the routers' existing behavior.
 */
export async function replyToEmail(
  params: ReplyEmailParams,
): Promise<ReplyEmailResult> {
  const { db, env, emailId, payload: raw, files, allowed } = params;
  const sender = params.sender ?? createEmailSender(env);

  // Same canonicalization story as the send route — lowercase the
  // inbox + recipient + CC emails before downstream use so stored
  // rows match the lowercased conversation_id.
  const fromAddress = raw.fromAddress.trim().toLowerCase();
  let cc = raw.cc?.map((c) => ({
    email: c.email.trim().toLowerCase(),
    name: c.name ?? null,
  }));
  const { bodyHtml, bodyText, templateSlug, variables } = raw;
  const replyTo = raw.replyTo?.trim().toLowerCase();
  assertInboxAllowed(allowed, fromAddress);
  const now = Math.floor(Date.now() / 1000);

  // Resolve the original across both received and sent tables.
  const receivedRow = await db
    .select()
    .from(emails)
    .where(eq(emails.id, emailId))
    .limit(1);

  let origPersonId: string;
  let origSubject: string | null;
  let origInReplyToMessageId: string | null;
  let toAddress: string;
  // Who the conversation is with. It stays the original's correspondent and
  // the caller's Cc even when the reply is delivered to a Reply-To address,
  // so the reply shows up in the thread it was written in.
  let threadTo: string;
  const threadCc = (cc ?? []).map((c) => c.email);
  let repliedTo: ReplyRecipient = "sender";
  // A Reply-To list read from raw_headers, to store on the row afterwards.
  let replyToBackfill: MailAddress[] | null = null;

  if (receivedRow.length > 0) {
    const orig = receivedRow[0];
    // Mirror of the sent-row check below: only allow replies to messages
    // delivered to an inbox the caller still owns. Without this a scoped user
    // could thread a reply into a conversation they cannot read.
    assertInboxAllowed(allowed, orig.recipient);
    const person = await db
      .select({ email: people.email })
      .from(people)
      .where(eq(people.id, orig.personId))
      .limit(1);
    if (person.length === 0) {
      return {
        ok: false,
        code: "PERSON_NOT_FOUND",
        message: "Person not found",
      };
    }
    origPersonId = orig.personId;
    origSubject = orig.subject ?? null;
    origInReplyToMessageId = orig.messageId ?? null;
    // Canonicalize the recipient — older rows may be mixed-case.
    toAddress = person[0].email.toLowerCase();
    threadTo = toAddress;

    if (params.recipient !== "sender") {
      const requested = replyToOf(orig);
      if (requested.length > 0) {
        // Never answer one of our own inboxes, or the one this reply is
        // from: a Reply-To that points back at us would have us mail
        // ourselves.
        const candidates = replyCandidates(
          requested,
          await ownInboxAddresses(db),
          fromAddress,
        );
        if (candidates.length > 0) {
          toAddress = candidates[0].email.trim().toLowerCase();
          repliedTo = "reply_to";
          cc = withReplyToCc(cc, candidates.slice(1), toAddress);
        }
        if (orig.replyTo === null) replyToBackfill = requested;
      }
    }
  } else {
    const sentRow = await db
      .select()
      .from(sentEmails)
      .where(eq(sentEmails.id, emailId))
      .limit(1);
    if (sentRow.length === 0) {
      return { ok: false, code: "EMAIL_NOT_FOUND", message: "Email not found" };
    }
    const orig = sentRow[0];
    // Defense-in-depth: only allow replies to sent rows whose original
    // fromAddress the caller still owns. Prevents a user from threading a
    // reply to another user's outgoing message via its id.
    assertInboxAllowed(allowed, orig.fromAddress);
    if (!orig.personId) {
      return {
        ok: false,
        code: "EMAIL_HAS_NO_PERSON",
        message: "Email has no associated person",
      };
    }
    origPersonId = orig.personId;
    origSubject = orig.subject ?? null;
    origInReplyToMessageId = orig.messageId ?? null;
    toAddress = orig.toAddress.toLowerCase();
    threadTo = toAddress;
  }

  // Determine subject and body
  let finalSubject: string;
  let finalBodyHtml: string;

  if (templateSlug) {
    // Template-based reply
    const templateRows = await db
      .select()
      .from(emailTemplates)
      .where(eq(emailTemplates.slug, templateSlug))
      .limit(1);

    if (templateRows.length === 0) {
      return {
        ok: false,
        code: "TEMPLATE_NOT_FOUND",
        message: "Template not found",
      };
    }

    const rendered = renderTemplate(templateRows[0], variables ?? {});
    if (!rendered.ok) {
      if (rendered.parseError) {
        return {
          ok: false,
          code: "TEMPLATE_PARSE_ERROR",
          message: rendered.parseError,
        };
      }
      return {
        ok: false,
        code: "MISSING_VARIABLES",
        message: "Missing required template variables",
        missingVariables: rendered.missingVariables,
        requiredVariables: rendered.requiredVariables,
      };
    }

    finalSubject = rendered.subject;
    finalBodyHtml = rendered.bodyHtml;
  } else if (bodyHtml) {
    // Freeform reply
    finalSubject = origSubject?.startsWith("Re: ")
      ? origSubject
      : `Re: ${origSubject || ""}`;
    finalBodyHtml = bodyHtml;
  } else {
    return {
      ok: false,
      code: "MISSING_BODY",
      message: "Either bodyHtml or templateSlug is required",
    };
  }

  if (params.subjectOverride !== undefined) {
    finalSubject = params.subjectOverride.replace(/[\r\n]+/g, " ");
  }

  const messageId = generateMessageId(fromAddress);
  const formattedFrom = await formatFromAddress(db, fromAddress);
  // Replies are 1:1 conversational responses to an inbound — the recipient
  // initiated by emailing first, so route through sendViaOutbox
  // with transactional: true. That bypasses the suppression list AND skips
  // the unsubscribe footer / List-Unsubscribe header (this is a reply, not
  // a bulk send).
  const id = nanoid();
  // Same ordering rule as compose: stage before the provider call so an outbox
  // retry after a crash still resends the files.
  const attachmentIds = await stageSentAttachments(db, env, id, files, now);
  let outcome: OutboxOutcome;
  let sendResult: Awaited<ReturnType<typeof sendViaOutbox>>["send"];
  try {
    ({ outcome, send: sendResult } = await sendViaOutbox({
      db,
      env,
      sender,
      sentEmailId: id,
      fromAddress,
      from: formattedFrom,
      to: toAddress,
      cc,
      subject: finalSubject,
      html: finalBodyHtml,
      ...(bodyText !== undefined ? { text: bodyText } : {}),
      headers: {
        ...(params.extraHeaders ?? {}),
        "Message-ID": messageId,
        ...(origInReplyToMessageId
          ? {
              "In-Reply-To": origInReplyToMessageId,
              References: origInReplyToMessageId,
            }
          : {}),
        ...(replyTo ? { "Reply-To": replyTo } : {}),
      },
      ...(files.length > 0
        ? {
            attachments: files.map((f) => ({
              filename: f.filename,
              contentType: f.contentType,
              content: f.bytes,
            })),
          }
        : {}),
      transactional: true,
      ...(params.retryOnFailure === undefined
        ? {}
        : { retryOnFailure: params.retryOnFailure }),
    }));
  } catch (err) {
    await discardSentAttachmentsUnlessQueued(db, env, id);
    throw err;
  }

  // Compute conversation_id for this reply.
  const conversationIdReply = await outboundConversationId(
    db,
    fromAddress,
    threadTo,
    threadCc,
  );

  // Store sent email
  await db.insert(sentEmails).values({
    id,
    personId: origPersonId,
    fromAddress,
    toAddress,
    subject: finalSubject,
    bodyHtml: finalBodyHtml,
    bodyText: bodyText ?? null,
    inReplyTo: origInReplyToMessageId,
    messageId: deliveredMessageId(messageId, sendResult.result),
    resendId: sendResult.result?.id ?? null,
    status: outcome,
    cc: cc && cc.length > 0 ? JSON.stringify(cc) : null,
    conversationId: conversationIdReply,
    sentAt: now,
    createdAt: now,
  });

  // Attachments were staged above, before the provider call.
  // Replies are transactional, so they are never suppressed; if a future change
  // adds a suppressed branch here it must call discardSentAttachments too.

  // Cancel any active sequences for this person
  await cancelSequencesForPerson(db, origPersonId);
  await auditMailSent(db, {
    id,
    from: fromAddress,
    to: toAddress,
    otherRecipients: cc?.length ?? 0,
    subject: finalSubject,
    status: outcome,
    templateSlug,
    repliedTo,
  });

  if (replyToBackfill) {
    // Best effort: the next reply and every read then use the column instead
    // of parsing raw_headers again.
    // Only while the row is as it was read: a re-attribution during the send
    // cleared its Reply-To on purpose, and this must not bring it back.
    try {
      await db
        .update(emails)
        .set({ replyTo: JSON.stringify(replyToBackfill) })
        .where(
          and(
            eq(emails.id, emailId),
            isNull(emails.replyTo),
            eq(emails.personId, origPersonId),
          ),
        );
    } catch (err) {
      console.warn(`[reply] Reply-To not stored for ${emailId}:`, err);
    }
  }

  return {
    ok: true,
    id,
    resendId: sendResult.result?.id ?? null,
    status: outcome,
    attachmentIds,
    to: toAddress,
    cc: (cc ?? []).map((entry) => entry.email),
    repliedTo,
  };
}

/**
 * The Cc of a reply whose To is a Reply-To address: the caller's Cc without
 * that address (a reply-all composer may carry it over from the original),
 * plus the Reply-To addresses after the first. Each address once, never the
 * To itself, and never past the Cc limit.
 */
function withReplyToCc(
  cc: { email: string; name: string | null }[] | undefined,
  extra: MailAddress[],
  toAddress: string,
): { email: string; name: string | null }[] | undefined {
  if (!cc && extra.length === 0) return cc;
  const merged = (cc ?? []).filter((entry) => entry.email !== toAddress);
  const seen = new Set([toAddress, ...merged.map((entry) => entry.email)]);
  for (const entry of extra) {
    if (merged.length >= MAX_CC_ENTRIES) break;
    const email = entry.email.trim().toLowerCase();
    if (seen.has(email)) continue;
    seen.add(email);
    merged.push({ email, name: entry.name ?? null });
  }
  return merged;
}
