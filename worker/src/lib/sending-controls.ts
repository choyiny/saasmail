import { eq, sql } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { appSettings } from "../db/app-settings.schema";
import { currentAuditActor } from "./audit/context";
import { AUDIT_ACTIONS } from "./audit/events";
import { recordAudit } from "./audit/record";
import type { EmailSender } from "./email-sender";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = DrizzleD1Database<any>;

// --- Pause -------------------------------------------------------------

export const OUTBOUND_PAUSED_KEY = "outbound_paused";
/** The provider error of a send held because sending is paused. */
export const SENDING_PAUSED_MESSAGE =
  "Outbound sending is paused by an administrator";

export interface SendingPause {
  /** Unix seconds. */
  since: number;
  byUserId: string | null;
  byLabel: string;
}

// Read at most every few seconds per database handle (a request, a queue
// batch, a cron pass), so a pass already running stops soon after a pause.
const PAUSE_CACHE_MS = 5_000;
const pauseCache = new WeakMap<
  object,
  { at: number; read: Promise<SendingPause | null> }
>();

function parsePause(value: string | null | undefined): SendingPause | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<SendingPause>;
    if (typeof parsed.since !== "number") return null;
    return {
      since: parsed.since,
      byUserId: typeof parsed.byUserId === "string" ? parsed.byUserId : null,
      byLabel: typeof parsed.byLabel === "string" ? parsed.byLabel : "",
    };
  } catch {
    // A row that does not parse still means somebody paused sending.
    return { since: 0, byUserId: null, byLabel: "" };
  }
}

/** Who paused outbound sending and when, or null while it runs. */
export function readSendingPause(db: Db): Promise<SendingPause | null> {
  const cached = pauseCache.get(db);
  if (cached && Date.now() - cached.at < PAUSE_CACHE_MS) return cached.read;
  const read = db
    .select({ value: appSettings.value })
    .from(appSettings)
    .where(eq(appSettings.key, OUTBOUND_PAUSED_KEY))
    .limit(1)
    .then((rows: { value: string | null }[]) => parsePause(rows[0]?.value));
  pauseCache.set(db, { at: Date.now(), read });
  // A failed read must not stick: the next caller reads again.
  read.catch(() => pauseCache.delete(db));
  return read;
}

export async function isSendingPaused(db: Db): Promise<boolean> {
  return (await readSendingPause(db)) !== null;
}

/**
 * Pauses or resumes outbound sending, as the current audit actor. While
 * paused every send is still recorded and held in the outbox; nothing is
 * refused or lost. Returns whether anything changed.
 */
export async function setSendingPaused(
  db: Db,
  paused: boolean,
): Promise<{ changed: boolean; pause: SendingPause | null }> {
  const before = await readSendingPause(db);
  pauseCache.delete(db);
  if (paused === (before !== null)) return { changed: false, pause: before };

  const actor = currentAuditActor();
  const now = Math.floor(Date.now() / 1000);
  if (paused) {
    const pause: SendingPause = {
      since: now,
      byUserId: actor.actorUserId,
      byLabel: actor.actorLabel,
    };
    await db
      .insert(appSettings)
      .values({
        key: OUTBOUND_PAUSED_KEY,
        value: JSON.stringify(pause),
        updatedAt: now,
        updatedBy: actor.actorUserId,
      })
      .onConflictDoUpdate({
        target: appSettings.key,
        set: {
          value: JSON.stringify(pause),
          updatedAt: now,
          updatedBy: actor.actorUserId,
        },
      });
    await recordAudit(db, {
      action: AUDIT_ACTIONS.sendingPaused,
      targetType: "setting",
      targetId: OUTBOUND_PAUSED_KEY,
      summary: "Paused outbound sending",
    });
    return { changed: true, pause };
  }

  await db.delete(appSettings).where(eq(appSettings.key, OUTBOUND_PAUSED_KEY));
  await recordAudit(db, {
    action: AUDIT_ACTIONS.sendingResumed,
    targetType: "setting",
    targetId: OUTBOUND_PAUSED_KEY,
    summary: `Resumed outbound sending (paused since ${new Date(before!.since * 1000).toISOString()})`,
    details: { pausedSince: before!.since, pausedBy: before!.byLabel },
  });
  return { changed: true, pause: null };
}

/**
 * A provider that sends nothing: every message fails transiently with the
 * pause marker, so the outbox holds it and delivers it once sending resumes.
 */
export function pausedSender(sender: EmailSender): EmailSender {
  return {
    provider: sender.provider,
    maxAttachmentBytes: () => sender.maxAttachmentBytes(),
    maxMessageBytes: () => sender.maxMessageBytes(),
    ...(sender.recipientSupport
      ? { recipientSupport: () => sender.recipientSupport!() }
      : {}),
    async send() {
      return {
        id: null,
        error: {
          message: SENDING_PAUSED_MESSAGE,
          transient: true,
          paused: true,
        },
      };
    },
  } as EmailSender;
}

// --- Daily caps --------------------------------------------------------

export type SendChannel = "web" | "api" | "mcp" | "jmap";
export const SEND_CHANNELS: readonly SendChannel[] = [
  "web",
  "api",
  "mcp",
  "jmap",
];
export type DailySendLimits = Record<SendChannel, number | null>;

/** `null` is unlimited, `0` blocks the channel. */
export const DEFAULT_DAILY_SEND_LIMITS: DailySendLimits = {
  web: null,
  api: null,
  mcp: 200,
  jmap: null,
};

const limitKey = (channel: SendChannel) => `daily_send_limit_${channel}`;

/** A stored limit: a number, or "null" for an explicit "unlimited". */
function parseLimit(
  value: string | null | undefined,
): number | null | undefined {
  if (value === undefined || value === null) return undefined;
  if (value === "null") return null;
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 ? n : undefined;
}

export async function readDailySendLimits(db: Db): Promise<DailySendLimits> {
  const rows = await db.all<{ key: string; value: string | null }>(sql`
    SELECT key, value FROM app_settings WHERE key LIKE 'daily\\_send\\_limit\\_%' ESCAPE '\\'
  `);
  const limits = { ...DEFAULT_DAILY_SEND_LIMITS };
  for (const channel of SEND_CHANNELS) {
    const stored = parseLimit(
      rows.find((row) => row.key === limitKey(channel))?.value,
    );
    if (stored !== undefined) limits[channel] = stored;
  }
  return limits;
}

/** Changes the given channels' limits; records each change. */
export async function setDailySendLimits(
  db: Db,
  changes: Partial<DailySendLimits>,
): Promise<DailySendLimits> {
  const before = await readDailySendLimits(db);
  const actor = currentAuditActor();
  const now = Math.floor(Date.now() / 1000);
  for (const channel of SEND_CHANNELS) {
    if (!(channel in changes)) continue;
    const next = changes[channel] ?? null;
    if (next === before[channel]) continue;
    const value = next === null ? "null" : String(next);
    await db
      .insert(appSettings)
      .values({
        key: limitKey(channel),
        value,
        updatedAt: now,
        updatedBy: actor.actorUserId,
      })
      .onConflictDoUpdate({
        target: appSettings.key,
        set: { value, updatedAt: now, updatedBy: actor.actorUserId },
      });
    await recordAudit(db, {
      action: AUDIT_ACTIONS.settingsChanged,
      targetType: "setting",
      targetId: limitKey(channel),
      summary: `Set the daily ${channel} send limit to ${next === null ? "unlimited" : next}`,
      details: { key: limitKey(channel), from: before[channel], to: next },
    });
  }
  return readDailySendLimits(db);
}

/** The counted channel of the current request, or null for one not counted. */
export function currentSendChannel(): SendChannel | null {
  const channel = currentAuditActor().channel;
  return (SEND_CHANNELS as readonly string[]).includes(channel)
    ? (channel as SendChannel)
    : null;
}

export function utcDay(now: number): string {
  return new Date(now * 1000).toISOString().slice(0, 10);
}

/** Seconds from `now` to the next UTC midnight, when the counters reset. */
export function secondsToUtcMidnight(now: number): number {
  const next = new Date(now * 1000);
  next.setUTCHours(24, 0, 0, 0);
  return Math.max(1, Math.ceil(next.getTime() / 1000 - now));
}

export const DAILY_SEND_LIMIT_CODE = "DAILY_SEND_LIMIT_REACHED";

export interface DailySendReservation {
  allowed: boolean;
  /** Seconds to wait when refused; null when allowed. */
  retryAfter: number | null;
  limit: number | null;
  /** The refusal's text, for every surface; null when allowed. */
  message: string | null;
  /** Gives the slot back, for a send that then did not happen. */
  release: () => Promise<void>;
}

const noop = async () => {};

/**
 * Counts one message against the user's daily limit on a channel, before it
 * is sent. The increment and the check are one statement, so two concurrent
 * sends at the limit cannot both get under it; a refused one is taken back
 * off the count. An unlimited channel never touches the table.
 */
export async function reserveDailySend(
  db: Db,
  input: { userId: string; channel: SendChannel | null; now?: number },
): Promise<DailySendReservation> {
  const allowed: DailySendReservation = {
    allowed: true,
    retryAfter: null,
    limit: null,
    message: null,
    release: noop,
  };
  if (!input.channel) return allowed;
  const limit = (await readDailySendLimits(db))[input.channel];
  if (limit === null) return allowed;

  const now = input.now ?? Math.floor(Date.now() / 1000);
  const day = utcDay(now);
  const key = sql`user_id = ${input.userId} AND channel = ${input.channel} AND day = ${day}`;
  const [row] = await db.all<{ count: number }>(sql`
    INSERT INTO send_counters (user_id, channel, day, count)
    VALUES (${input.userId}, ${input.channel}, ${day}, 1)
    ON CONFLICT (user_id, channel, day) DO UPDATE SET count = count + 1
    RETURNING count
  `);
  if (Number(row?.count ?? 0) <= limit) {
    return {
      ...allowed,
      limit,
      release: async () => {
        try {
          await db.run(
            sql`UPDATE send_counters SET count = MAX(count - 1, 0) WHERE ${key}`,
          );
        } catch (error) {
          console.warn("[send-limit] slot not given back:", error);
        }
      },
    };
  }

  await db.run(
    sql`UPDATE send_counters SET count = MAX(count - 1, 0) WHERE ${key}`,
  );
  const message =
    limit === 0
      ? `Sending through ${input.channel} is turned off on this server by its administrator.`
      : `Daily send limit reached: ${limit} messages a day through ${input.channel}. It resets at midnight UTC.`;
  await recordLimitReachedOnce(db, input.userId, input.channel, day, limit);
  return {
    allowed: false,
    retryAfter: secondsToUtcMidnight(now),
    limit,
    message,
    release: noop,
  };
}

/** `send.limit_reached`, the first time a user hits a channel's limit in a day. */
async function recordLimitReachedOnce(
  db: Db,
  userId: string,
  channel: SendChannel,
  day: string,
  limit: number,
): Promise<void> {
  const target = `${userId}:${channel}:${day}`;
  try {
    const seen = await db.all(sql`
      SELECT 1 AS one FROM audit_events
      WHERE action = ${AUDIT_ACTIONS.sendLimitReached} AND target_id = ${target}
      LIMIT 1
    `);
    if (seen.length > 0) return;
  } catch {
    // Unknown: recording it twice beats not at all.
  }
  await recordAudit(db, {
    action: AUDIT_ACTIONS.sendLimitReached,
    targetType: "user",
    targetId: target,
    summary: `Reached the daily ${channel} send limit (${limit})`,
    details: { userId, channel, day, limit },
  });
}

/** Today's counts per channel and user, busiest first, at most 20. */
export async function readSendUsage(
  db: Db,
  day: string,
): Promise<
  { channel: string; userId: string; email: string | null; count: number }[]
> {
  const rows = await db.all<{
    channel: string;
    user_id: string;
    email: string | null;
    count: number;
  }>(sql`
    SELECT sc.channel, sc.user_id, u.email, sc.count
    FROM send_counters sc
    LEFT JOIN users u ON u.id = sc.user_id
    WHERE sc.day = ${day} AND sc.count > 0
    ORDER BY sc.count DESC, sc.user_id
    LIMIT 20
  `);
  return rows.map((row) => ({
    channel: row.channel,
    userId: row.user_id,
    email: row.email,
    count: Number(row.count),
  }));
}

/** Counters of days more than a week old; runs in the hourly chain. */
export async function pruneSendCounters(db: Db, now: number): Promise<void> {
  await db.run(
    sql`DELETE FROM send_counters WHERE day < ${utcDay(now - 7 * 24 * 60 * 60)}`,
  );
}
