import { sql, type SQL } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";

/**
 * Deleting a scheduled message (JMAP delayed send) before it goes out cancels
 * it, with the same atomic rule as a cancel: only while it is still
 * `scheduled` and `pending`. Call it before deleting the Sent rows, with a
 * condition on `sent_emails` naming them.
 */
export async function cancelScheduledSendsFor(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: DrizzleD1Database<any>,
  sentRows: SQL,
): Promise<void> {
  await db.run(sql`
    UPDATE jmap_submissions SET undo_status = 'canceled'
     WHERE attempt_state = 'scheduled' AND undo_status = 'pending'
       AND sent_email_id IN (SELECT id FROM sent_emails WHERE ${sentRows})
  `);
}
