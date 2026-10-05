import { inArray } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { appSettings } from "../../db/app-settings.schema";
import { currentAuditActor } from "../audit/context";
import { AUDIT_ACTIONS } from "../audit/events";
import { recordAudit } from "../audit/record";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = DrizzleD1Database<any>;

export const BACKUP_KEYS = {
  enabled: "backup_enabled",
  hourUtc: "backup_hour_utc",
  keepDays: "backup_keep_days",
  lastStarted: "backup_last_started",
} as const;

export interface BackupSettings {
  /** Off until an admin turns it on. */
  enabled: boolean;
  /** The UTC hour the daily backup starts at (0–23). */
  hourUtc: number;
  /** Days a backup's files are kept. */
  keepDays: number;
  /** When the last scheduled or manual backup started (Unix seconds). */
  lastStarted: number | null;
}

export const DEFAULT_BACKUP_HOUR = 3;
export const DEFAULT_KEEP_DAYS = 14;
export const MAX_KEEP_DAYS = 365;

function integer(
  value: string | null | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  const n = Number(value);
  return value !== null &&
    value !== undefined &&
    Number.isInteger(n) &&
    n >= min &&
    n <= max
    ? n
    : fallback;
}

export async function readBackupSettings(db: Db): Promise<BackupSettings> {
  const rows = await db
    .select({ key: appSettings.key, value: appSettings.value })
    .from(appSettings)
    .where(inArray(appSettings.key, Object.values(BACKUP_KEYS)));
  const value = (key: string) => rows.find((row) => row.key === key)?.value;
  const last = Number(value(BACKUP_KEYS.lastStarted));
  return {
    enabled: value(BACKUP_KEYS.enabled) === "true",
    hourUtc: integer(value(BACKUP_KEYS.hourUtc), DEFAULT_BACKUP_HOUR, 0, 23),
    keepDays: integer(
      value(BACKUP_KEYS.keepDays),
      DEFAULT_KEEP_DAYS,
      1,
      MAX_KEEP_DAYS,
    ),
    lastStarted: Number.isFinite(last) && last > 0 ? last : null,
  };
}

async function write(db: Db, key: string, value: string): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const actor = currentAuditActor();
  await db
    .insert(appSettings)
    .values({ key, value, updatedAt: now, updatedBy: actor.actorUserId })
    .onConflictDoUpdate({
      target: appSettings.key,
      set: { value, updatedAt: now, updatedBy: actor.actorUserId },
    });
}

/** Changes the schedule, as the current actor; records what changed. */
export async function updateBackupSettings(
  db: Db,
  changes: Partial<Pick<BackupSettings, "enabled" | "hourUtc" | "keepDays">>,
): Promise<BackupSettings> {
  const before = await readBackupSettings(db);
  const changed: Record<string, { from: unknown; to: unknown }> = {};
  if (changes.enabled !== undefined && changes.enabled !== before.enabled) {
    await write(db, BACKUP_KEYS.enabled, changes.enabled ? "true" : "false");
    changed.enabled = { from: before.enabled, to: changes.enabled };
  }
  if (changes.hourUtc !== undefined && changes.hourUtc !== before.hourUtc) {
    await write(db, BACKUP_KEYS.hourUtc, String(changes.hourUtc));
    changed.hourUtc = { from: before.hourUtc, to: changes.hourUtc };
  }
  if (changes.keepDays !== undefined && changes.keepDays !== before.keepDays) {
    await write(db, BACKUP_KEYS.keepDays, String(changes.keepDays));
    changed.keepDays = { from: before.keepDays, to: changes.keepDays };
  }
  if (Object.keys(changed).length > 0) {
    await recordAudit(db, {
      action: AUDIT_ACTIONS.settingsChanged,
      targetType: "setting",
      targetId: "backups",
      summary:
        changed.enabled?.to === true
          ? "Turned on scheduled backups"
          : changed.enabled?.to === false
            ? "Turned off scheduled backups"
            : "Changed the backup schedule",
      details: changed,
    });
  }
  return readBackupSettings(db);
}

/** Records that a backup started (the schedule's guard). */
export async function markBackupStarted(db: Db, at: number): Promise<void> {
  await write(db, BACKUP_KEYS.lastStarted, String(at));
}

/**
 * When the next scheduled backup is due: the configured hour on the day
 * after the last one started, or today's when none has.
 */
export function nextBackupDue(settings: BackupSettings, now: number): number {
  const day = (seconds: number) => {
    const date = new Date(seconds * 1000);
    return Date.UTC(
      date.getUTCFullYear(),
      date.getUTCMonth(),
      date.getUTCDate(),
      settings.hourUtc,
    );
  };
  if (settings.lastStarted === null) return day(now) / 1000;
  return day(settings.lastStarted) / 1000 + 24 * 60 * 60;
}
