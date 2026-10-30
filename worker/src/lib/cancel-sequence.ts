import { eq, and, inArray } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { sequenceEnrollments } from "../db/sequence-enrollments.schema";
import { sequenceEmails } from "../db/sequence-emails.schema";
import { inboxFilter, type AllowedInboxes } from "./inbox-permissions";

/**
 * Cancel all active sequence enrollments for a given person.
 * Called when any email exchange occurs (inbound or outbound).
 *
 * Agent callers pass `allowed` so a permission change made while an approval
 * is pending takes effect before cancellation. Existing automatic callers omit
 * it and retain the historical all-inboxes behavior.
 */
export async function cancelSequencesForPerson(
  db: DrizzleD1Database<any>,
  personId: string,
  allowed?: AllowedInboxes,
): Promise<number> {
  const now = Math.floor(Date.now() / 1000);
  const activeEnrollments = await db
    .select({ id: sequenceEnrollments.id })
    .from(sequenceEnrollments)
    .where(
      and(
        eq(sequenceEnrollments.personId, personId),
        eq(sequenceEnrollments.status, "active"),
        allowed
          ? inboxFilter(allowed, sequenceEnrollments.fromAddress)
          : undefined,
      ),
    );
  if (activeEnrollments.length === 0) return 0;

  const enrollmentIds = activeEnrollments.map((e) => e.id);
  for (const enrollmentId of enrollmentIds) {
    await db
      .update(sequenceEnrollments)
      .set({ status: "cancelled", cancelledAt: now })
      .where(eq(sequenceEnrollments.id, enrollmentId));
  }
  for (const enrollmentId of enrollmentIds) {
    await db
      .update(sequenceEmails)
      .set({ status: "cancelled" })
      .where(
        and(
          eq(sequenceEmails.enrollmentId, enrollmentId),
          inArray(sequenceEmails.status, ["pending", "queued"]),
        ),
      );
  }
  return enrollmentIds.length;
}
