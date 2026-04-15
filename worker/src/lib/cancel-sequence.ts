import { eq, and, inArray } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { sequenceEnrollments } from "../db/sequence-enrollments.schema";
import { sequenceEmails } from "../db/sequence-emails.schema";

/**
 * Cancel all active sequence enrollments for a given sender.
 * Called when any email exchange occurs (inbound or outbound).
 */
export async function cancelSequencesForSender(
  db: DrizzleD1Database<any>,
  senderId: string
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);

  // Find active enrollments for this sender
  const activeEnrollments = await db
    .select({ id: sequenceEnrollments.id })
    .from(sequenceEnrollments)
    .where(
      and(
        eq(sequenceEnrollments.senderId, senderId),
        eq(sequenceEnrollments.status, "active")
      )
    );

  if (activeEnrollments.length === 0) return;

  const enrollmentIds = activeEnrollments.map((e) => e.id);

  // Cancel the enrollments
  for (const enrollmentId of enrollmentIds) {
    await db
      .update(sequenceEnrollments)
      .set({ status: "cancelled", cancelledAt: now })
      .where(eq(sequenceEnrollments.id, enrollmentId));
  }

  // Cancel pending/queued outbox emails for those enrollments
  for (const enrollmentId of enrollmentIds) {
    await db
      .update(sequenceEmails)
      .set({ status: "cancelled" })
      .where(
        and(
          eq(sequenceEmails.enrollmentId, enrollmentId),
          inArray(sequenceEmails.status, ["pending", "queued"])
        )
      );
  }
}
