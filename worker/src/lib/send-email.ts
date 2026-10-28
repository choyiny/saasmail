import {
  citedIdsOf,
  threadKeyForNewMessage,
  threadingModeOf,
} from "./messages/thread-key";
import { currentAuditActor } from "./audit/context";
import { HUMAN_ACTORS, trainMessages } from "./spam/filter";
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
import {
  createSenderForInbox,
  GmailSenderUnavailableError,
} from "./email-sender/for-inbox";
import { GmailSender } from "./email-sender/providers/gmail";
import { senderIdentities } from "../db/sender-identities.schema";
import {
  directSendFailure,
  insertSentRowReplacingEcho,
  notHeldMessage,
  providerIdsOf,
  sendsDirect,
} from "./direct-send";
import { sendWithSuppressionCheck, type SendOutput } from "./send";
import { notifySendAccepted } from "./send-idempotency";
import { isSendingPaused } from "./sending-controls";
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
import type { SendEmailAttachment } from "./email-sender/types";

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
  /** Held in the outbox because outbound sending is paused. */
  paused?: true;
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
  /** Held in the outbox because outbound sending is paused. */
  paused?: true;
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
        | "TEMPLATE_PARSE_ERROR"
        | "SEND_FAILED"
        | "SEND_HELD";
      message: string;
      /**
       * The mailbox may have sent it: the idempotency key keeps this answer,
       * so a retry with the same key does not send again.
       */
      keepIdempotencyKey?: boolean;
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
 * The sender for mail from `fromAddress`: its Gmail or Outlook mailbox when
 * the inbox is connected to one, else the configured provider. A connected
 * inbox whose mailbox cannot produce a token fails closed, with the message to
 * show.
 */
async function senderForInbox(
  db: Db,
  env: CloudflareBindings,
  fromAddress: string,
): Promise<{ sender: EmailSender | null; failure: string | null }> {
  try {
    return {
      sender: await createSenderForInbox(db, env, fromAddress),
      failure: null,
    };
  } catch (err) {
    if (!(err instanceof GmailSenderUnavailableError)) throw err;
    const which = err.provider === "outlook" ? "Microsoft" : "Google";
    return {
      sender: null,
      failure:
        `saasmail could not reach the ${which} mailbox behind ${fromAddress}, ` +
        "so this message was not sent and was not queued for retry. Send it " +
        "again in a moment; if it keeps failing, reconnect this mailbox " +
        "on the Inboxes page.",
    };
  }
}

/** The error's name for a log line: its message may carry bound values. */
function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

/** Discards a reply's staged attachments; a failure is logged, never thrown. */
async function discardStagedBestEffort(
  db: Db,
  env: CloudflareBindings,
  sentEmailId: string,
): Promise<void> {
  try {
    await discardSentAttachments(db, env, sentEmailId);
  } catch (error) {
    console.error(
      `[send] staged attachments of ${sentEmailId} kept: ${errorName(error)}`,
    );
  }
}

/**
 * One send through a Gmail or Outlook mailbox: no outbox row, so nothing is
 * retried later through another transport. Null `failure` when it went out
 * (or every recipient was suppressed); the key is completed at once.
 */
async function sendThroughMailbox(input: {
  db: Db;
  env: CloudflareBindings;
  sender: EmailSender;
  sentEmailId: string;
  from: string;
  to: string;
  cc?: { email: string; name: string | null }[];
  subject: string;
  html: string;
  text?: string;
  headers: Record<string, string>;
  attachments?: SendEmailAttachment[];
  transactional?: boolean;
  threadId?: string | null;
}): Promise<{
  send: SendOutput;
  failure: { message: string; uncertain: boolean } | null;
}> {
  // Whether the provider was called: a throw after that may hide a send.
  let requested = false;
  const tracked: EmailSender = Object.create(input.sender);
  tracked.send = (params) => {
    requested = true;
    return input.sender.send(params);
  };
  let send: SendOutput;
  try {
    send = await sendWithSuppressionCheck({
      db: input.db,
      env: input.env,
      sender: tracked,
      from: input.from,
      to: input.to,
      cc: input.cc,
      subject: input.subject,
      html: input.html,
      ...(input.text !== undefined ? { text: input.text } : {}),
      headers: input.headers,
      ...(input.attachments ? { attachments: input.attachments } : {}),
      ...(input.threadId ? { threadId: input.threadId } : {}),
      transactional: input.transactional,
    });
  } catch (error) {
    if (!requested) throw error;
    console.error(
      `[send] ${input.sender.provider} send ${input.sentEmailId} threw after its request: ${errorName(error)}`,
    );
    return {
      send: { delivered: [], suppressed: [] },
      failure: directSendFailure(input.sender, {
        id: null,
        error: {
          message: "the request failed before its answer was read",
          transient: true,
          uncertain: true,
        },
      })!,
    };
  }
  if (send.delivered.length === 0) return { send, failure: null };
  const failure = directSendFailure(input.sender, send.result!);
  if (!failure) {
    await notifySendAccepted({
      sentEmailId: input.sentEmailId,
      outcome: "sent",
    });
  }
  return { send, failure };
}

/**
 * The parent's Gmail thread id, but only when it means something to the
 * mailbox this reply is going out from.
 *
 * Gmail thread ids are per-MAILBOX. With two connected mailboxes, replying
 * from inbox A to a message synced into inbox B would hand B's thread id to
 * A's `users/me/messages/send`; Gmail answers 400, and a Gmail failure is
 * never queued, so the reply would fail identically on every resend.
 * Dropping the id costs the threading; refusing to send costs the reply.
 *
 * A remap is settled elsewhere: `clearGmailThreadIds` erases an inbox's
 * stored ids when its mapping changes, so what survives here is an id the
 * currently mapped account issued.
 */
async function threadIdForSender(
  db: Db,
  sender: EmailSender,
  fromAddress: string,
  origInbox: string,
  origGmailThreadId: string | null,
): Promise<string | null> {
  if (!origGmailThreadId || !(sender instanceof GmailSender)) return null;

  const [parentIdentity] = await db
    .select({ gmailAccountId: senderIdentities.gmailAccountId })
    .from(senderIdentities)
    .where(eq(senderIdentities.email, origInbox))
    .limit(1);
  if (
    parentIdentity?.gmailAccountId &&
    parentIdentity.gmailAccountId === sender.accountId
  ) {
    return origGmailThreadId;
  }

  console.warn(
    `[replyToEmail] the parent message's Gmail thread belongs to ${origInbox}, not to the Gmail account behind ${fromAddress}; sending this reply as a new thread rather than letting Gmail reject it.`,
  );
  return null;
}

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
  const storedMessageId = deliveredMessageId(messageId, sendResult.result);
  // A new message starts its own thread in a headers-mode inbox.
  const threadKey = await threadKeyForNewMessage(db, {
    inbox: fromAddress,
    messageId: storedMessageId,
  });

  await db.insert(sentEmails).values({
    id,
    personId,
    fromAddress,
    toAddress: recordedTo,
    subject,
    bodyHtml: sendResult.renderedHtml ?? bodyHtml,
    bodyText: sendResult.renderedText ?? bodyText ?? null,
    messageId: storedMessageId,
    resendId: sendResult.result?.id ?? null,
    status: outcome,
    cc: cc && cc.length > 0 ? JSON.stringify(cc) : null,
    conversationId,
    threadKey,
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
    ...(sendResult.result?.error?.paused ? { paused: true as const } : {}),
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

  // Resolved after fromAddress is canonicalized: sender_identities.email is
  // stored lowercased, so an earlier lookup would miss the mapping.
  let sender = params.sender ?? null;
  if (!sender) {
    const resolved = await senderForInbox(db, env, fromAddress);
    if (resolved.failure) {
      return { ok: false, code: "SEND_FAILED", message: resolved.failure };
    }
    sender = resolved.sender!;
  }
  const direct = sendsDirect(sender);
  if (direct && (await isSendingPaused(db))) {
    return {
      ok: false,
      code: "SEND_HELD",
      message: notHeldMessage(sender, "Outbound sending is paused"),
    };
  }

  // Resolve the original across both received and sent tables.
  const receivedRow = await db
    .select()
    .from(emails)
    .where(eq(emails.id, emailId))
    .limit(1);

  let origPersonId: string;
  let origSubject: string | null;
  let origInReplyToMessageId: string | null;
  // The original's inbox and thread, for a reply in a headers-mode inbox.
  let origInbox: string;
  let origThreadKey: string | null;
  // The parent's Gmail thread, when it has one: passed as `threadId` so a
  // reply through Gmail lands inside the same Gmail conversation.
  let origGmailThreadId: string | null;
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
    origInbox = orig.recipient;
    origThreadKey = orig.threadKey ?? null;
    origGmailThreadId = orig.gmailThreadId ?? null;
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
    origInbox = orig.fromAddress;
    origThreadKey = orig.threadKey ?? null;
    origGmailThreadId = orig.gmailThreadId ?? null;
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
  const replyHeaders = {
    ...(params.extraHeaders ?? {}),
    "Message-ID": messageId,
    ...(origInReplyToMessageId
      ? {
          "In-Reply-To": origInReplyToMessageId,
          References: origInReplyToMessageId,
        }
      : {}),
    ...(replyTo ? { "Reply-To": replyTo } : {}),
  };
  const replyAttachments =
    files.length > 0
      ? files.map((f) => ({
          filename: f.filename,
          contentType: f.contentType,
          content: f.bytes,
        }))
      : undefined;
  let outcome: OutboxOutcome;
  let sendResult: Awaited<ReturnType<typeof sendViaOutbox>>["send"];
  if (direct) {
    // Through the connected mailbox, never queued: a retry by the outbox
    // would go out through the configured provider under another identity.
    const gmailThreadId = await threadIdForSender(
      db,
      sender,
      fromAddress,
      origInbox.trim().toLowerCase(),
      origGmailThreadId,
    );
    let failure: { message: string; uncertain: boolean } | null;
    try {
      ({ send: sendResult, failure } = await sendThroughMailbox({
        db,
        env,
        sender,
        sentEmailId: id,
        from: formattedFrom,
        to: toAddress,
        cc,
        subject: finalSubject,
        html: finalBodyHtml,
        ...(bodyText !== undefined ? { text: bodyText } : {}),
        headers: replyHeaders,
        attachments: replyAttachments,
        transactional: true,
        threadId: gmailThreadId,
      }));
    } catch (err) {
      await discardStagedBestEffort(db, env, id);
      throw err;
    }
    if (failure) {
      // Never in the way of the answer: an uncertain one keeps its key.
      await discardStagedBestEffort(db, env, id);
      return {
        ok: false,
        code: "SEND_FAILED",
        message: failure.message,
        ...(failure.uncertain ? { keepIdempotencyKey: true } : {}),
      };
    }
    outcome = "sent";
  } else {
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
        headers: replyHeaders,
        ...(replyAttachments ? { attachments: replyAttachments } : {}),
        transactional: true,
        ...(params.retryOnFailure === undefined
          ? {}
          : { retryOnFailure: params.retryOnFailure }),
      }));
    } catch (err) {
      await discardSentAttachmentsUnlessQueued(db, env, id);
      throw err;
    }
  }

  let stored = false;
  const finish = async (): Promise<ReplyEmailResult> => {
    // Compute conversation_id for this reply.
    const conversationIdReply = await outboundConversationId(
      db,
      fromAddress,
      threadTo,
      threadCc,
    );

    // In a headers-mode inbox, a reply joins the thread of what it answers:
    // the original's own thread when it is in this inbox (even without a
    // Message-ID to cite), else whatever its Message-ID resolves to.
    const storedReplyId = deliveredMessageId(messageId, sendResult.result);
    const replyThreadKey =
      origThreadKey &&
      origInbox.toLowerCase() === fromAddress.toLowerCase() &&
      (await threadingModeOf(db, fromAddress)) === "headers"
        ? origThreadKey
        : await threadKeyForNewMessage(db, {
            inbox: fromAddress,
            messageId: storedReplyId,
            citedIds: citedIdsOf(origInReplyToMessageId, null),
          });

    // Store sent email: a Gmail or Outlook reply's row replaces the Sent copy
    // a sync may already have mirrored (lib/direct-send.ts).
    await insertSentRowReplacingEcho(db, env, sender, {
      id,
      personId: origPersonId,
      fromAddress,
      toAddress,
      subject: finalSubject,
      bodyHtml: finalBodyHtml,
      bodyText: bodyText ?? null,
      inReplyTo: origInReplyToMessageId,
      messageId: storedReplyId,
      resendId: sendResult.result?.id ?? null,
      ...providerIdsOf(sender, sendResult.result),
      status: outcome,
      cc: cc && cc.length > 0 ? JSON.stringify(cc) : null,
      conversationId: conversationIdReply,
      threadKey: replyThreadKey,
      sentAt: now,
      createdAt: now,
    });
    stored = true;

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

    // A person answering a received message says it is not junk: that trains
    // the inbox's learning filter, unless somebody already labelled it (an
    // explicit junk mark wins over a reply). Never a rule, the agent or the
    // system.
    if (receivedRow.length > 0) {
      const actor = currentAuditActor();
      if (HUMAN_ACTORS.has(actor.actorType)) {
        await trainMessages(db, {
          refs: [{ kind: "received", id: emailId }],
          label: "ham",
          userId: actor.actorUserId,
          onlyIfUntrained: true,
        });
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
      ...(sendResult.result?.error?.paused ? { paused: true as const } : {}),
    };
  };
  if (!direct) return finish();
  try {
    return await finish();
  } catch (err) {
    // The mailbox has the message: a throw here must not release the key or
    // the daily slot, or a retry would send it again.
    console.error(
      `[reply] ${sender.provider} reply ${id} sent, bookkeeping failed: ${errorName(err)}`,
    );
    if (!stored) await discardStagedBestEffort(db, env, id);
    return {
      ok: false,
      code: "SEND_FAILED",
      message:
        `${sender.provider === "outlook" ? "Outlook" : "Gmail"} sent this ` +
        "message, but saasmail could not finish recording it" +
        (stored ? "" : ", so it is not in Sent") +
        ". Do not send it again.",
      keepIdempotencyKey: true,
    };
  }
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
