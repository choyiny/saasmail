import { and, eq, inArray } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { jmapSubmissions } from "../db/jmap-submissions.schema";
import type { AllowedInboxes } from "../lib/inbox-permissions";
import { emailSet } from "./email-set";
import type { JmapMethodError } from "./emails";
import type { JmapMethodContext } from "./methods";
import { publicAccountId } from "./public-ids";
import { currentJmapState } from "./state";

export type OnSuccessMode = "none" | "update" | "destroy" | "both";

export type ParsedOnSuccess = {
  update: Record<string, Record<string, unknown>> | null;
  destroy: string[] | null;
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Worker `strict` is off, so narrow method errors through a guard. */
export function isMethodError(value: unknown): value is JmapMethodError {
  return (
    isObject(value) && typeof value.type === "string" && !("accountId" in value)
  );
}

/** RFC 8621 §7.5 arguments; malformed values fail the whole call. */
export function parseOnSuccessArgs(
  args: Record<string, unknown>,
): ParsedOnSuccess | JmapMethodError {
  const update = args.onSuccessUpdateEmail;
  const destroy = args.onSuccessDestroyEmail;
  if (
    update !== undefined &&
    update !== null &&
    (!isObject(update) || !Object.values(update).every(isObject))
  ) {
    return { type: "invalidArguments", properties: ["onSuccessUpdateEmail"] };
  }
  if (
    destroy !== undefined &&
    destroy !== null &&
    (!Array.isArray(destroy) ||
      !destroy.every((value) => typeof value === "string"))
  ) {
    return { type: "invalidArguments", properties: ["onSuccessDestroyEmail"] };
  }
  return {
    update: (update ?? null) as Record<string, Record<string, unknown>> | null,
    destroy: (destroy ?? null) as string[] | null,
  };
}

/**
 * What one create stores on its intention (spec §3.4 step 1). Only
 * `#creationId` keys can name a submission created in this call; keys naming an
 * existing submission never apply (see the plan's Decision 4).
 */
export function onSuccessForCreation(
  parsed: ParsedOnSuccess,
  creationId: string,
): { mode: OnSuccessMode; patch: Record<string, unknown> | null } {
  const key = `#${creationId}`;
  const patch = parsed.update?.[key] ?? null;
  const destroy = parsed.destroy?.includes(key) ?? false;
  const mode: OnSuccessMode =
    patch && destroy ? "both" : patch ? "update" : destroy ? "destroy" : "none";
  return { mode, patch };
}

/** Either argument present: the call answers with an implicit Email/set. */
export function wantsImplicitEmailSet(parsed: ParsedOnSuccess): boolean {
  return parsed.update !== null || parsed.destroy !== null;
}

export type PendingSubmission = typeof jmapSubmissions.$inferSelect;

/**
 * Every statement of a guarded batch carries this, so a second run of the same
 * batch (a concurrent request, or the recovery cron) changes nothing.
 */
const PENDING_GUARD = `EXISTS (SELECT 1 FROM jmap_submissions WHERE id = ? AND on_success_state = 'pending')`;

/**
 * The alias (spec §3.3, §5): a draft that just went out becomes the Sent Email
 * itself. One guarded D1 batch whose last statement is the `applied` marker, so
 * it runs at most once. While it runs the Sent row is still hidden, so the SQL
 * triggers write no rows of their own; the batch writes the two change rows the
 * spec prescribes (a user-scoped `u` for the draft's author, a shared `c`
 * everyone else in the inbox must see).
 *
 * The draft row is deleted last-but-one with `alias_delete` set, so its delete
 * trigger writes no `d`: the same Email id lives on as a Sent Email.
 */
export async function aliasDraftToSent(
  env: CloudflareBindings,
  input: {
    submission: PendingSubmission;
    draftId: string;
    draftReceivedAt: number;
    userId: string;
    system: "sent" | "trash";
    folders: string[];
    flagged: boolean;
    now: number;
  },
): Promise<boolean> {
  const { submission, draftId, now } = input;
  const db = env.DB;
  const statements: D1PreparedStatement[] = [
    db
      .prepare(
        `UPDATE sent_emails SET jmap_email_id = ?, jmap_received_at = ?
          WHERE id = ? AND ${PENDING_GUARD}`,
      )
      .bind(
        draftId,
        input.draftReceivedAt,
        submission.sentEmailId,
        submission.id,
      ),
  ];
  // A Sent Email's system mailbox comes from its own state (an outbound row with
  // no `trashed_at` is in Sent), so filing it into Trash is the only extra row
  // the target needs.
  statements.push(
    db
      .prepare(
        input.system === "trash"
          ? `INSERT INTO mailbox_message_state
               (inbox, message_kind, message_id, archived_at, spam_at, trashed_at, updated_by, updated_at)
             SELECT se.from_address, 'sent', se.id, NULL, NULL, ?, ?, ?
               FROM sent_emails se
              WHERE se.id = ? AND ${PENDING_GUARD}
             ON CONFLICT(message_kind, message_id) DO UPDATE SET
               trashed_at = excluded.trashed_at,
               updated_by = excluded.updated_by,
               updated_at = excluded.updated_at`
          : `UPDATE mailbox_message_state
                SET trashed_at = NULL, updated_by = ?, updated_at = ?
              WHERE inbox = (SELECT from_address FROM sent_emails WHERE id = ?)
                AND message_kind = 'sent' AND message_id = ?
                AND ${PENDING_GUARD}`,
      )
      .bind(
        ...(input.system === "trash"
          ? [now, input.userId, now, submission.sentEmailId, submission.id]
          : [
              input.userId,
              now,
              submission.sentEmailId,
              submission.sentEmailId,
              submission.id,
            ]),
      ),
  );
  for (const mailboxId of input.folders) {
    statements.push(
      db
        .prepare(
          `INSERT INTO message_mailboxes (message_kind, message_id, mailbox_id, added_by, added_at)
           SELECT 'sent', ?, ?, ?, ?
            WHERE EXISTS (SELECT 1 FROM sent_emails se WHERE se.id = ?)
              AND ${PENDING_GUARD}
           ON CONFLICT DO NOTHING`,
        )
        .bind(
          submission.sentEmailId,
          mailboxId,
          input.userId,
          now,
          submission.sentEmailId,
          submission.id,
        ),
    );
  }
  if (input.flagged) {
    statements.push(
      db
        .prepare(
          `INSERT INTO message_user_state (user_id, message_kind, message_id, seen_at, starred_at, updated_at)
           SELECT ?, 'sent', ?, NULL, ?, ? WHERE ${PENDING_GUARD}
           ON CONFLICT(user_id, message_kind, message_id) DO UPDATE SET
             starred_at = excluded.starred_at,
             updated_at = excluded.updated_at`,
        )
        .bind(input.userId, submission.sentEmailId, now, now, submission.id),
    );
  }
  statements.push(
    db
      .prepare(
        `UPDATE jmap_drafts SET alias_delete = 1 WHERE id = ? AND ${PENDING_GUARD}`,
      )
      .bind(draftId, submission.id),
    db
      .prepare(
        `DELETE FROM jmap_drafts WHERE id = ? AND alias_delete = 1 AND ${PENDING_GUARD}`,
      )
      .bind(draftId, submission.id),
    // The author already knew this Email (as a draft): it was updated.
    db
      .prepare(
        `INSERT INTO jmap_changes (object_type, object_id, inbox, user_id, exclude_user_id, op, created_at)
         SELECT 'email', 'draft:' || ?, se.from_address, ?, NULL, 'u', ?
           FROM sent_emails se WHERE se.id = ? AND ${PENDING_GUARD}`,
      )
      .bind(draftId, input.userId, now, submission.sentEmailId, submission.id),
    // Every other member of the inbox sees a new Email with the same id.
    db
      .prepare(
        `INSERT INTO jmap_changes (object_type, object_id, inbox, user_id, exclude_user_id, op, created_at)
         SELECT 'email', 'draft:' || ?, se.from_address, NULL, ?, 'c', ?
           FROM sent_emails se WHERE se.id = ? AND ${PENDING_GUARD}`,
      )
      .bind(draftId, input.userId, now, submission.sentEmailId, submission.id),
    db
      .prepare(
        `UPDATE jmap_submissions SET on_success_state = 'applied'
          WHERE id = ? AND on_success_state = 'pending'`,
      )
      .bind(submission.id),
  );
  const results = await db.batch(statements);
  return (results.at(-1)?.meta.changes ?? 0) > 0;
}

/**
 * Reveal a submission's Sent row as its own `S…` Email (every outcome except
 * the alias) and unlock a draft still waiting on this submission. A `queued`
 * draft (a retrying send) stays locked until the outbox is terminal.
 */
export async function revealSubmission(
  env: CloudflareBindings,
  submission: PendingSubmission,
  now: number,
): Promise<boolean> {
  const db = env.DB;
  const results = await db.batch([
    db
      .prepare(
        `INSERT INTO jmap_changes (object_type, object_id, inbox, user_id, exclude_user_id, op, created_at)
         SELECT 'email', 'sent:' || se.id, se.from_address, NULL, NULL, 'c', ?
           FROM sent_emails se
          WHERE se.id = ? AND se.jmap_email_id IS NULL AND ${PENDING_GUARD}`,
      )
      .bind(now, submission.sentEmailId, submission.id),
    db
      .prepare(
        `UPDATE jmap_drafts SET submit_state = NULL, submit_attempt_id = NULL, updated_at = ?
          WHERE id = ? AND submit_attempt_id = ? AND submit_state = 'submitting'
            AND ${PENDING_GUARD}`,
      )
      .bind(now, submission.draftId, submission.id, submission.id),
    db
      .prepare(
        `UPDATE jmap_submissions SET on_success_state = 'applied'
          WHERE id = ? AND on_success_state = 'pending'`,
      )
      .bind(submission.id),
  ]);
  return (results.at(-1)?.meta.changes ?? 0) > 0;
}

/**
 * The on-success step for a set of accepted submissions (spec §3.3, §3.4): one
 * implicit `Email/set` through the ordinary `emailSet` rules, then a reveal of
 * every Sent row the alias didn't take over. Idempotent — submissions already
 * `applied` are never selected, and every batch is guarded.
 *
 * Only the alias is one batch with its own marker (plan Decision 1); draft
 * updates and destroys run through `emailSet` first and are idempotent, so a
 * crash that makes recovery replay them lands on the same state.
 */
export async function applyOnSuccessStep(input: {
  db: DrizzleD1Database<any>;
  allowed: AllowedInboxes;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  user: any;
  ctx: JmapMethodContext;
  submissionIds: string[];
  emitResponse: boolean;
}): Promise<{ name: string; result: Record<string, unknown> } | null> {
  const { db, allowed, user, ctx } = input;
  if (input.submissionIds.length === 0) return null;
  const userId: string = user.id;
  const accountId = publicAccountId(userId);
  // Chunked: D1 binds at most 100 parameters per statement, and one call may
  // accept up to maxObjectsInSet submissions.
  const pending: PendingSubmission[] = [];
  for (let start = 0; start < input.submissionIds.length; start += 90) {
    pending.push(
      ...(await db
        .select()
        .from(jmapSubmissions)
        .where(
          and(
            inArray(
              jmapSubmissions.id,
              input.submissionIds.slice(start, start + 90),
            ),
            eq(jmapSubmissions.userId, userId),
            eq(jmapSubmissions.attemptState, "accepted"),
            eq(jmapSubmissions.onSuccessState, "pending"),
          ),
        )),
    );
  }

  const update: Record<string, Record<string, unknown>> = {};
  const destroy: string[] = [];
  const willDestroy: string[] = [];
  const window = new Map<string, PendingSubmission>();
  for (const submission of pending) {
    window.set(submission.draftId, submission);
    const mode = submission.onSuccessMode;
    // RFC 8621 §7.5: for the same Email, destroy wins over update.
    if (mode === "destroy" || mode === "both") {
      destroy.push(submission.emailId);
      if (mode === "both") willDestroy.push(submission.emailId);
    } else if (mode === "update" && submission.onSuccessPatchJson) {
      update[submission.emailId] = JSON.parse(
        submission.onSuccessPatchJson,
      ) as Record<string, unknown>;
    }
  }

  let response: { name: string; result: Record<string, unknown> } | null = null;
  let result: Record<string, unknown> | null = null;
  if (Object.keys(update).length > 0 || destroy.length > 0) {
    const outcome = await emailSet(
      db,
      allowed,
      userId,
      accountId,
      { accountId, update, destroy },
      ctx,
      { fileToSentWindow: window },
    );
    if (isMethodError(outcome)) {
      response = {
        name: "error",
        result: {
          type: outcome.type,
          ...(outcome.description ? { description: outcome.description } : {}),
          ...(outcome.properties ? { properties: outcome.properties } : {}),
        },
      };
    } else {
      if (willDestroy.length > 0) {
        const notUpdated =
          (outcome.notUpdated as Record<string, unknown> | null) ?? {};
        for (const id of willDestroy) notUpdated[id] = { type: "willDestroy" };
        outcome.notUpdated = notUpdated;
      }
      result = outcome;
    }
  }

  // Every outcome except the alias reveals the Sent row as its own Email. The
  // alias already set its own marker, so its reveal is a no-op.
  const now = Math.floor(Date.now() / 1000);
  for (const submission of pending) {
    await revealSubmission(ctx.env, submission, now);
  }

  if (response) return response;
  if (!input.emitResponse) return null;
  if (!result) {
    // Neither argument named an accepted submission, but the call still answers
    // with an implicit Email/set (RFC 8621 §7.5).
    const state = (await currentJmapState(db, allowed, userId)).state;
    return {
      name: "Email/set",
      result: {
        accountId,
        oldState: state,
        newState: state,
        created: null,
        updated: null,
        destroyed: null,
        notCreated: null,
        notUpdated: null,
        notDestroyed: null,
      },
    };
  }
  // The reveal writes change rows after `emailSet` read its own new state, so
  // recompute it here rather than hand out a state that is already behind.
  result.newState = (await currentJmapState(db, allowed, userId)).state;
  return { name: "Email/set", result };
}
