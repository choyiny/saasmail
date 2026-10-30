import type { DrizzleD1Database } from "drizzle-orm/d1";
import { AUDIT_ACTIONS } from "./events";
import { recordAudit } from "./record";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = DrizzleD1Database<any>;

/**
 * A person or the agent put someone on a list or took them off. The public
 * subscribe and unsubscribe links, imports and bounces are the subscriber's
 * or the system's own doing and are not recorded here.
 */
export function auditListMember(
  db: Db,
  change: "added" | "removed",
  member: {
    listId: string;
    listName?: string | null;
    memberId: string;
    email: string;
  },
): Promise<void> {
  const list = member.listName ? `'${member.listName}'` : "a list";
  return recordAudit(db, {
    action:
      change === "added"
        ? AUDIT_ACTIONS.listMemberAdded
        : AUDIT_ACTIONS.listMemberRemoved,
    targetType: "list",
    targetId: member.listId,
    summary:
      change === "added"
        ? `Added ${member.email} to ${list}`
        : `Removed ${member.email} from ${list}`,
    details: { memberId: member.memberId, email: member.email },
  });
}

/**
 * Someone stopped a sequence on purpose. The automatic stop that follows
 * every send and every inbound message is not an event: it would be one row
 * per message.
 */
export function auditSequenceCancelled(
  db: Db,
  cancelled: {
    personId?: string | null;
    enrollmentId?: string | null;
    sequenceId?: string | null;
    count: number;
  },
): Promise<void> {
  if (cancelled.count === 0) return Promise.resolve();
  return recordAudit(db, {
    action: AUDIT_ACTIONS.sequenceCancelled,
    targetType: "sequence",
    targetId: cancelled.sequenceId ?? null,
    summary:
      cancelled.count === 1
        ? "Cancelled a sequence enrollment"
        : `Cancelled ${cancelled.count} sequence enrollments`,
    details: {
      count: cancelled.count,
      ...(cancelled.personId ? { personId: cancelled.personId } : {}),
      ...(cancelled.enrollmentId
        ? { enrollmentId: cancelled.enrollmentId }
        : {}),
    },
  });
}
