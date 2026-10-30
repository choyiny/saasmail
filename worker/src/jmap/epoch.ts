import { AsyncLocalStorage } from "node:async_hooks";
import { eq, sql } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { appSettings } from "../db/app-settings.schema";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = DrizzleD1Database<any>;

/**
 * The instance's JMAP account epoch (`app_settings.jmap_account_epoch`, 0
 * when unset). It salts every account id and every state's fingerprint, so
 * bumping it resets every JMAP client once: a stored account id answers
 * `accountNotFound`, a stored state `cannotCalculateChanges`, and the client
 * resyncs from `/.well-known/jmap`. An inbox's conversation mode switch bumps
 * it, since `threadId` is immutable.
 */
export const JMAP_EPOCH_KEY = "jmap_account_epoch";

const storage = new AsyncLocalStorage<number>();

/** The epoch of the JMAP request being handled (0 outside one). */
export function currentJmapEpoch(): number {
  return storage.getStore() ?? 0;
}

/** Runs `fn` as part of a JMAP request under `epoch`. */
export function runWithJmapEpoch<T>(epoch: number, fn: () => T): T {
  return storage.run(epoch, fn);
}

export async function readJmapEpoch(db: Db): Promise<number> {
  const [row] = await db
    .select({ value: appSettings.value })
    .from(appSettings)
    .where(eq(appSettings.key, JMAP_EPOCH_KEY))
    .limit(1);
  const epoch = Number(row?.value ?? 0);
  return Number.isSafeInteger(epoch) && epoch >= 0 ? epoch : 0;
}

/** Moves to the next epoch, as `by`; returns it. */
export async function bumpJmapEpoch(
  db: Db,
  by: string | null,
): Promise<number> {
  const now = Math.floor(Date.now() / 1000);
  await db.run(sql`
    INSERT INTO app_settings (key, value, updated_at, updated_by)
    VALUES (${JMAP_EPOCH_KEY}, '1', ${now}, ${by})
    ON CONFLICT (key) DO UPDATE SET
      value = CAST(CAST(COALESCE(app_settings.value, '0') AS INTEGER) + 1 AS TEXT),
      updated_at = ${now},
      updated_by = ${by}
  `);
  return readJmapEpoch(db);
}
