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
