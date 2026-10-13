import { sql } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";

type Db = DrizzleD1Database<any>;

/**
 * Retention windows, as concrete numbers rather than "indefinite".
 *
 * Every sweep below is bounded: one cron tick removes at most one batch, and
 * the next tick continues. An unbounded `DELETE` over thirteen months of
 * engagement events on a large instance is exactly the statement that times
 * out and then never succeeds on any subsequent tick either.
 */
export const IP_RETENTION_SECONDS = 30 * 24 * 3600;
export const EVENT_RETENTION_SECONDS = 13 * 30 * 24 * 3600;

const BATCH = 500;

/**
 * Clear the submission IP from memberships older than the window.
 *
 * The membership row stays — it is the consent record, and deleting it would
 * destroy the answer to "why do we have this address?". Only the raw IP goes.
 */
export async function purgeExpiredMemberIps(
  db: Db,
  now: number,
): Promise<number> {
  const cutoff = now - IP_RETENTION_SECONDS;
  const result = await db.run(sql`
    UPDATE list_members SET submitted_ip = NULL
    WHERE id IN (
      SELECT id FROM list_members
      WHERE submitted_ip IS NOT NULL AND created_at < ${cutoff}
      LIMIT ${BATCH}
    )
  `);
  return Number(result.meta?.changes ?? 0);
}

/** Drop engagement events past the window, one bounded batch per tick. */
export async function purgeExpiredCampaignEvents(
  db: Db,
  now: number,
): Promise<number> {
  const cutoff = now - EVENT_RETENTION_SECONDS;
  const result = await db.run(sql`
    DELETE FROM campaign_events
    WHERE id IN (
      SELECT id FROM campaign_events
      WHERE occurred_at < ${cutoff}
      LIMIT ${BATCH}
    )
  `);
  return Number(result.meta?.changes ?? 0);
}

/**
 * Link subscribers who have since become real correspondents.
 *
 * `contacts.personId` is a cache, and the campaign path deliberately never
 * creates a `people` row — a 10,000-address blast would otherwise bury real
 * correspondents in a list ordered by last contact. So the link is made here,
 * after the fact, for subscribers who turn up in `people` on their own (they
 * emailed in, or received transactional mail).
 *
 * Bounded like the sweeps above: a first run after an import has thousands of
 * candidates, and it is not urgent work.
 */
export async function backfillContactPersonIds(db: Db): Promise<number> {
  const result = await db.run(sql`
    UPDATE contacts
    SET person_id = (
      SELECT p.id FROM people p
      WHERE lower(p.email) = lower(contacts.email)
      LIMIT 1
    )
    WHERE id IN (
      SELECT c.id FROM contacts c
      WHERE c.person_id IS NULL
        AND EXISTS (
          SELECT 1 FROM people p WHERE lower(p.email) = lower(c.email)
        )
      LIMIT ${BATCH}
    )
  `);
  return Number(result.meta?.changes ?? 0);
}
