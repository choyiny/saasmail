import { sql, type SQL } from "drizzle-orm";

/**
 * The one rule for releasing a draft `queued` behind a retrying submission
 * (cleanup spec §3), shared by the request path and the recovery sweep. It is
 * true when nothing proves the message is still on its way or was accepted
 * with work still owed:
 *
 * - keep while the outbox row is `pending` (delivery retrying) or
 *   `bookkeeping_pending` (accepted, bookkeeping owed);
 * - keep while there is no outbox row, the Sent row isn't `failed`, and the
 *   on-success step is still `pending` (accepted, on-success owed);
 * - release when the holder submission is gone, the outbox row is `failed`,
 *   the Sent row is `failed` (a terminal failure or an Outbox cancel), or the
 *   on-success step is `applied`.
 *
 * `submitAttemptId` is the draft's `submit_attempt_id` column.
 */
export function queuedLockReleasableSql(submitAttemptId: SQL): SQL {
  return sql`NOT EXISTS (
    SELECT 1 FROM jmap_submissions js
     WHERE js.id = ${submitAttemptId}
       AND (
         EXISTS (
           SELECT 1 FROM outbox_emails o
            WHERE o.sent_email_id = js.sent_email_id
              AND o.status IN ('pending', 'bookkeeping_pending')
         )
         OR (
           js.on_success_state = 'pending'
           AND NOT EXISTS (
             SELECT 1 FROM outbox_emails o
              WHERE o.sent_email_id = js.sent_email_id AND o.status = 'failed'
           )
           AND NOT EXISTS (
             SELECT 1 FROM sent_emails se
              WHERE se.id = js.sent_email_id AND se.status = 'failed'
           )
         )
       )
  )`;
}
