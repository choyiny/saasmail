import { sql, type SQL } from "drizzle-orm";

/**
 * True for a JMAP-originated Sent row whose submission's on-success step has
 * not run yet (spec §3.4, §5). JMAP must not see it: the step decides whether
 * it appears as its own Email (`S…`) or as the draft it was sent from (`D…`).
 * The web UI never uses this; a sent message is sent.
 */
export function jmapHiddenSentSql(sentIdColumn: SQL): SQL {
  return sql`EXISTS (
    SELECT 1 FROM jmap_submissions js
    WHERE js.sent_email_id = ${sentIdColumn}
      AND js.on_success_state = 'pending'
  )`;
}
