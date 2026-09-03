import { drizzle } from "drizzle-orm/d1";
import { schema } from "../db/schema";
import { purgeFinishedImports } from "./list-import";
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
}
