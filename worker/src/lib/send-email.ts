import { and, eq } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { nanoid } from "nanoid";
import { attachments } from "../db/attachments.schema";
import { emailTemplates } from "../db/email-templates.schema";
import { emails } from "../db/emails.schema";
import { people } from "../db/people.schema";
import { senderIdentities } from "../db/sender-identities.schema";
import { sentEmails } from "../db/sent-emails.schema";
import { cancelSequencesForPerson } from "./cancel-sequence";
import { computeConversationId, externalsOnly } from "./conversation-id";
import { createEmailSender } from "./email-sender";
import {
  createSenderForInbox,
  GmailSenderUnavailableError,
} from "./email-sender/for-inbox";
import { GmailSender } from "./email-sender/providers/gmail";
import type { EmailSender } from "./email-sender/types";
import { formatFromAddress } from "./format-from-address";
import { assertInboxAllowed, type AllowedInboxes } from "./inbox-permissions";
import { fetchInternalDomains } from "./internal-domains";
import { renderTemplate, type TemplateVariables } from "./interpolate";
import { generateMessageId } from "./message-id";
import type { ParsedFile } from "./multipart-send";
import { sendViaOutbox, type OutboxOutcome } from "./outbox";
import { sendWithSuppressionCheck, type SendOutput } from "./send";

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

export type ReplyEmailParams = {
  db: Db;
  env: CloudflareBindings;
  emailId: string;
  payload: ReplyEmailPayload;
  files: ParsedFile[];
  allowed: AllowedInboxes;
};

export type ReplyEmailSuccess = {
  ok: true;
  id: string;
  resendId: string | null;
  status: OutboxOutcome;
  attachmentIds: string[];
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
        | "SEND_FAILED";
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
 * The parent's Gmail thread id, but only when it means something to the
 * mailbox this reply is going out from.
 *
 * Gmail thread ids are per-MAILBOX. With two connected mailboxes, replying
 * from inbox A to a message synced into inbox B would hand B's thread id to
 * A's `users/me/messages/send`; Gmail answers 400, which classifies as
 * terminal, and a terminal Gmail failure is deliberately never queued — so
 * the reply becomes an unrecoverable dead end that fails identically on every
 * resend. `fromAddress` is caller-chosen, so this is reachable from the
 * ordinary API, not a contrived setup.
 *
 * Dropping the id costs the threading; refusing to send costs the reply.
 *
 * There is no "same inbox, so necessarily the same account" shortcut, and
 * there used to be. `emails.gmail_thread_id` records whichever account was
 * mapped WHEN THE MESSAGE WAS SYNCED, and an inbox can be remapped afterwards
 * — an operator disconnecting a departed colleague's mailbox and mapping the
 * inbox to a new collector is the documented migration. After it, every
 * pre-migration thread in that inbox carried an id the new account has never
 * seen: Gmail 4xx, terminal, never queued, so the reply 502'd identically on
 * every resend while the UI said to send it again, and the only exit was a
 * manual D1 UPDATE.
 *
 * The lookup below settles the cross-INBOX case. It cannot settle the remap,
 * because after one the parent inbox's current mapping is the new account and
 * nothing records which account issued the stored id — so `clearGmailThreadIds`
 * erases those ids at the moment a mapping changes, and what survives here is
 * an id the currently mapped account issued.
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

async function persistSentAttachments(
  db: Db,
  env: CloudflareBindings,
  sentEmailId: string,
  files: ParsedFile[],
  now: number,
): Promise<string[]> {
  if (files.length === 0) return [];
  const rows = files.map((f) => {
    const attachmentId = nanoid();
    const r2Key = `attachments/sent/${sentEmailId}/${attachmentId}/${f.filename}`;
    return { attachmentId, r2Key, file: f };
  });
  await Promise.all(
    rows.map((r) =>
      env.R2.put(r.r2Key, r.file.bytes, {
        httpMetadata: { contentType: r.file.contentType },
      }),
    ),
  );
  await db.insert(attachments).values(
    rows.map((r) => ({
      id: r.attachmentId,
      emailId: sentEmailId,
      kind: "sent" as const,
      filename: r.file.filename,
      contentType: r.file.contentType,
      size: r.file.size,
      r2Key: r.r2Key,
      contentId: null,
      createdAt: now,
    })),
  );
  return rows.map((r) => r.attachmentId);
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
  const sender = createEmailSender(env);

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
  const { outcome, send: sendResult } = await sendViaOutbox({
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
  });

  // Every recipient was suppressed — no send happened. Skip sent_emails write,
  // but still cancel any pending sequence enrollments for the recipient so we
  // stop scheduling steps that will all individually re-suppress at dispatch.
  if (sendResult.delivered.length === 0) {
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
  const existingPerson = await db
    .select({ id: people.id })
    .from(people)
    .where(eq(people.email, recordedTo))
    .limit(1);

  let personId: string;
  if (existingPerson[0]) {
    personId = existingPerson[0].id;
  } else {
    personId = nanoid();
    await db
      .insert(people)
      .values({
        id: personId,
        email: recordedTo,
        name: null,
        lastEmailAt: now,
        unreadCount: 0,
        totalCount: 0,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing({ target: people.email });
    const refetched = await db
      .select({ id: people.id })
      .from(people)
      .where(eq(people.email, recordedTo))
      .limit(1);
    personId = refetched[0]!.id;
  }

  const internalDomains = await fetchInternalDomains(db);
  const externals = externalsOnly(
    [recordedTo, ...(cc ?? []).map((c) => c.email)],
    internalDomains,
  );
  const conversationId = await computeConversationId(fromAddress, externals);

  await db.insert(sentEmails).values({
    id,
    personId,
    fromAddress,
    toAddress: recordedTo,
    subject,
    bodyHtml: sendResult.renderedHtml ?? bodyHtml,
    bodyText: sendResult.renderedText ?? bodyText ?? null,
    messageId,
    resendId: sendResult.result?.id ?? null,
    status: outcome,
    cc: cc && cc.length > 0 ? JSON.stringify(cc) : null,
    conversationId,
    sentAt: now,
    createdAt: now,
  });

  // Persist attachments even on failure: a retrying/failed send must be able
  // to reload its attachment bytes from R2 on a later attempt.
  const attachmentIds = await persistSentAttachments(db, env, id, files, now);

  await cancelSequencesForPerson(db, personId);

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

  // Same canonicalization story as the send route — lowercase the
  // inbox + recipient + CC emails before downstream use so stored
  // rows match the lowercased conversation_id.
  const fromAddress = raw.fromAddress.trim().toLowerCase();
  const cc = raw.cc?.map((c) => ({
    email: c.email.trim().toLowerCase(),
    name: c.name ?? null,
  }));
  const { bodyHtml, bodyText, templateSlug, variables } = raw;
  const replyTo = raw.replyTo?.trim().toLowerCase();
  assertInboxAllowed(allowed, fromAddress);
  const now = Math.floor(Date.now() / 1000);

  // Resolved AFTER fromAddress is canonicalized: sender_identities.email is
  // stored lowercased, so looking this up before trimming/lowercasing would
  // silently miss the mapping and fall back to the configured provider with
  // no error anywhere.
  //
  // An inbox that is NOT Gmail-mapped still degrades to the configured
  // provider without a word, because that provider is its real transport. An
  // inbox that IS Gmail-mapped and cannot produce a token throws instead, and
  // lands here — because sending it through a different transport is the
  // split identity the Gmail branch below exists to prevent, and answering
  // 201 for a reply the outbox then marks "failed" tells the user it was sent
  // when nothing was. Same outcome as any other failed Gmail reply: 502,
  // nothing queued, the composer keeps the draft.
  let sender: EmailSender;
  try {
    sender = await createSenderForInbox(db, env, fromAddress);
  } catch (err) {
    if (!(err instanceof GmailSenderUnavailableError)) throw err;
    return {
      ok: false,
      code: "SEND_FAILED",
      message:
        `saasmail could not reach the Google mailbox behind ${fromAddress}, ` +
        "so this reply was not sent and was not queued for retry. Send it " +
        "again in a moment; if it keeps failing, reconnect this mailbox " +
        "under Gmail settings.",
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
  let toAddress: string;
  // The parent's Gmail thread, when it has one — Slice 3 stores this on
  // inbound `emails` rows, and this task also starts storing it on `sent_emails`
  // rows below. Passed as `threadId` so the reply lands inside the same Gmail
  // conversation instead of starting a new one; null (e.g. a Cloudflare-sourced
  // parent) means Gmail will assign a fresh thread on send.
  let origGmailThreadId: string | null = null;
  // The inbox the parent message is filed under — where its Gmail thread id,
  // if any, came from. Gmail thread ids are per-mailbox, so this is what says
  // whether that id means anything to the account this reply goes out from.
  let origInbox: string;

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
    origGmailThreadId = orig.gmailThreadId ?? null;
    origInbox = orig.recipient.trim().toLowerCase();
    // Canonicalize the recipient — older rows may be mixed-case.
    toAddress = person[0].email.toLowerCase();
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
    origGmailThreadId = orig.gmailThreadId ?? null;
    origInbox = orig.fromAddress.trim().toLowerCase();
    toAddress = orig.toAddress.toLowerCase();
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

  const messageId = generateMessageId(fromAddress);
  const formattedFrom = await formatFromAddress(db, fromAddress);
  const id = nanoid();
  const replyHeaders = {
    "Message-ID": messageId,
    ...(origInReplyToMessageId
      ? { "In-Reply-To": origInReplyToMessageId }
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

  // Discriminate on the sender that was actually resolved, not on whether
  // fromAddress is Gmail-mapped — createSenderForInbox already falls back to
  // the configured provider on a revoked grant or missing secrets, and that
  // fallback send legitimately IS going out via the configured provider, so
  // it keeps the normal outbox retry below.
  const usingGmail = sender.provider === "gmail";

  let outcome: OutboxOutcome;
  let sendResult: SendOutput;

  const gmailThreadId = await threadIdForSender(
    db,
    sender,
    fromAddress,
    origInbox,
    origGmailThreadId,
  );

  if (usingGmail) {
    // A reply that actually goes out through Gmail must never fall back to
    // the outbox's retry queue: a transient failure there would silently
    // re-attempt via the CONFIGURED provider on the next cron tick —
    // DKIM-signed by the wrong service, invisible in the user's own Gmail
    // Sent folder, and with no Gmail thread to continue. The user decided
    // that surfacing the failure and asking them to press send again is
    // safer than sending from a different identity behind their back, so
    // this calls the transport directly instead of going through
    // sendViaOutbox — nothing is queued.
    sendResult = await sendWithSuppressionCheck({
      db,
      env,
      sender,
      from: formattedFrom,
      to: toAddress,
      cc,
      subject: finalSubject,
      html: finalBodyHtml,
      ...(bodyText !== undefined ? { text: bodyText } : {}),
      headers: replyHeaders,
      ...(replyAttachments ? { attachments: replyAttachments } : {}),
      ...(gmailThreadId ? { threadId: gmailThreadId } : {}),
      // Replies are 1:1 conversational responses to an inbound — the
      // recipient initiated by emailing first — so this bypasses the
      // suppression list and skips the unsubscribe footer / List-Unsubscribe
      // header (this is a reply, not a bulk send), same as the queued path.
      transactional: true,
    });

    const result = sendResult.result!;
    if (result.error) {
      // Not queued anywhere — no outbox row, no sent_emails row. The caller
      // must retry explicitly; nothing is silently in flight.
      return {
        ok: false,
        code: "SEND_FAILED",
        // "Send it again" is the right advice only when sending it again can
        // work. When the mailbox's Google grant is dead, an identical resend
        // fails identically forever, so say what actually has to happen
        // instead of sending the user round a loop.
        message: result.error.reconnect
          ? `${result.error.message} This reply was not sent and was not ` +
            "queued for retry."
          : "Gmail did not accept this reply, and it was not queued for " +
            `retry: ${result.error.message}. Send it again to retry.`,
      };
    }
    outcome = "sent";
  } else {
    // Every other provider keeps its existing queued-and-retried behavior,
    // unchanged: bulk sends, sequences, and a reply that fell back off
    // Gmail all still route through sendViaOutbox.
    const outboxResult = await sendViaOutbox({
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
    });
    outcome = outboxResult.outcome;
    sendResult = outboxResult.send;
  }

  // Compute conversation_id for this reply.
  const internalDomainsReply = await fetchInternalDomains(db);
  const externalsReply = externalsOnly(
    [toAddress, ...(cc ?? []).map((c) => c.email)],
    internalDomainsReply,
  );
  const conversationIdReply = await computeConversationId(
    fromAddress,
    externalsReply,
  );

  // Store sent email.
  //
  // Gmail files a message in the Sent folder the moment it answers 2xx, and
  // its `messagesAdded` history record goes out with it — so a cron tick that
  // lands between that 2xx and this insert sees a Sent message with no
  // `sent_emails` row and mirrors our own reply onto the timeline as if a
  // human had typed it in Gmail. `sent_emails_gmail_message_from_unique` now
  // refuses a second row for the pair, which is what stops two ticks racing
  // each other; it also means THIS insert would be the one to fail if a
  // mirror got in first. The mirror's row is the lossy copy — no attachments,
  // no draft body, no id the caller can be handed back — so the send path
  // clears it and writes its own, and does both in one D1 batch so the mirror
  // cannot slip between the two statements.
  const gmailMessageIdForRow =
    sender.provider === "gmail" ? (sendResult.result?.id ?? null) : null;
  const sentEmailRow = {
    id,
    personId: origPersonId,
    fromAddress,
    toAddress,
    subject: finalSubject,
    bodyHtml: finalBodyHtml,
    bodyText: bodyText ?? null,
    inReplyTo: origInReplyToMessageId,
    messageId,
    resendId: sendResult.result?.id ?? null,
    // Gmail owns these identifiers — only populate them when Gmail was
    // actually the transport used, so a Cloudflare-inbox reply leaves both
    // columns null. A later slice mirrors the Gmail Sent folder onto the
    // timeline and uses gmailMessageId to recognize saasmail's own send and
    // skip it; without it, every reply sent through Gmail would come back
    // through that mirror and appear twice.
    gmailMessageId: gmailMessageIdForRow,
    gmailThreadId:
      sender.provider === "gmail"
        ? (sendResult.result?.threadId ?? null)
        : null,
    status: outcome,
    cc: cc && cc.length > 0 ? JSON.stringify(cc) : null,
    conversationId: conversationIdReply,
    sentAt: now,
    createdAt: now,
  };

  if (gmailMessageIdForRow) {
    await db.batch([
      db
        .delete(sentEmails)
        .where(
          and(
            eq(sentEmails.gmailMessageId, gmailMessageIdForRow),
            eq(sentEmails.fromAddress, fromAddress),
          ),
        ),
      db.insert(sentEmails).values(sentEmailRow),
    ]);
  } else {
    await db.insert(sentEmails).values(sentEmailRow);
  }

  // Persist attachments even on failure: a retrying/failed send must be able
  // to reload its attachment bytes from R2 on a later attempt.
  const attachmentIds = await persistSentAttachments(db, env, id, files, now);

  // Cancel any active sequences for this person
  await cancelSequencesForPerson(db, origPersonId);

  return {
    ok: true,
    id,
    resendId: sendResult.result?.id ?? null,
    status: outcome,
    attachmentIds,
  };
}
