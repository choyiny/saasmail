import { and, eq } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { nanoid } from "nanoid";
import { people } from "../db/people.schema";
import { sequenceEmails } from "../db/sequence-emails.schema";
import { sequenceEnrollments } from "../db/sequence-enrollments.schema";
import { sequences } from "../db/sequences.schema";
import { assertInboxAllowed, type AllowedInboxes } from "./inbox-permissions";
import { isDemoMode } from "./is-dev";
import type { TemplateVariables } from "./interpolate";
import type { SequenceEmailMessage } from "./sequence-processor";

export type EnrollSequenceInput = {
  personId?: string;
  personEmail?: string;
  fromAddress: string;
  variables: TemplateVariables;
  skipSteps: number[];
  delayOverrides: Record<string, number>;
};

export type EnrollSequenceParams = {
  db: DrizzleD1Database<any>;
  env: CloudflareBindings;
  sequenceId: string;
  input: EnrollSequenceInput;
  allowed: AllowedInboxes;
};

export type EnrollmentRecord = {
  id: string;
  sequenceId: string;
  personId: string;
  fromAddress: string;
  status: string;
  variables: TemplateVariables;
  enrolledAt: number;
  cancelledAt: number | null;
};

export type ScheduledEmailRecord = {
  id: string;
  enrollmentId: string;
  stepOrder: number;
  templateSlug: string;
  scheduledAt: number;
  status: string;
  sentAt: number | null;
  sentEmailId: string | null;
};

export type EnrollSequenceSuccess = {
  ok: true;
  enrollment: EnrollmentRecord;
  scheduledEmails: ScheduledEmailRecord[];
};

export type EnrollSequenceFailure = {
  ok: false;
  code:
    | "SEQUENCE_NOT_FOUND"
    | "PERSON_NOT_FOUND"
    | "ALREADY_ENROLLED"
    | "NO_STEPS_REMAINING";
  message: string;
};

export type EnrollSequenceResult =
  | EnrollSequenceSuccess
  | EnrollSequenceFailure;

/** Schedules land on hour boundaries so batched steps share a cron tick. */
function snapToNextHour(timestampSeconds: number): number {
  const ms = timestampSeconds * 1000;
  const date = new Date(ms);
  date.setMinutes(0, 0, 0);
  date.setHours(date.getHours() + 1);
  return Math.floor(date.getTime() / 1000);
}

/**
 * Enroll a person into a sequence, computing every scheduled send time upfront.
 *
 * Failure modes callers must surface are returned rather than thrown so this
 * can back both the HTTP route and the MCP tool; only the inbox permission
 * check throws (HTTPException), matching the routers' existing behavior.
 */
export async function enrollPersonInSequence(
  params: EnrollSequenceParams,
): Promise<EnrollSequenceResult> {
  const { db, env, sequenceId, input, allowed } = params;
  const {
    personId: inputPersonId,
    personEmail,
    fromAddress,
    variables,
    skipSteps,
    delayOverrides,
  } = input;
  const now = Math.floor(Date.now() / 1000);

  // Check inbox permission before any other work
  assertInboxAllowed(allowed, fromAddress);

  // Validate sequence exists
  const seqRows = await db
    .select()
    .from(sequences)
    .where(eq(sequences.id, sequenceId))
    .limit(1);

  if (seqRows.length === 0) {
    return {
      ok: false,
      code: "SEQUENCE_NOT_FOUND",
      message: "Sequence not found",
    };
  }

  // Resolve person: by ID, or by email (create if needed)
  let personId: string;
  if (inputPersonId) {
    const personRows = await db
      .select({ id: people.id })
      .from(people)
      .where(eq(people.id, inputPersonId))
      .limit(1);
    if (personRows.length === 0) {
      return {
        ok: false,
        code: "PERSON_NOT_FOUND",
        message: "Person not found",
      };
    }
    personId = inputPersonId;
  } else {
    // personEmail is guaranteed by the schema refinement
    const existing = await db
      .select({ id: people.id })
      .from(people)
      .where(eq(people.email, personEmail!))
      .limit(1);

    if (existing.length > 0) {
      personId = existing[0].id;
    } else {
      personId = nanoid();
      await db.insert(people).values({
        id: personId,
        email: personEmail!,
        name: null,
        lastEmailAt: now,
        unreadCount: 0,
        totalCount: 0,
        createdAt: now,
        updatedAt: now,
      });
    }
  }

  // Check person is not already in an active sequence
  const existingEnrollment = await db
    .select({ id: sequenceEnrollments.id })
    .from(sequenceEnrollments)
    .where(
      and(
        eq(sequenceEnrollments.personId, personId),
        eq(sequenceEnrollments.status, "active"),
      ),
    )
    .limit(1);

  if (existingEnrollment.length > 0) {
    return {
      ok: false,
      code: "ALREADY_ENROLLED",
      message: "Person is already in an active sequence",
    };
  }

  const steps: Array<{
    order: number;
    templateSlug: string;
    delayHours: number;
  }> = JSON.parse(seqRows[0].steps);

  // Filter out skipped steps
  const activeSteps = steps.filter((s) => !skipSteps.includes(s.order));

  if (activeSteps.length === 0) {
    return {
      ok: false,
      code: "NO_STEPS_REMAINING",
      message: "At least one step must remain after skipping",
    };
  }

  // Create enrollment
  const enrollmentId = nanoid();
  const enrollment = {
    id: enrollmentId,
    sequenceId,
    personId,
    fromAddress,
    status: "active",
    variables: JSON.stringify(variables),
    enrolledAt: now,
    cancelledAt: null,
  };
  await db.insert(sequenceEnrollments).values(enrollment);

  // Create outbox emails with computed schedule
  // First email sends immediately; subsequent emails accumulate delays from
  // snapToNextHour(now) so each step fires delayHours after the previous one.
  const baseTime = snapToNextHour(now);
  let cumulativeHours = 0;
  const scheduledEmails = activeSteps.map((step, index) => {
    const delayHours =
      step.order.toString() in delayOverrides
        ? delayOverrides[step.order.toString()]
        : step.delayHours;

    const isFirstEmail = index === 0;
    if (!isFirstEmail) cumulativeHours += delayHours;
    return {
      id: nanoid(),
      enrollmentId,
      stepOrder: step.order,
      templateSlug: step.templateSlug,
      scheduledAt: isFirstEmail ? now : baseTime + cumulativeHours * 3600,
      // In demo mode there is no queue/cron to advance "queued" emails, so
      // leave everything as "pending" — the records exist for the UI to show
      // but nothing is dispatched.
      status: isDemoMode(env) ? "pending" : isFirstEmail ? "queued" : "pending",
      sentAt: null,
      sentEmailId: null,
    };
  });

  await db.insert(sequenceEmails).values(scheduledEmails);

  // Immediately queue the first email so it sends without waiting for cron.
  // Skipped in demo mode where no EMAIL_QUEUE binding exists.
  if (!isDemoMode(env)) {
    const firstEmail = scheduledEmails[0];
    const message: SequenceEmailMessage = { sequenceEmailId: firstEmail.id };
    await env.EMAIL_QUEUE.send(message);
  }

  return {
    ok: true,
    enrollment: { ...enrollment, variables },
    scheduledEmails,
  };
}
