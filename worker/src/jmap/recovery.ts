import { and, eq, inArray, lt, ne, sql } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { users } from "../db/auth.schema";
import { jmapSubmissions } from "../db/jmap-submissions.schema";
import { outboxEmails } from "../db/outbox-emails.schema";
import { sentEmails } from "../db/sent-emails.schema";
import { createDb } from "../db/client";
import { resolveAllowedInboxes } from "../lib/inbox-permissions";
import { bracketedMessageId } from "../lib/message-id";
import { discardSentAttachments } from "../lib/sent-attachments";
import { queuedLockReleasableSql } from "./queued-lock";
import { applyOnSuccessStep } from "./on-success";
import {
  recoverReleasingSubmissions,
  releaseOverdueSubmissions,
  restoreOwedDrafts,
} from "./release";
import { writeSentRow } from "./sent-row";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = DrizzleD1Database<any>;

/**
 * A `claimed` intention older than this is treated as interrupted: the provider
 * call happened (or provably did not) long enough ago that the hourly pass can
 * settle it from the durable rows alone (spec §3.4).
 */
export const JMAP_RECOVERY_AGE_SECONDS = 15 * 60;
/** Accepted, applied submissions are forgotten after this; their trigger writes a tombstone. */
export const JMAP_SUBMISSION_RETENTION_SECONDS = 7 * 24 * 60 * 60;
const RECOVERY_BATCH = 100;
const PRUNE_BATCH = 500;
/** Ids per IN list: D1 binds at most 100 parameters per statement. */
const ID_CHUNK = 90;

function chunks<T>(items: T[]): T[][] {
  const out: T[][] = [];
  for (let start = 0; start < items.length; start += ID_CHUNK) {
    out.push(items.slice(start, start + ID_CHUNK));
  }
  return out;
}

/**
 * Release JMAP-owned outbox rows the provider accepted (usually on a retry)
 * once their submission is accepted AND its on-success step is applied. A
 * `pending` row is never touched: the outbox still owes a delivery.
 */
export async function releaseAppliedJmapOutboxRows(db: Db): Promise<number> {
  const result = await db.run(sql`
    DELETE FROM outbox_emails
     WHERE bookkeeping_owner = 'jmap'
       AND status = 'bookkeeping_pending'
       AND sent_email_id IN (
         SELECT sent_email_id FROM jmap_submissions
          WHERE attempt_state = 'accepted' AND on_success_state = 'applied'
       )
  `);
  return result.meta.changes ?? 0;
}

async function releaseClaim(db: Db, draftId: string, submissionId: string) {
  await db.run(sql`
    UPDATE jmap_drafts SET submit_state = NULL, submit_attempt_id = NULL
     WHERE id = ${draftId} AND submit_attempt_id = ${submissionId}
  `);
}

async function accept(db: Db, submissionId: string) {
  await db
    .update(jmapSubmissions)
    .set({ attemptState: "accepted" })
    .where(
      and(
        eq(jmapSubmissions.id, submissionId),
        eq(jmapSubmissions.attemptState, "claimed"),
      ),
    );
}

/**
 * Give up an intention that will never be accepted: nothing JMAP-visible may
 * remain (spec §3.2, §3.4). Only reached once the outbox row is terminal, so a
 * retry that still needs anything here is never discarded.
 */
async function abandon(
  db: Db,
  env: CloudflareBindings,
  submission: typeof jmapSubmissions.$inferSelect,
) {
  await discardSentAttachments(db, env, submission.sentEmailId); // R2 first
  // The Sent row before the intention: its delete trigger still sees the row as
  // hidden, so no client is told about a `d` for an object nobody saw.
  await db
    .delete(sentEmails)
    .where(
      and(
        eq(sentEmails.id, submission.sentEmailId),
        sql`${sentEmails.jmapContentId} IS NOT NULL`,
      ),
    );
  await db
    .delete(outboxEmails)
    .where(eq(outboxEmails.sentEmailId, submission.sentEmailId));
  await db.delete(jmapSubmissions).where(eq(jmapSubmissions.id, submission.id));
  await releaseClaim(db, submission.draftId, submission.id);
}

/**
 * Settle every `claimed` intention older than 15 minutes (spec §3.4 table).
 * Reads STATUSES, never mere existence, so a row that merely exists is never
 * mistaken for one the provider accepted.
 */
export async function recoverClaimedSubmissions(
  db: Db,
  env: CloudflareBindings,
  now: number,
): Promise<number> {
  const claimed = await db
    .select()
    .from(jmapSubmissions)
    .where(
      and(
        eq(jmapSubmissions.attemptState, "claimed"),
        lt(jmapSubmissions.createdAt, now - JMAP_RECOVERY_AGE_SECONDS),
      ),
    )
    .limit(RECOVERY_BATCH);

  let settled = 0;
  for (const submission of claimed) {
    try {
      const [outbox] = await db
        .select({
          status: outboxEmails.status,
          deliveredMessageId: outboxEmails.deliveredMessageId,
        })
        .from(outboxEmails)
        .where(eq(outboxEmails.sentEmailId, submission.sentEmailId))
        .limit(1);
      const [sent] = await db
        .select({ status: sentEmails.status })
        .from(sentEmails)
        .where(eq(sentEmails.id, submission.sentEmailId))
        .limit(1);

      if (outbox?.status === "bookkeeping_pending") {
        // The provider accepted. Write or upgrade the Sent row, accept, release.
        if (!sent) {
          await writeSentRow(
            db,
            submission,
            "sent",
            now,
            outbox.deliveredMessageId,
          );
        } else if (sent.status !== "sent") {
          await db
            .update(sentEmails)
            .set({
              status: "sent",
              ...(outbox.deliveredMessageId
                ? { messageId: bracketedMessageId(outbox.deliveredMessageId) }
                : {}),
            })
            .where(eq(sentEmails.id, submission.sentEmailId));
        }
        await accept(db, submission.id);
        await db
          .delete(outboxEmails)
          .where(
            and(
              eq(outboxEmails.sentEmailId, submission.sentEmailId),
              eq(outboxEmails.status, "bookkeeping_pending"),
            ),
          );
      } else if (outbox?.status === "pending") {
        // The outbox owns delivery. Never release the claim.
        if (!sent) await writeSentRow(db, submission, "retrying", now);
        await accept(db, submission.id);
        await db.run(sql`
          UPDATE jmap_drafts SET submit_state = 'queued'
           WHERE id = ${submission.draftId} AND submit_attempt_id = ${submission.id}
        `);
      } else if (outbox?.status === "failed") {
        await abandon(db, env, submission);
      } else if (
        sent &&
        (sent.status === "sent" || sent.status === "retrying")
      ) {
        // Accepted already; the after-call batch just didn't finish.
        await accept(db, submission.id);
      } else {
        // No outbox row and no usable Sent row: nothing reached the provider.
        await abandon(db, env, submission);
      }
      settled++;
    } catch (err) {
      console.error(
        `[jmap] recovery failed for submission ${submission.id}:`,
        err,
      );
    }
  }
  return settled;
}

/** Apply every accepted submission's pending on-success step, exactly once. */
export async function applyPendingOnSuccess(
  db: Db,
  env: CloudflareBindings,
  now: number,
): Promise<number> {
  const pending = await db
    .select({ id: jmapSubmissions.id, userId: jmapSubmissions.userId })
    .from(jmapSubmissions)
    .where(
      and(
        ne(jmapSubmissions.attemptState, "claimed"),
        eq(jmapSubmissions.onSuccessState, "pending"),
        lt(jmapSubmissions.createdAt, now - JMAP_RECOVERY_AGE_SECONDS),
      ),
    )
    .limit(RECOVERY_BATCH);
  const byUser = new Map<string, string[]>();
  for (const row of pending) {
    byUser.set(row.userId, [...(byUser.get(row.userId) ?? []), row.id]);
  }

  let applied = 0;
  for (const [userId, submissionIds] of byUser) {
    try {
      const [user] = await db.select().from(users).where(eq(users.id, userId));
      if (!user) continue;
      const allowed = await resolveAllowedInboxes(db, user);
      await applyOnSuccessStep({
        db,
        allowed,
        user,
        ctx: { env, createdIds: new Map() },
        submissionIds,
        emitResponse: false,
      });
      for (const ids of chunks(submissionIds)) {
        const [{ count }] = await db
          .select({ count: sql<number>`COUNT(*)` })
          .from(jmapSubmissions)
          .where(
            and(
              inArray(jmapSubmissions.id, ids),
              eq(jmapSubmissions.onSuccessState, "applied"),
            ),
          );
        applied += Number(count);
      }
    } catch (err) {
      console.error(
        `[jmap] on-success recovery failed for user ${userId}:`,
        err,
      );
    }
  }
  return applied;
}

/**
 * A `queued` draft unlocks once its outbox row is terminal. A `pending` row
 * means a retry is still owed, so the lock stays.
 */
export async function unlockQueuedDrafts(db: Db, now: number): Promise<number> {
  const result = await db.run(sql`
    UPDATE jmap_drafts
       SET submit_state = NULL, submit_attempt_id = NULL, updated_at = ${now}
     WHERE submit_state = 'queued'
       AND ${queuedLockReleasableSql(sql`jmap_drafts.submit_attempt_id`)}
  `);
  return result.meta.changes ?? 0;
}

/**
 * Settled submissions: accepted and applied, or a canceled delayed send whose
 * web move back to Drafts is not still owed.
 */
const PRUNABLE = sql`on_success_state = 'applied' AND (
  attempt_state = 'accepted'
  OR (attempt_state = 'scheduled' AND undo_status = 'canceled' AND restore_to_drafts = 0)
)`;

/** Forget settled submissions after 7 days; their trigger writes tombstones. */
export async function pruneJmapSubmissions(
  db: Db,
  now: number,
): Promise<number> {
  // Two statements, not `DELETE … WHERE id IN (SELECT … FROM jmap_submissions)`:
  // `changes()` is unreliable here (a self-referencing subquery inflates it, and
  // the delete trigger's own `jmap_changes` insert counts too), so the batch is
  // selected first and the survivors are counted instead. Repeating the
  // conditions on the delete keeps the cut idempotent.
  const rows = await db.all<{ id: string }>(sql`
    SELECT id FROM jmap_submissions
     WHERE ${PRUNABLE}
       AND send_at < ${now - JMAP_SUBMISSION_RETENTION_SECONDS}
     ORDER BY send_at
     LIMIT ${PRUNE_BATCH}
  `);
  if (rows.length === 0) return 0;
  let survivors = 0;
  for (const ids of chunks(rows.map((row) => row.id))) {
    const list = sql.join(
      ids.map((id) => sql`${id}`),
      sql`, `,
    );
    await db.run(sql`
      DELETE FROM jmap_submissions
       WHERE id IN (${list})
         AND ${PRUNABLE}
    `);
    const left = await db.all<{ id: string }>(sql`
      SELECT id FROM jmap_submissions WHERE id IN (${list})
    `);
    survivors += left.length;
  }
  return rows.length - survivors;
}

/**
 * Hourly. Each sweep is caught on its own, so none of them can block another,
 * and the whole pass is idempotent: every step is guarded or status-driven.
 */
export async function runJmapSubmissionMaintenance(
  env: CloudflareBindings,
): Promise<void> {
  const db = createDb(env) as unknown as Db;
  const now = Math.floor(Date.now() / 1000);
  await releaseAppliedJmapOutboxRows(db).catch((err) =>
    console.error("[cron] JMAP outbox release failed:", err),
  );
  await recoverClaimedSubmissions(db, env, now).catch((err) =>
    console.error("[cron] JMAP submission recovery failed:", err),
  );
  await applyPendingOnSuccess(db, env, now).catch((err) =>
    console.error("[cron] JMAP on-success recovery failed:", err),
  );
  await releaseOverdueSubmissions(env, now).catch((err) =>
    console.error("[cron] JMAP delayed-send release failed:", err),
  );
  await recoverReleasingSubmissions(env, now).catch((err) =>
    console.error("[cron] JMAP release recovery failed:", err),
  );
  await restoreOwedDrafts(env, now).catch((err) =>
    console.error("[cron] JMAP canceled-send restore failed:", err),
  );
  await unlockQueuedDrafts(db, now).catch((err) =>
    console.error("[cron] JMAP queued-draft unlock failed:", err),
  );
  await pruneJmapSubmissions(db, now).catch((err) =>
    console.error("[cron] JMAP submission pruning failed:", err),
  );
}
