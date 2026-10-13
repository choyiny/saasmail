import { drizzle } from "drizzle-orm/d1";
import { schema } from "../db/schema";
import { and, eq, lt, sql } from "drizzle-orm";
import { campaigns } from "../db/campaigns.schema";
import { beginCampaignSend } from "../routers/campaigns-router";
import {
  reconcileCampaignBookkeeping,
  refreshCampaignStats,
} from "./campaign-sender";
import { purgeFinishedImports } from "./list-import";
import {
  backfillContactPersonIds,
  purgeExpiredCampaignEvents,
  purgeExpiredMemberIps,
} from "./newsletter-retention";
import { purgeExpiredAttempts } from "./subscribe-abuse";

/**
 * Hourly newsletter housekeeping.
 *
 * One entry point taking `env`, matching `processOutbox(env)` /
 * `handleScheduled(env)` so `index.ts` does not need to know how a db client is
 * built. Each task is caught independently: a failure in one sweep must not
 * prevent the others, and none of them may ever prevent mail from going out.
 */
export async function runNewsletterMaintenance(
  env: CloudflareBindings,
): Promise<void> {
  const db = drizzle(env.DB, { schema });
  const now = Math.floor(Date.now() / 1000);

  await purgeExpiredAttempts(db, now).catch((err) =>
    console.error("[cron] subscribe-attempt purge failed:", err),
  );
  await purgeFinishedImports(db, env, now).catch((err) =>
    console.error("[cron] finished-import purge failed:", err),
  );
  await runCampaignPass(db, env, now).catch((err) =>
    console.error("[cron] campaign pass failed:", err),
  );
  await purgeExpiredMemberIps(db, now).catch((err) =>
    console.error("[cron] member-IP purge failed:", err),
  );
  await purgeExpiredCampaignEvents(db, now).catch((err) =>
    console.error("[cron] campaign-event purge failed:", err),
  );
  await backfillContactPersonIds(db).catch((err) =>
    console.error("[cron] contact person backfill failed:", err),
  );
}

/** A campaign is abandoned if it has not moved in this long. */
export const STALL_SECONDS = 24 * 3600;
/** A scheduled campaign this far past its time is not fired silently. */
export const OVERDUE_SECONDS = 24 * 3600;

/**
 * The hourly campaign pass, in order.
 *
 * Reconciliation runs *before* the sweeps: a campaign whose last recipient is
 * only waiting on bookkeeping is finished, and would otherwise be marked
 * `stalled` for a problem that had already resolved itself.
 */
export async function runCampaignPass(
  db: ReturnType<typeof drizzle>,
  env: CloudflareBindings,
  now: number,
): Promise<void> {
  await reconcileCampaignBookkeeping(db, env);

  // Fire what is due. Anything under the overdue threshold still goes out —
  // being late is not a reason to drop a send.
  const due = await db
    .select({ id: campaigns.id })
    .from(campaigns)
    .where(
      and(
        eq(campaigns.status, "scheduled"),
        sql`${campaigns.scheduledAt} IS NOT NULL`,
        sql`${campaigns.scheduledAt} <= ${now}`,
        sql`${campaigns.scheduledAt} > ${now - OVERDUE_SECONDS}`,
      ),
    )
    .limit(50);
  for (const c of due) {
    const failure = await beginCampaignSend(db, env, c.id);
    if (failure !== null) {
      console.error(`[cron] scheduled send failed for ${c.id}:`, failure.error);
    }
  }

  // Too late to fire on its own. Made visible and left for a human rather than
  // silently sent (a day-old announcement may be wrong) or silently dropped.
  await db
    .update(campaigns)
    .set({ status: "overdue", updatedAt: now })
    .where(
      and(
        eq(campaigns.status, "scheduled"),
        sql`${campaigns.scheduledAt} IS NOT NULL`,
        sql`${campaigns.scheduledAt} <= ${now - OVERDUE_SECONDS}`,
      ),
    );

  // Stuck mid-flight: surfaced with a Retry action rather than left looking
  // like it is still working.
  await db
    .update(campaigns)
    .set({ status: "stalled", updatedAt: now })
    .where(
      and(
        sql`${campaigns.status} IN ('preparing', 'sending')`,
        lt(campaigns.updatedAt, now - STALL_SECONDS),
      ),
    );

  // Advisory cache only; nothing reads it for a correctness decision.
  const recent = await db
    .select({ id: campaigns.id })
    .from(campaigns)
    .where(sql`${campaigns.updatedAt} >= ${now - 48 * 3600}`)
    .limit(100);
  for (const c of recent) {
    await refreshCampaignStats(db, c.id);
  }
}
