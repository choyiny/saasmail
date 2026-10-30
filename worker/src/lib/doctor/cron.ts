import { eq } from "drizzle-orm";
import { appSettings } from "../../db/app-settings.schema";
import type { Check, Db } from "./types";

/** `app_settings` key: when `scheduledChain()` last ran to its end (Unix seconds). */
export const LAST_CRON_AT_KEY = "last_cron_at";

const STALE_AFTER = 2 * 60 * 60;

/** The last step of every cron tick's chain: one upsert. */
export async function recordCronTick(db: Db, now: number): Promise<void> {
  const value = String(now);
  await db
    .insert(appSettings)
    .values({ key: LAST_CRON_AT_KEY, value, updatedAt: now, updatedBy: null })
    .onConflictDoUpdate({
      target: appSettings.key,
      set: { value, updatedAt: now },
    });
}

export const cronChecks: Check[] = [
  {
    id: "cron.last_tick",
    group: "cron",
    mandatory: false,
    async run({ db, now }) {
      const rows = await db
        .select({ value: appSettings.value })
        .from(appSettings)
        .where(eq(appSettings.key, LAST_CRON_AT_KEY))
        .limit(1);
      const at = Number(rows[0]?.value);
      const hint =
        "The cron trigger is missing or the Worker errors on every tick.";
      if (!Number.isFinite(at) || at <= 0) {
        return {
          status: "fail",
          summary:
            "No cron tick recorded yet (the first one runs within an hour of the first deploy).",
          hint,
        };
      }
      const minutes = Math.floor((now - at) / 60);
      if (now - at > STALE_AFTER) {
        return {
          status: "fail",
          summary: `The last cron tick ran ${Math.floor(minutes / 60)} h ago.`,
          hint,
        };
      }
      return {
        status: "pass",
        summary: `The last cron tick ran ${Math.max(0, minutes)} min ago.`,
      };
    },
  },
];
