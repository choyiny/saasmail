import { nanoid } from "nanoid";
import { and, eq, lte, sql } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { drizzle } from "drizzle-orm/d1";
import { outboxEmails } from "../db/outbox-emails.schema";
import { sentEmails } from "../db/sent-emails.schema";
import { sequenceEmails } from "../db/sequence-emails.schema";
import { attachments } from "../db/attachments.schema";
import { schema } from "../db/schema";
import type { EmailSender, SendEmailAttachment } from "./email-sender";
import { createEmailSender } from "./email-sender";
import {
  sendWithSuppressionCheck,
  type CcRecipient,
  type SendOutput,
} from "./send";
import { formatFromAddress } from "./format-from-address";
import { isDemoMode } from "./is-dev";
import { completeEnrollmentIfDone } from "./enrollment-completion";

/** Total provider attempts before a transient failure becomes terminal.
 *  With the hourly cron this is ~24h — enough to ride out Cloudflare's
 *  daily send-quota reset. */
export const MAX_OUTBOX_ATTEMPTS = 24;

/** Caps one cron tick's work; anything beyond drains on subsequent ticks. */
const OUTBOX_BATCH_LIMIT = 200;

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
    // The row must not be claimable while the inline attempt is in flight.
    // On a transient failure the resolution below resets it to "due now", and a
    // hard crash mid-attempt self-heals at the next hourly run (same cool-down
    // semantics as the processor's claim).
    nextRetryAt: now + 3600,
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
    // Stays pending; due at the next hourly run (after + 60: the 60-second cool-down
    // covers the caller's post-return bookkeeping — specifically the sent_emails insert
    // that happens after sendViaOutbox returns. Without this gap, a concurrent
    // cron/manual claim that resolves successfully could update a nonexistent
    // sent_emails row and delete the outbox row, leaving the caller's subsequent
    // "retrying" sent_emails row permanently stuck).
    await db
      .update(outboxEmails)
      .set({
        attempts: 1,
        lastError: result.error.message,
        nextRetryAt: after + 60,
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

/**
 * Cron entry point: re-attempt every due pending outbox row. Called from
 * the hourly `scheduled()` handler after sequence dispatch.
 */
export async function processOutbox(env: CloudflareBindings): Promise<void> {
  if (isDemoMode(env)) return;
  const db = drizzle(env.DB, { schema }) as unknown as Db;
  const sender = createEmailSender(env);
  const now = Math.floor(Date.now() / 1000);

  const due = await db
    .select({ id: outboxEmails.id })
    .from(outboxEmails)
    .where(
      and(
        eq(outboxEmails.status, "pending"),
        lte(outboxEmails.nextRetryAt, now),
      ),
    )
    .limit(OUTBOX_BATCH_LIMIT);
  if (due.length === 0) return;

  let claimed = 0;
  for (const row of due) {
    try {
      const result = await attemptOutboxRow(db, env, sender, row.id);
      if (result !== null) claimed++;
    } catch (err) {
      // A crashed attempt leaves the row pending with next_retry_at an hour
      // out (set by the claim), so it self-heals on a later run.
      console.error(`[outbox] retry attempt crashed for ${row.id}:`, err);
    }
  }
  console.log(`[outbox] processed ${claimed}/${due.length} due rows`);
}

/**
 * Claim and re-attempt a single outbox row. Returns the resolution, or
 * null when the row couldn't be claimed (already resolved, status
 * `failed`, or not due — e.g. a concurrent processor got there first).
 *
 * The claim is a conditional UPDATE that bumps `attempts` and pushes
 * `next_retry_at` an hour out; a concurrent claimant fails the
 * `next_retry_at <= now` condition, so a cron run racing a manual retry
 * can't double-send.
 */
export async function attemptOutboxRow(
  db: Db,
  env: CloudflareBindings,
  sender: EmailSender,
  id: string,
): Promise<OutboxOutcome | null> {
  const now = Math.floor(Date.now() / 1000);
  const claimed = await db
    .update(outboxEmails)
    .set({
      attempts: sql`${outboxEmails.attempts} + 1`,
      nextRetryAt: now + 3600,
      updatedAt: now,
    })
    .where(
      and(
        eq(outboxEmails.id, id),
        eq(outboxEmails.status, "pending"),
        lte(outboxEmails.nextRetryAt, now),
      ),
    )
    .returning();
  if (claimed.length === 0) return null;
  const row = claimed[0];

  const from = await formatFromAddress(db, row.fromAddress);
  const storedAttachments = await loadOutboxAttachments(
    db,
    env,
    row.sentEmailId,
  );

  const send = await sendWithSuppressionCheck({
    db,
    env,
    sender,
    from,
    to: row.toAddress,
    cc: row.cc ? (JSON.parse(row.cc) as CcRecipient[]) : undefined,
    subject: row.subject,
    html: row.bodyHtml ?? undefined,
    text: row.bodyText ?? undefined,
    headers: row.headers
      ? (JSON.parse(row.headers) as Record<string, string>)
      : undefined,
    attachments: storedAttachments.length > 0 ? storedAttachments : undefined,
    transactional: row.transactional === 1,
  });

  const after = Math.floor(Date.now() / 1000);

  if (send.delivered.length === 0) {
    // Mid-retry suppression: the recipient was added to the suppression list between
    // a previous attempt and this one. Terminal — delete the outbox row and don't retry.
    // sent_emails is set to "failed" (not "suppressed") because a transport was already
    // attempted on the initial inline call; "failed" is the only terminal sent-status
    // that doesn't render the message as delivered. The step-level "suppressed" below
    // preserves the precise reason for sequence reporting.
    await db.delete(outboxEmails).where(eq(outboxEmails.id, row.id));
    await db
      .update(sentEmails)
      .set({ status: "failed" })
      .where(eq(sentEmails.id, row.sentEmailId));
    if (row.sequenceEmailId) {
      await resolveSequenceStep(db, row.sequenceEmailId, "suppressed", null);
    }
    return "suppressed";
  }

  const result = send.result!;
  if (!result.error) {
    await db
      .update(sentEmails)
      .set({ status: "sent", resendId: result.id, sentAt: after })
      .where(eq(sentEmails.id, row.sentEmailId));
    if (row.sequenceEmailId) {
      await resolveSequenceStep(
        db,
        row.sequenceEmailId,
        "sent",
        row.sentEmailId,
      );
    }
    await db.delete(outboxEmails).where(eq(outboxEmails.id, row.id));
    return "sent";
  }

  if (result.error.transient && row.attempts < MAX_OUTBOX_ATTEMPTS) {
    // Due again immediately — i.e. at the next hourly run.
    await db
      .update(outboxEmails)
      .set({
        lastError: result.error.message,
        nextRetryAt: after,
        updatedAt: after,
      })
      .where(eq(outboxEmails.id, row.id));
    // No-op on the normal cron path (already retrying); matters when a manual
    // retry revives a terminally failed row — flip the UI status back to
    // "retrying" so the thread and outbox stay in sync.
    await db
      .update(sentEmails)
      .set({ status: "retrying" })
      .where(eq(sentEmails.id, row.sentEmailId));
    if (row.sequenceEmailId) {
      await db
        .update(sequenceEmails)
        .set({ status: "retrying" })
        .where(eq(sequenceEmails.id, row.sequenceEmailId));
    }
    return "retrying";
  }

  // Permanent reject, or the attempt budget is spent.
  await db
    .update(outboxEmails)
    .set({
      status: "failed",
      lastError: result.error.message,
      updatedAt: after,
    })
    .where(eq(outboxEmails.id, row.id));
  await db
    .update(sentEmails)
    .set({ status: "failed" })
    .where(eq(sentEmails.id, row.sentEmailId));
  if (row.sequenceEmailId) {
    await resolveSequenceStep(db, row.sequenceEmailId, "failed", null);
  }
  return "failed";
}

/** Flip a sequence step to its terminal status and re-check the enrollment. */
export async function resolveSequenceStep(
  db: Db,
  sequenceEmailId: string,
  status: "sent" | "failed" | "suppressed",
  sentEmailId: string | null,
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  await db
    .update(sequenceEmails)
    .set({
      status,
      ...(status === "sent" ? { sentAt: now, sentEmailId } : {}),
    })
    .where(eq(sequenceEmails.id, sequenceEmailId));

  const rows = await db
    .select({ enrollmentId: sequenceEmails.enrollmentId })
    .from(sequenceEmails)
    .where(eq(sequenceEmails.id, sequenceEmailId))
    .limit(1);
  if (rows[0]) {
    await completeEnrollmentIfDone(db, rows[0].enrollmentId);
  }
}

/** Reload persisted attachments (R2 bytes) for a retry attempt. */
async function loadOutboxAttachments(
  db: Db,
  env: CloudflareBindings,
  sentEmailId: string,
): Promise<SendEmailAttachment[]> {
  const rows = await db
    .select()
    .from(attachments)
    .where(
      and(eq(attachments.emailId, sentEmailId), eq(attachments.kind, "sent")),
    );
  const out: SendEmailAttachment[] = [];
  for (const a of rows) {
    const obj = await env.R2.get(a.r2Key);
    if (!obj) {
      console.error(
        `[outbox] missing R2 object ${a.r2Key} for sent email ${sentEmailId}`,
      );
      continue;
    }
    out.push({
      filename: a.filename,
      contentType: a.contentType,
      content: await obj.arrayBuffer(),
    });
  }
  return out;
}
