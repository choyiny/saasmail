import { inArray } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { users, passkeys } from "../db/auth.schema";
import { isDevEnvironment } from "./is-dev";

// Cap admin WebSocket fanout so a deployment with many admin accounts does
// not incur unbounded DO RPCs on every inbound email. A presence-aware
// implementation (only notifying users with an active stream) would be the
// proper long-term fix; until then this keeps worst-case cost predictable.
export const MAX_ADMIN_FANOUT = 50;

/**
 * Compute the deduplicated set of user IDs that should receive a real-time
 * notification for an inbound email: users with an explicit `inbox_permissions`
 * row for the recipient, plus (up to a cap) users with role = "admin".
 *
 * Returns the target list and a flag indicating whether the admin set was
 * truncated by the cap, so the caller can log a warning.
 */
export function computeFanoutTargets(args: {
  permissionUserIds: string[];
  adminUserIds: string[];
  maxAdminFanout?: number;
}): { userIds: string[]; adminTruncated: boolean } {
  const cap = args.maxAdminFanout ?? MAX_ADMIN_FANOUT;
  const adminTruncated = args.adminUserIds.length > cap;
  const userIds = new Set<string>([
    ...args.permissionUserIds,
    ...args.adminUserIds.slice(0, cap),
  ]);
  return { userIds: [...userIds], adminTruncated };
}

// The passkey condition is skipped in development, matching `requirePasskey`.
export async function filterNotifiableUsers(
  db: DrizzleD1Database<any>,
  env: CloudflareBindings,
  userIds: string[],
): Promise<string[]> {
  if (userIds.length === 0) return [];

  const now = new Date();
  const userRows = await db
    .select({
      id: users.id,
      banned: users.banned,
      banExpires: users.banExpires,
    })
    .from(users)
    .where(inArray(users.id, userIds));

  const notBanned = userRows
    .filter((u) => !(u.banned && (!u.banExpires || u.banExpires > now)))
    .map((u) => u.id);

  if (isDevEnvironment(env) || notBanned.length === 0) return notBanned;

  const withPasskey = await db
    .select({ userId: passkeys.userId })
    .from(passkeys)
    .where(inArray(passkeys.userId, notBanned));

  const enrolled = new Set(withPasskey.map((p) => p.userId));
  return notBanned.filter((id) => enrolled.has(id));
}
