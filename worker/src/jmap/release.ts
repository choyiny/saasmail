// Delayed send (delayed-send spec D2): a `scheduled` submission waits for its
// release, which is the only thing that sends it. The release and a cancel race
// on the same row: each is one conditional UPDATE, so exactly one of them wins
// while the submission is `scheduled`. After the release's claim a cancel gets
// `cannotUnsend`; undoStatus stays `pending` until the provider accepted the
// message or the outbox owns its retries, and only then becomes `final`.
import { isSendingPaused } from "../lib/sending-controls";
import { currentAuditActor, runWithAudit } from "../lib/audit/context";
import { auditMailSent } from "../lib/audit/mail-events";
import { and, eq, lt, lte, sql } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { nanoid } from "nanoid";
import { users } from "../db/auth.schema";
import { jmapMessageContent } from "../db/jmap-message-content.schema";
import { jmapSubmissions } from "../db/jmap-submissions.schema";
import { outboxEmails } from "../db/outbox-emails.schema";
import { sentEmails } from "../db/sent-emails.schema";
import { createDb } from "../db/client";
import { cancelSequencesForPerson } from "../lib/cancel-sequence";
import {
  createEmailSender,
  type EmailSender,
  type SendEmailAttachment,
} from "../lib/email-sender";
import { resolveAllowedInboxes } from "../lib/inbox-permissions";
import { bracketedMessageId, deliveredMessageId } from "../lib/message-id";
import type { OutboxSendResult } from "../lib/outbox";
import { discardSentAttachments } from "../lib/sent-attachments";
import {
  buildSubmissionMessage,
  loadDeliveredMessageIds,
  sendSubmission,
  submissionAttachmentFilename,
  submissionAttachmentLeaves,
} from "../lib/submit-message";
import { MAX_DELAYED_SEND } from "./constants";
import { listUsableIdentities } from "./mailboxes";
import { withInlineAttachmentUrls } from "./sent-row";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = DrizzleD1Database<any>;
type SubmissionRow = typeof jmapSubmissions.$inferSelect;

export type ReleaseMessage = {
  type: "jmap_submission_release";
  submissionId: string;
};

/** A `releasing` submission older than this was interrupted; recovery settles it. */
export const RELEASE_RECOVERY_AGE_SECONDS = 15 * 60;
/** The hourly sweep releases scheduled sends this far past due (the queue missed them). */
const OVERDUE_GRACE_SECONDS = 60;
const SWEEP_BATCH = 50;
/** Overdue batches one hourly sweep works through before leaving the rest. */
const SWEEP_MAX_BATCHES = 10;

export async function enqueueRelease(
  env: CloudflareBindings,
  submissionId: string,
  delaySeconds: number,
): Promise<void> {
  const message: ReleaseMessage = {
    type: "jmap_submission_release",
    submissionId,
  };
  await env.EMAIL_QUEUE.send(message, {
    delaySeconds: Math.min(Math.max(0, delaySeconds), MAX_DELAYED_SEND),
  });
}

export type CancelOutcome =
  | "canceled"
  | "alreadyCanceled"
  | "cannotUnsend"
  | "notFound";

/**
 * Cancel a scheduled submission: wins only while it is `scheduled` with
 * undoStatus `pending`, in the same statement the release's claim races. The
 * Sent row turns `canceled` in the same batch. Nothing else moves: a JMAP client
 * files the Email back into Drafts itself (restoreCanceledToDrafts); the web
 * Outbox asks for that with `restoreToDrafts`.
 */
export async function cancelScheduledSubmission(
  env: CloudflareBindings,
  input: { submissionId: string; userId: string; restoreToDrafts: boolean },
): Promise<CancelOutcome> {
  const d1 = env.DB;
  const [cancel] = await d1.batch([
    d1
      .prepare(
        `UPDATE jmap_submissions SET undo_status = 'canceled', restore_to_drafts = ?
          WHERE id = ? AND user_id = ? AND attempt_state = 'scheduled' AND undo_status = 'pending'`,
      )
      .bind(input.restoreToDrafts ? 1 : 0, input.submissionId, input.userId),
    d1
      .prepare(
        `UPDATE sent_emails SET status = 'canceled'
          WHERE status = 'scheduled'
            AND id = (SELECT sent_email_id FROM jmap_submissions
                       WHERE id = ? AND undo_status = 'canceled')`,
      )
      .bind(input.submissionId),
  ]);
  if ((cancel?.meta?.changes ?? 0) > 0) return "canceled";
  const row = await d1
    .prepare(
      `SELECT attempt_state, undo_status FROM jmap_submissions WHERE id = ? AND user_id = ?`,
    )
    .bind(input.submissionId, input.userId)
    .first<{ attempt_state: string; undo_status: string }>();
  if (!row || row.attempt_state === "claimed") return "notFound";
  return row.undo_status === "canceled" ? "alreadyCanceled" : "cannotUnsend";
}

export type ReleaseOutcome =
  | "notDue"
  | "skipped"
  | "canceled"
  | "sent"
  | "retrying"
  | "failed";

/** Give a claim back so a later release (queue retry or sweep) sends it. */
async function unclaim(db: Db, env: CloudflareBindings, row: SubmissionRow) {
  await discardSentAttachments(db, env, row.sentEmailId);
  await db
    .update(jmapSubmissions)
    .set({ attemptState: "scheduled", releasedAt: null })
    .where(
      and(
        eq(jmapSubmissions.id, row.id),
        eq(jmapSubmissions.attemptState, "releasing"),
      ),
    );
}

/** Terminal: the message will never go out. The Email stays in Sent, failed. */
async function failRelease(db: Db, row: SubmissionRow, reason: string) {
  console.error(`[jmap] release of ${row.id} failed: ${reason}`);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await db.batch([
    db
      .update(sentEmails)
      .set({ status: "failed" })
      .where(eq(sentEmails.id, row.sentEmailId)),
    db
      .update(jmapSubmissions)
      .set({ attemptState: "accepted", undoStatus: "final" })
      .where(
        and(
          eq(jmapSubmissions.id, row.id),
          eq(jmapSubmissions.attemptState, "releasing"),
        ),
      ),
  ] as any);
}

/**
 * Send one scheduled submission when it is due. Idempotent under at-least-once
 * delivery: only the caller whose claim succeeds sends. `now` and `sender` are
 * overridable for tests.
 */
export async function releaseScheduledSubmission(
  env: CloudflareBindings,
  submissionId: string,
  opts: { sender?: EmailSender; now?: number } = {},
): Promise<ReleaseOutcome> {
  const db = createDb(env) as unknown as Db;
  // While outbound sending is paused a delayed send stays scheduled (and can
  // still be canceled); the hourly sweep, or the resume, releases it later.
  if (await isSendingPaused(db)) return "notDue";
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const claimed = await db
    .update(jmapSubmissions)
    .set({ attemptState: "releasing", releasedAt: now })
    .where(
      and(
        eq(jmapSubmissions.id, submissionId),
        eq(jmapSubmissions.attemptState, "scheduled"),
        eq(jmapSubmissions.undoStatus, "pending"),
        lte(jmapSubmissions.sendAt, now),
      ),
    )
    .returning();
  if (claimed.length === 0) {
    // Delivered early (or the send time moved): wait for the rest of the delay.
    const [waiting] = await db
      .select({ sendAt: jmapSubmissions.sendAt })
      .from(jmapSubmissions)
      .where(
        and(
          eq(jmapSubmissions.id, submissionId),
          eq(jmapSubmissions.attemptState, "scheduled"),
          eq(jmapSubmissions.undoStatus, "pending"),
        ),
      )
      .limit(1);
    if (waiting && waiting.sendAt > now) {
      await enqueueRelease(env, submissionId, waiting.sendAt - now);
      return "notDue";
    }
    return "skipped";
  }
  const row = claimed[0];

  const [sent] = await db
    .select({ id: sentEmails.id, personId: sentEmails.personId })
    .from(sentEmails)
    .where(eq(sentEmails.id, row.sentEmailId))
    .limit(1);
  if (!sent) {
    // Its Sent message was deleted (or its person was) before it went out:
    // deleting a scheduled message cancels it.
    await db
      .update(jmapSubmissions)
      .set({ attemptState: "scheduled", undoStatus: "canceled" })
      .where(
        and(
          eq(jmapSubmissions.id, row.id),
          eq(jmapSubmissions.attemptState, "releasing"),
        ),
      );
    return "canceled";
  }

  const [content] = await db
    .select()
    .from(jmapMessageContent)
    .where(eq(jmapMessageContent.id, row.contentId))
    .limit(1);
  if (!content) {
    await failRelease(db, row, "its content is gone");
    return "failed";
  }

  // The identity must still be one the user may send from: access revoked
  // while the message waited means it is not sent.
  const [user] = await db
    .select()
    .from(users)
    .where(eq(users.id, row.userId))
    .limit(1);
  const identities = user
    ? await listUsableIdentities(db, await resolveAllowedInboxes(db, user))
    : [];
  if (
    !identities.some(
      (identity) =>
        identity.email.trim().toLowerCase() === row.identityEmail.trim(),
    )
  ) {
    await failRelease(db, row, "its identity is no longer usable");
    return "failed";
  }

  // Stage the Sent attachments now, as the immediate path does before its
  // provider call (spec §3.5 order: rows, then R2 copies).
  const leaves = submissionAttachmentLeaves(content);
  const staged = leaves.map((leaf) => {
    const id = nanoid();
    const filename = submissionAttachmentFilename(leaf);
    return {
      id,
      leaf,
      filename,
      r2Key: `attachments/sent/${row.sentEmailId}/${id}/${filename}`,
    };
  });
  if (staged.length > 0) {
    const d1 = env.DB;
    await d1.batch(
      staged.map((item) =>
        d1
          .prepare(
            `INSERT INTO attachments (id, email_id, kind, filename, content_type, size, r2_key, content_id, created_at)
             SELECT ?, ?, 'sent', ?, ?, ?, ?, ?, ?
              WHERE EXISTS (SELECT 1 FROM jmap_submissions WHERE id = ? AND attempt_state = 'releasing')`,
          )
          .bind(
            item.id,
            row.sentEmailId,
            item.filename,
            item.leaf.type,
            item.leaf.size,
            item.r2Key,
            item.leaf.cid,
            now,
            row.id,
          ),
      ),
    );
  }
  let bytes: Uint8Array[];
  try {
    bytes = await Promise.all(
      staged.map(async (item) => {
        const object = await env.R2.get(item.leaf.r2Key!);
        if (!object) throw new MissingObjectError(item.leaf.r2Key!);
        const data = new Uint8Array(await object.arrayBuffer());
        await env.R2.put(item.r2Key, data, {
          httpMetadata: { contentType: item.leaf.type },
        });
        return data;
      }),
    );
  } catch (error) {
    if (error instanceof MissingObjectError) {
      await failRelease(db, row, `attachment ${error.key} is gone`);
      return "failed";
    }
    await unclaim(db, env, row);
    throw error;
  }
  const sendAttachments: SendEmailAttachment[] = staged.map((item, index) => ({
    filename: item.filename,
    contentType: item.leaf.type,
    content: bytes[index],
    contentId: item.leaf.cid,
    disposition: item.leaf.disposition === "inline" ? "inline" : "attachment",
  }));

  const message = buildSubmissionMessage(
    content,
    { email: row.identityEmail, displayName: null },
    sendAttachments,
    await loadDeliveredMessageIds(db, content),
  );
  if (row.fromHeader) message.from = row.fromHeader;

  const sender = opts.sender ?? createEmailSender(env);
  let result: OutboxSendResult;
  try {
    result = await sendSubmission({
      db,
      env,
      sender,
      sentEmailId: row.sentEmailId,
      message,
      bookkeepingOwner: "jmap",
      // Every release attempt of this submission is the same outbox row, so a
      // retry after an attempt that threw carries the same idempotency key.
      outboxId: releaseOutboxId(row.id),
    });
  } catch (error) {
    const [survivor] = await db
      .select({ id: outboxEmails.id })
      .from(outboxEmails)
      .where(eq(outboxEmails.sentEmailId, row.sentEmailId))
      .limit(1);
    // A surviving outbox row may have reached the provider: keep the claim and
    // let recovery settle it. Otherwise nothing was sent; release it again.
    if (!survivor) await unclaim(db, env, row);
    throw error;
  }

  if (result.outcome === "sent" || result.outcome === "retrying") {
    const provider = result.send.result ?? null;
    const statements = [
      db
        .update(sentEmails)
        .set({
          status: result.outcome,
          resendId: provider?.id ?? null,
          messageId: deliveredMessageId(
            message.headers["Message-ID"],
            provider,
          ),
          bodyHtml: message.html
            ? await withInlineAttachmentUrls(db, row.sentEmailId, message.html)
            : null,
          sentAt: Math.floor(Date.now() / 1000),
        })
        .where(eq(sentEmails.id, row.sentEmailId)),
      // Irreversible now: the provider has it, or the outbox owns its retries.
      db
        .update(jmapSubmissions)
        .set({ attemptState: "accepted", undoStatus: "final" })
        .where(
          and(
            eq(jmapSubmissions.id, row.id),
            eq(jmapSubmissions.attemptState, "releasing"),
          ),
        ),
      db
        .delete(outboxEmails)
        .where(
          and(
            eq(outboxEmails.sentEmailId, row.sentEmailId),
            eq(outboxEmails.bookkeepingOwner, "jmap"),
            eq(outboxEmails.status, "bookkeeping_pending"),
          ),
        ),
    ];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await db.batch(statements as any);
    // Released by the queue or the hourly sweep, but it is the send of the
    // person who scheduled it.
    await runWithAudit(
      {
        actorType: "jmap",
        actorUserId: row.userId,
        actorLabel: `JMAP (scheduled send${user?.email ? ` by ${user.email}` : ""})`,
        channel: currentAuditActor().channel,
      },
      () =>
        auditMailSent(db, {
          id: row.sentEmailId,
          from: message.fromAddress,
          to: message.to,
          otherRecipients:
            message.additionalTo.length +
            message.cc.length +
            message.bcc.length,
          subject: message.subject,
          status: result.outcome,
        }),
    );
    if (sent.personId) {
      try {
        await cancelSequencesForPerson(db, sent.personId);
      } catch (error) {
        console.error(
          `[jmap] cancelling sequences after release ${row.id} failed:`,
          error,
        );
      }
    }
    return result.outcome;
  }

  // Terminal failure or suppression. A failed outbox row stays for the web
  // Outbox's Retry / Cancel, as for any other send.
  await failRelease(
    db,
    row,
    result.send.result?.error?.message ?? "every recipient is suppressed",
  );
  return "failed";
}

/** The outbox row id (and so the idempotency key) of a submission's release. */
export function releaseOutboxId(submissionId: string): string {
  return `jmap-release-${submissionId}`;
}

class MissingObjectError extends Error {
  constructor(readonly key: string) {
    super(`content object ${key} is missing`);
  }
}

/** Hourly safety net: release every scheduled send the queue missed. */
export async function releaseOverdueSubmissions(
  env: CloudflareBindings,
  now: number,
  sender?: EmailSender,
): Promise<number> {
  const db = createDb(env) as unknown as Db;
  // Checked once here, not once per submission: nothing is released while
  // sending is paused.
  if (await isSendingPaused(db)) return 0;
  let released = 0;
  const tried = new Set<string>();
  for (let batch = 0; batch < SWEEP_MAX_BATCHES; batch++) {
    const due = (
      await db
        .select({ id: jmapSubmissions.id })
        .from(jmapSubmissions)
        .where(
          and(
            eq(jmapSubmissions.attemptState, "scheduled"),
            eq(jmapSubmissions.undoStatus, "pending"),
            lte(jmapSubmissions.sendAt, now - OVERDUE_GRACE_SECONDS),
          ),
        )
        .orderBy(jmapSubmissions.sendAt)
        .limit(SWEEP_BATCH + tried.size)
    ).filter(({ id }) => !tried.has(id));
    if (due.length === 0) break;
    for (const { id } of due.slice(0, SWEEP_BATCH)) {
      tried.add(id);
      try {
        const outcome = await releaseScheduledSubmission(env, id, {
          now,
          sender,
        });
        if (outcome !== "skipped" && outcome !== "notDue") released++;
      } catch (error) {
        // Given back to `scheduled`: the next hourly sweep tries again.
        console.error(`[cron] releasing ${id} failed:`, error);
      }
    }
  }
  return released;
}

/**
 * Settle a release interrupted after its claim (spec D2): read the durable
 * rows, never mere existence. An outbox row proves the provider was (or is
 * being) tried; without one nothing went out, so the claim is given back.
 */
export async function recoverReleasingSubmissions(
  env: CloudflareBindings,
  now: number,
): Promise<number> {
  const db = createDb(env) as unknown as Db;
  const stuck = await db
    .select()
    .from(jmapSubmissions)
    .where(
      and(
        eq(jmapSubmissions.attemptState, "releasing"),
        lt(jmapSubmissions.releasedAt, now - RELEASE_RECOVERY_AGE_SECONDS),
      ),
    )
    .limit(SWEEP_BATCH);
  let settled = 0;
  for (const row of stuck) {
    try {
      const [outbox] = await db
        .select({
          status: outboxEmails.status,
          deliveredMessageId: outboxEmails.deliveredMessageId,
        })
        .from(outboxEmails)
        .where(eq(outboxEmails.sentEmailId, row.sentEmailId))
        .limit(1);
      if (!outbox) {
        await unclaim(db, env, row);
        settled++;
        continue;
      }
      const status =
        outbox.status === "bookkeeping_pending"
          ? "sent"
          : outbox.status === "pending"
            ? "retrying"
            : "failed";
      const [sent] = await db
        .select({ personId: sentEmails.personId })
        .from(sentEmails)
        .where(eq(sentEmails.id, row.sentEmailId))
        .limit(1);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await db.batch([
        db
          .update(sentEmails)
          .set({
            status,
            ...(outbox.deliveredMessageId
              ? { messageId: bracketedMessageId(outbox.deliveredMessageId) }
              : {}),
          })
          .where(eq(sentEmails.id, row.sentEmailId)),
        db
          .update(jmapSubmissions)
          .set({ attemptState: "accepted", undoStatus: "final" })
          .where(
            and(
              eq(jmapSubmissions.id, row.id),
              eq(jmapSubmissions.attemptState, "releasing"),
            ),
          ),
        db
          .delete(outboxEmails)
          .where(
            and(
              eq(outboxEmails.sentEmailId, row.sentEmailId),
              eq(outboxEmails.status, "bookkeeping_pending"),
            ),
          ),
      ] as any);
      // As the release itself: a manual message stops the person's sequences.
      if (status !== "failed" && sent?.personId) {
        await cancelSequencesForPerson(db, sent.personId);
      }
      settled++;
    } catch (error) {
      console.error(`[jmap] recovering release ${row.id} failed:`, error);
    }
  }
  return settled;
}

/** Where the reverse alias files the Email back as a draft. */
export type DraftRestoreTarget = {
  role: "drafts" | "trash";
  folders: string[];
  seen: boolean;
  flagged: boolean;
};

/**
 * The reverse alias (delayed-send spec D2): the Sent Email of a canceled
 * delayed send moves back to Drafts under the same `D…` id. Only an aliased
 * Sent row whose submission is canceled qualifies, and only for its author.
 * One guarded D1 batch: the draft row comes back (its insert logs nothing),
 * the Sent row and its per-message state go (their triggers log nothing), and
 * the batch writes the change rows itself — an update for the author, who
 * keeps the same Email, and a destroy for every other inbox member, who saw
 * a Sent Email. Returns false when nothing qualified.
 */
export async function restoreCanceledToDrafts(
  env: CloudflareBindings,
  input: {
    submissionId: string;
    userId: string;
    target: DraftRestoreTarget;
    now: number;
  },
): Promise<boolean> {
  const d1 = env.DB;
  const row = await d1
    .prepare(
      `SELECT js.draft_id, js.content_id, js.identity_email, js.sent_email_id,
              se.jmap_received_at, se.from_address
         FROM jmap_submissions js
         JOIN sent_emails se ON se.id = js.sent_email_id AND se.jmap_email_id = js.draft_id
        WHERE js.id = ? AND js.user_id = ? AND js.undo_status = 'canceled'`,
    )
    .bind(input.submissionId, input.userId)
    .first<{
      draft_id: string;
      content_id: string;
      identity_email: string;
      sent_email_id: string;
      jmap_received_at: number | null;
      from_address: string;
    }>();
  if (!row) return false;
  const { now, target } = input;
  const qualifies = `EXISTS (
    SELECT 1 FROM jmap_submissions js
      JOIN sent_emails se ON se.id = js.sent_email_id AND se.jmap_email_id = js.draft_id
     WHERE js.id = ? AND js.undo_status = 'canceled')`;
  const restored = `EXISTS (SELECT 1 FROM jmap_drafts WHERE id = ? AND content_id = ?)
    AND NOT EXISTS (SELECT 1 FROM sent_emails WHERE id = ?)`;
  const results = await d1.batch([
    d1
      .prepare(
        `INSERT INTO jmap_drafts (id, user_id, content_id, inbox, received_at, mailbox_role, seen, flagged, folder_ids, submit_state, submit_attempt_id, alias_delete, created_at, updated_at)
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, 1, ?, ?
          WHERE ${qualifies}`,
      )
      .bind(
        row.draft_id,
        input.userId,
        row.content_id,
        row.identity_email,
        row.jmap_received_at ?? now,
        target.role,
        target.seen ? 1 : 0,
        target.flagged ? 1 : 0,
        JSON.stringify(target.folders),
        now,
        now,
        input.submissionId,
      ),
    d1
      .prepare(`UPDATE jmap_drafts SET alias_delete = 0 WHERE id = ?`)
      .bind(row.draft_id),
    d1
      .prepare(
        `UPDATE sent_emails SET alias_restore = 1
          WHERE id = ? AND EXISTS (SELECT 1 FROM jmap_drafts WHERE id = ? AND content_id = ?)`,
      )
      .bind(row.sent_email_id, row.draft_id, row.content_id),
    d1
      .prepare(`DELETE FROM sent_emails WHERE id = ? AND alias_restore = 1`)
      .bind(row.sent_email_id),
    // After the row is gone, so their triggers find no Sent row to log for.
    ...["mailbox_message_state", "message_user_state", "message_mailboxes"].map(
      (table) =>
        d1
          .prepare(
            `DELETE FROM ${table} WHERE message_kind = 'sent' AND message_id = ?
               AND NOT EXISTS (SELECT 1 FROM sent_emails WHERE id = ?)`,
          )
          .bind(row.sent_email_id, row.sent_email_id),
    ),
    d1
      .prepare(
        `INSERT INTO jmap_changes (object_type, object_id, inbox, user_id, exclude_user_id, op, created_at)
         SELECT 'email', 'draft:' || ?, ?, ?, NULL, 'u', ? WHERE ${restored}`,
      )
      .bind(
        row.draft_id,
        row.from_address,
        input.userId,
        now,
        row.draft_id,
        row.content_id,
        row.sent_email_id,
      ),
    d1
      .prepare(
        `INSERT INTO jmap_changes (object_type, object_id, inbox, user_id, exclude_user_id, op, created_at)
         SELECT 'email', 'draft:' || ?, ?, NULL, ?, 'd', ? WHERE ${restored}`,
      )
      .bind(
        row.draft_id,
        row.from_address,
        input.userId,
        now,
        row.draft_id,
        row.content_id,
        row.sent_email_id,
      ),
    d1
      .prepare(
        `UPDATE jmap_submissions SET restore_to_drafts = 0 WHERE id = ? AND ${restored}`,
      )
      .bind(
        input.submissionId,
        row.draft_id,
        row.content_id,
        row.sent_email_id,
      ),
  ]);
  return (results[3]?.meta?.changes ?? 0) > 0;
}

/**
 * The web Outbox's Cancel moves the Email back to Drafts after canceling; when
 * that second step failed, finish it here. Only the author's own flag is read,
 * so a JMAP client's canceled Email stays where the client left it.
 */
export async function restoreOwedDrafts(
  env: CloudflareBindings,
  now: number,
): Promise<number> {
  const db = createDb(env) as unknown as Db;
  const owed = await db
    .select({ id: jmapSubmissions.id, userId: jmapSubmissions.userId })
    .from(jmapSubmissions)
    .where(
      and(
        eq(jmapSubmissions.undoStatus, "canceled"),
        eq(jmapSubmissions.restoreToDrafts, 1),
      ),
    )
    .limit(SWEEP_BATCH);
  let restored = 0;
  for (const submission of owed) {
    try {
      const target = await webRestoreTarget(db, submission.id);
      const moved = target
        ? await restoreCanceledToDrafts(env, {
            submissionId: submission.id,
            userId: submission.userId,
            target,
            now,
          })
        : false;
      if (moved) restored++;
      else if (!(await restoreStillPossible(env, submission.id))) {
        // Nothing to move: the Sent row is gone, or the send never filed its
        // draft into Sent (the draft is still a draft, or the client destroyed it).
        await db
          .update(jmapSubmissions)
          .set({ restoreToDrafts: 0 })
          .where(eq(jmapSubmissions.id, submission.id));
      }
    } catch (error) {
      console.error(
        `[jmap] restoring canceled ${submission.id} to Drafts failed:`,
        error,
      );
    }
  }
  return restored;
}

/**
 * Whether a canceled send's Email can still be moved back to Drafts: its
 * on-success step hasn't run yet (it may still file the draft into Sent), or it
 * was filed into Sent and is still there.
 */
export async function restoreStillPossible(
  env: CloudflareBindings,
  submissionId: string,
): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT 1 AS ok FROM jmap_submissions js
      WHERE js.id = ? AND js.undo_status = 'canceled'
        AND (js.on_success_state = 'pending'
             OR EXISTS (SELECT 1 FROM sent_emails se
                         WHERE se.id = js.sent_email_id AND se.jmap_email_id = js.draft_id))`,
  )
    .bind(submissionId)
    .first<{ ok: number }>();
  return row !== null;
}

/**
 * The web's "back to Drafts": Drafts, keeping the Email's custom folders and
 * its author's flag. Null when the canceled Sent row is gone.
 */
export async function webRestoreTarget(
  db: Db,
  submissionId: string,
): Promise<DraftRestoreTarget | null> {
  const [row] = await db
    .select({
      sentEmailId: jmapSubmissions.sentEmailId,
      userId: jmapSubmissions.userId,
    })
    .from(jmapSubmissions)
    .where(eq(jmapSubmissions.id, submissionId))
    .limit(1);
  if (!row) return null;
  const folders = await db.all<{ mailbox_id: string }>(sql`
    SELECT mailbox_id FROM message_mailboxes
     WHERE message_kind = 'sent' AND message_id = ${row.sentEmailId}
  `);
  const flagged = await db.all<{ starred_at: number | null }>(sql`
    SELECT starred_at FROM message_user_state
     WHERE user_id = ${row.userId} AND message_kind = 'sent' AND message_id = ${row.sentEmailId}
  `);
  return {
    role: "drafts",
    folders: folders.map((folder) => folder.mailbox_id),
    seen: true,
    flagged: flagged.some((state) => state.starred_at !== null),
  };
}
