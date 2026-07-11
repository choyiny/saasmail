import { and, eq, inArray } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { sequenceEmails } from "../db/sequence-emails.schema";
import { sequenceEnrollments } from "../db/sequence-enrollments.schema";

/**
 * Steps in these statuses still count as outstanding work — `retrying`
 * included, so an enrollment isn't marked completed while the outbox is
 * still re-attempting one of its steps.
 */
const OUTSTANDING_STATUSES = ["pending", "queued", "retrying"];

/** Mark the enrollment completed once no outstanding steps remain. */
export async function completeEnrollmentIfDone(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: DrizzleD1Database<any>,
  enrollmentId: string,
): Promise<void> {
  const remaining = await db
    .select({ id: sequenceEmails.id })
    .from(sequenceEmails)
    .where(
      and(
        eq(sequenceEmails.enrollmentId, enrollmentId),
        inArray(sequenceEmails.status, OUTSTANDING_STATUSES),
      ),
    )
    .limit(1);

  if (remaining.length === 0) {
    await db
      .update(sequenceEnrollments)
      .set({ status: "completed" })
      .where(eq(sequenceEnrollments.id, enrollmentId));
  }
}
