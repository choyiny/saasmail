import { AsyncLocalStorage } from "node:async_hooks";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { nanoid } from "nanoid";
import { auditEvents } from "../../db/audit-events.schema";
import { currentAuditActor } from "./context";
import type { AuditAction, AuditTargetType } from "./events";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = DrizzleD1Database<any>;

export const AUDIT_SUMMARY_MAX = 300;
export const AUDIT_DETAILS_MAX_BYTES = 4096;
/** A bulk operation keeps this many refs; `count` has the real number. */
export const AUDIT_REFS_MAX = 20;
const USER_AGENT_MAX = 200;
const STRING_MAX = 500;

export interface AuditEntry {
  action: AuditAction;
  targetType?: AuditTargetType | null;
  /** Leave out for a bulk operation: put `count` and the refs in `details`. */
  targetId?: string | null;
  inbox?: string | null;
  /** One human sentence. */
  summary: string;
  /** Small JSON. Never a secret: a changed secret records only that it changed. */
  details?: Record<string, unknown> | null;
}

/**
 * Writes one audit event for the current actor. Best effort: a failed write
 * is logged and never fails the request that caused it. Hot paths need not
 * await it (hand the promise to `ctx.waitUntil`).
 */
export async function recordAudit(db: Db, entry: AuditEntry): Promise<void> {
  try {
    const actor = currentAuditActor();
    await db.insert(auditEvents).values({
      id: nanoid(),
      at: Math.floor(Date.now() / 1000),
      actorType: actor.actorType,
      actorUserId: actor.actorUserId,
      actorLabel: actor.actorLabel,
      channel: actor.channel,
      action: entry.action,
      targetType: entry.targetType ?? null,
      targetId: entry.targetId ?? null,
      inbox: entry.inbox ? entry.inbox.trim().toLowerCase() : null,
      summary: truncate(entry.summary, AUDIT_SUMMARY_MAX),
      details: serializeDetails(entry.details),
      ip: actor.ip ?? null,
      userAgent: actor.userAgent
        ? actor.userAgent.slice(0, USER_AGENT_MAX)
        : null,
    });
  } catch (err) {
    console.warn(`[audit] ${entry.action} not recorded:`, err);
  }
}

/** An event about one or many things of a kind: N messages, N conversations. */
export interface BulkAuditEntry {
  action: AuditAction;
  targetType: AuditTargetType;
  inbox?: string | null;
  /** The ids of everything affected. One id becomes the row's `target_id`. */
  refs: string[];
  /** The sentence for `count` things. */
  summary: (count: number) => string;
  details?: Record<string, unknown>;
}

const collector = new AsyncLocalStorage<BulkAuditEntry[]>();

/**
 * Writes one row for an operation on `refs`: a single ref is the row's
 * target, several are a count and the first refs in `details`. Inside
 * `collectAudit`, the row is held back and merged with its like.
 */
export async function recordBulkAudit(
  db: Db,
  entry: BulkAuditEntry,
): Promise<void> {
  if (entry.refs.length === 0) return;
  const pending = collector.getStore();
  if (pending) {
    pending.push(entry);
    return;
  }
  await writeBulk(db, entry);
}

/**
 * Runs `fn` and writes the bulk events it produced as one row per kind
 * (same action, inbox, target type and details), however many service calls
 * produced them. For callers that change one message per call in a loop: a
 * JMAP `Email/set`, a purge.
 */
export async function collectAudit<T>(
  db: Db,
  fn: () => Promise<T>,
): Promise<T> {
  // A nested collection joins the outer one, which writes at its end.
  if (collector.getStore()) return fn();
  const pending: BulkAuditEntry[] = [];
  try {
    return await collector.run(pending, fn);
  } finally {
    const merged = new Map<string, BulkAuditEntry>();
    for (const entry of pending) {
      const key = JSON.stringify([
        entry.action,
        entry.targetType,
        entry.inbox ?? null,
        entry.details ?? null,
      ]);
      const existing = merged.get(key);
      if (existing) existing.refs = [...existing.refs, ...entry.refs];
      else merged.set(key, { ...entry, refs: [...entry.refs] });
    }
    for (const entry of merged.values()) await writeBulk(db, entry);
  }
}

function writeBulk(db: Db, entry: BulkAuditEntry): Promise<void> {
  const refs = [...new Set(entry.refs)];
  return recordAudit(db, {
    action: entry.action,
    targetType: entry.targetType,
    targetId: refs.length === 1 ? refs[0] : null,
    inbox: entry.inbox ?? null,
    summary: entry.summary(refs.length),
    details:
      refs.length === 1
        ? (entry.details ?? null)
        : bulkDetails(refs, entry.details),
  });
}

/** `details` for an operation on many things: the count and the first refs. */
export function bulkDetails(
  refs: string[],
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return { ...extra, count: refs.length, refs: refs.slice(0, AUDIT_REFS_MAX) };
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

/** Arrays to their first entries and long strings cut, at any depth. */
function bounded(value: unknown): unknown {
  if (typeof value === "string") return truncate(value, STRING_MAX);
  if (Array.isArray(value)) return value.slice(0, AUDIT_REFS_MAX).map(bounded);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, bounded(entry)]),
    );
  }
  return value;
}

/**
 * The JSON stored in `details`, at most 4 KB: arrays and strings are cut
 * first, then whole keys are dropped, largest first, and the result says so.
 */
export function serializeDetails(
  details: Record<string, unknown> | null | undefined,
): string | null {
  if (!details || Object.keys(details).length === 0) return null;
  const kept = bounded(details) as Record<string, unknown>;
  let json = JSON.stringify(kept);
  if (byteLength(json) <= AUDIT_DETAILS_MAX_BYTES) return json;

  const bySize = Object.keys(kept).sort(
    (a, b) =>
      JSON.stringify(kept[b] ?? null).length -
      JSON.stringify(kept[a] ?? null).length,
  );
  kept.truncated = true;
  for (const key of bySize) {
    delete kept[key];
    json = JSON.stringify(kept);
    if (byteLength(json) <= AUDIT_DETAILS_MAX_BYTES) break;
  }
  return json;
}
