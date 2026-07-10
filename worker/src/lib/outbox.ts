import { nanoid } from "nanoid";
import { eq } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { outboxEmails } from "../db/outbox-emails.schema";
import type { EmailSender, SendEmailAttachment } from "./email-sender";
import {
  sendWithSuppressionCheck,
  type CcRecipient,
  type SendOutput,
} from "./send";

/** Total provider attempts before a transient failure becomes terminal.
 *  With the hourly cron this is ~24h — enough to ride out Cloudflare's
 *  daily send-quota reset. */
export const MAX_OUTBOX_ATTEMPTS = 24;

export type OutboxOutcome = "sent" | "suppressed" | "retrying" | "failed";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = DrizzleD1Database<any>;

export interface OutboxSendParams {
  db: Db;
  env: CloudflareBindings;
  sender: EmailSender;
  /** Pre-generated id of the sent_emails row the caller will write. */
  sentEmailId: string;
  /** Set for sequence-step sends. */
  sequenceEmailId?: string | null;
  /** Bare lowercase inbox address (scoping key; re-formatted on retry). */
  fromAddress: string;
  /** Formatted "Name <addr>" for the wire. */
  from: string;
  to: string;
  cc?: CcRecipient[];
  subject: string;
  html?: string;
  text?: string;
  headers?: Record<string, string>;
  attachments?: SendEmailAttachment[];
  transactional?: boolean;
}

export interface OutboxSendResult {
  outcome: OutboxOutcome;
  send: SendOutput;
}

/**
 * Write-ahead send: insert an outbox row, attempt the provider call inline,
 * then resolve the row — deleted on success/suppression, kept `pending` for
 * the hourly retry processor on a transient failure, kept `failed` on a
 * terminal one. Callers write their sent_emails row from `outcome`.
 */
export async function sendViaOutbox(
  params: OutboxSendParams,
): Promise<OutboxSendResult> {
  const {
    db,
    env,
    sender,
    sentEmailId,
    sequenceEmailId,
    fromAddress,
    from,
    to,
    cc,
    subject,
    html,
    text,
    headers,
    attachments,
    transactional,
  } = params;
  const now = Math.floor(Date.now() / 1000);
  const outboxId = nanoid();

  await db.insert(outboxEmails).values({
    id: outboxId,
    sentEmailId,
    sequenceEmailId: sequenceEmailId ?? null,
    fromAddress,
    toAddress: to,
    cc: cc && cc.length > 0 ? JSON.stringify(cc) : null,
    subject,
    bodyHtml: html ?? null,
    bodyText: text ?? null,
    headers: headers ? JSON.stringify(headers) : null,
    transactional: transactional === true ? 1 : 0,
    status: "pending",
    attempts: 0,
    nextRetryAt: now,
    createdAt: now,
    updatedAt: now,
  });

  // Wrap in try/catch so that an unexpected throw (e.g. a D1 error during the
  // suppression lookup, or a sender implementation that throws) cleans up the
  // write-ahead row. Without this, the caller's route fails with 500 and never
  // writes its sent_emails row, yet the hourly retry processor would later
  // resend the email — producing a send that is invisible in app history.
  // Deleting the row and rethrowing preserves the pre-outbox failure semantics.
  let send: SendOutput;
  try {
    send = await sendWithSuppressionCheck({
      db,
      env,
      sender,
      from,
      to,
      cc,
      subject,
      html,
      text,
      headers,
      attachments,
      transactional,
    });
  } catch (err) {
    await db.delete(outboxEmails).where(eq(outboxEmails.id, outboxId));
    throw err;
  }

  const after = Math.floor(Date.now() / 1000);

  if (send.delivered.length === 0) {
    // Every recipient suppressed — no transport call happened. Nothing to
    // retry; sent_emails gets no row (matches pre-outbox behavior).
    await db.delete(outboxEmails).where(eq(outboxEmails.id, outboxId));
    return { outcome: "suppressed", send };
  }

  const result = send.result!;
  if (!result.error) {
    await db.delete(outboxEmails).where(eq(outboxEmails.id, outboxId));
    return { outcome: "sent", send };
  }

  if (result.error.transient) {
    // Stays pending; due immediately so the next hourly run picks it up.
    await db
      .update(outboxEmails)
      .set({
        attempts: 1,
        lastError: result.error.message,
        nextRetryAt: after,
        updatedAt: after,
      })
      .where(eq(outboxEmails.id, outboxId));
    return { outcome: "retrying", send };
  }

  await db
    .update(outboxEmails)
    .set({
      status: "failed",
      attempts: 1,
      lastError: result.error.message,
      updatedAt: after,
    })
    .where(eq(outboxEmails.id, outboxId));
  return { outcome: "failed", send };
}
