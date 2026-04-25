import { drizzle } from "drizzle-orm/d1";
import { and, eq, gt, isNull, or, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { schema } from "../db/schema";
import { agentAssignments } from "../db/agent-assignments.schema";
import { agentDefinitions } from "../db/agent-definitions.schema";
import { agentRuns } from "../db/agent-runs.schema";
import { emails } from "../db/emails.schema";
import type { AgentRunMessage } from "./agent-processor";

export interface EmailDispatchContext {
  emailId: string;
  personId: string;
  mailbox: string;
  autoSubmitted?: string | null;
  hasListHeader: boolean;
}

type Db = ReturnType<typeof drizzle>;

/**
 * For a newly received email, find the best matching active assignment and
 * either insert a skipped_* run or enqueue the run to AGENT_QUEUE.
 * Designed to be called from ctx.waitUntil() in email-handler.ts.
 */
export async function dispatchAgentsForEmail(
  ctx: EmailDispatchContext,
  env: CloudflareBindings,
): Promise<void> {
  if (env.AGENTS_ENABLED === "false") return;

  const db = drizzle(env.DB, { schema });
  const now = Math.floor(Date.now() / 1000);

  // Find the most-specific active assignment for this mailbox + person
  const assignment = await findMatchingAssignment(
    db,
    ctx.mailbox,
    ctx.personId,
  );
  if (!assignment) return;

  // Check agent definition is active
  if (!assignment.agentIsActive) {
    await insertSkippedRun(
      db,
      assignment.id,
      ctx.emailId,
      ctx.personId,
      "skipped_inactive",
      now,
    );
    return;
  }

  // Mail-loop detection
  const autoSubmitted = ctx.autoSubmitted;
  if (autoSubmitted && autoSubmitted.toLowerCase() !== "no") {
    await insertSkippedRun(
      db,
      assignment.id,
      ctx.emailId,
      ctx.personId,
      "skipped_loop",
      now,
    );
    return;
  }
  if (ctx.hasListHeader) {
    await insertSkippedRun(
      db,
      assignment.id,
      ctx.emailId,
      ctx.personId,
      "skipped_loop",
      now,
    );
    return;
  }

  // Mode check: first_thread_reply — skip if person has sent email to this mailbox before
  if (assignment.mode === "first_thread_reply") {
    const priorEmails = await db
      .select({ id: emails.id })
      .from(emails)
      .where(
        and(
          eq(emails.personId, ctx.personId),
          eq(emails.recipient, ctx.mailbox),
        ),
      )
      .limit(2);

    // More than 1 means this is not the first email
    if (priorEmails.length > 1) {
      await insertSkippedRun(
        db,
        assignment.id,
        ctx.emailId,
        ctx.personId,
        "skipped_mode",
        now,
      );
      return;
    }
  }

  // Rate limit: count non-skipped runs in the last hour for this (assignment, person)
  const oneHourAgo = now - 3600;
  const recentRuns = await db
    .select({ id: agentRuns.id, status: agentRuns.status })
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.assignmentId, assignment.id),
        eq(agentRuns.personId, ctx.personId),
        gt(agentRuns.createdAt, oneHourAgo),
      ),
    );

  const nonSkippedCount = recentRuns.filter(
    (r) => !r.status.startsWith("skipped_"),
  ).length;
  if (nonSkippedCount >= assignment.maxRunsPerHour) {
    await insertSkippedRun(
      db,
      assignment.id,
      ctx.emailId,
      ctx.personId,
      "skipped_rate_limit",
      now,
    );
    return;
  }

  // All checks passed — insert queued run and push to AGENT_QUEUE
  const runId = nanoid();
  await db.insert(agentRuns).values({
    id: runId,
    assignmentId: assignment.id,
    emailId: ctx.emailId,
    personId: ctx.personId,
    status: "queued",
    action: null,
    sentEmailId: null,
    draftId: null,
    modelId: null,
    inputTokens: null,
    outputTokens: null,
    errorMessage: null,
    createdAt: now,
    updatedAt: now,
  });

  const message: AgentRunMessage = {
    runId,
    assignmentId: assignment.id,
    emailId: ctx.emailId,
  };
  await env.AGENT_QUEUE.send(message);
}

// ── Internals ──────────────────────────────────────────────────────────────

interface MatchedAssignment {
  id: string;
  agentId: string;
  mode: string;
  templateSlug: string;
  mailbox: string | null;
  personId: string | null;
  maxRunsPerHour: number;
  agentIsActive: boolean;
}

/**
 * Return the most specific active assignment matching the given mailbox+personId.
 * Priority: (mailbox+person) > (mailbox+*) > (*+person) > (*+*)
 */
async function findMatchingAssignment(
  db: Db,
  mailbox: string,
  personId: string,
): Promise<MatchedAssignment | null> {
  const rows = await db
    .select({
      id: agentAssignments.id,
      agentId: agentAssignments.agentId,
      mode: agentAssignments.mode,
      templateSlug: agentAssignments.templateSlug,
      mailbox: agentAssignments.mailbox,
      personId: agentAssignments.personId,
      maxRunsPerHour: agentDefinitions.maxRunsPerHour,
      agentIsActive: agentDefinitions.isActive,
    })
    .from(agentAssignments)
    .innerJoin(
      agentDefinitions,
      eq(agentAssignments.agentId, agentDefinitions.id),
    )
    .where(
      and(
        eq(agentAssignments.isActive, 1),
        or(
          and(
            eq(agentAssignments.mailbox, mailbox),
            eq(agentAssignments.personId, personId),
          ),
          and(
            eq(agentAssignments.mailbox, mailbox),
            isNull(agentAssignments.personId),
          ),
          and(
            isNull(agentAssignments.mailbox),
            eq(agentAssignments.personId, personId),
          ),
          and(
            isNull(agentAssignments.mailbox),
            isNull(agentAssignments.personId),
          ),
        ),
      ),
    );

  if (rows.length === 0) return null;

  // Sort by specificity (highest score = most specific)
  const specificity = (r: (typeof rows)[0]) =>
    (r.mailbox !== null ? 2 : 0) + (r.personId !== null ? 1 : 0);
  rows.sort((a, b) => specificity(b) - specificity(a));

  const r = rows[0];
  return {
    ...r,
    agentIsActive: !!r.agentIsActive,
  };
}

async function insertSkippedRun(
  db: Db,
  assignmentId: string,
  emailId: string,
  personId: string,
  status: string,
  now: number,
): Promise<void> {
  await db.insert(agentRuns).values({
    id: nanoid(),
    assignmentId,
    emailId,
    personId,
    status,
    action: null,
    sentEmailId: null,
    draftId: null,
    modelId: null,
    inputTokens: null,
    outputTokens: null,
    errorMessage: null,
    createdAt: now,
    updatedAt: now,
  });
}
