import { ruleActor } from "../audit/actors";
import { runWithAudit } from "../audit/context";
import { and, asc, eq, isNull, or, sql } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { mailboxes } from "../../db/mailboxes.schema";
import { rules } from "../../db/rules.schema";
import {
  assignConversations,
  snoozeConversations,
} from "../messages/conversation-state";
import { setMailboxMembership, setMailboxState } from "../messages/state";
import { runAutoReply } from "./auto-reply";
import { triageModel, type AiFileMessage } from "../triage/ai-file";
import { matchConditions, type RuleMessage } from "./match";
import {
  DEFAULT_REJECT_REASON,
  RuleActionsSchema,
  RuleConditionsSchema,
  type RuleAction,
} from "./types";

type RuleRow = typeof rules.$inferSelect;

/** A rule whose conditions matched a message, with its parsed actions. */
export type MatchedRule = {
  rule: RuleRow;
  actions: RuleAction[];
};

export type RuleEvaluationInput = RuleMessage & {
  emailId: string;
  inbox: string;
  now?: number;
};

export type RuleEvaluationResult = {
  markedSpam: boolean;
  snoozed: boolean;
};

export type RuleEvaluationRuntime = {
  env: CloudflareBindings;
  ctx: Pick<ExecutionContext, "waitUntil">;
};

async function runAction(
  db: DrizzleD1Database<any>,
  input: RuleEvaluationInput,
  action: RuleAction,
  ruleId: string,
  runtime?: RuleEvaluationRuntime,
): Promise<Partial<RuleEvaluationResult>> {
  const inbox = input.inbox.trim().toLowerCase();
  const allowed = { isAdmin: false as const, inboxes: [inbox] };
  const refs = [{ kind: "received" as const, id: input.emailId }];

  switch (action.type) {
    case "archive":
      await setMailboxState(db, allowed, null, refs, { archived: true });
      return {};
    case "mark_spam":
      await setMailboxState(db, allowed, null, refs, { spam: true });
      return { markedSpam: true };
    case "move_to_folder": {
      const [mailbox] = await db
        .select({ id: mailboxes.id })
        .from(mailboxes)
        .where(
          and(eq(mailboxes.id, action.mailboxId), eq(mailboxes.inbox, inbox)),
        )
        .limit(1);
      if (!mailbox) {
        console.warn(
          `[rules] move_to_folder skipped for rule ${ruleId}: mailbox ${action.mailboxId} is missing`,
        );
        return {};
      }
      await setMailboxMembership(db, allowed, null, refs, {
        add: [action.mailboxId],
      });
      return {};
    }
    case "snooze": {
      const now = input.now ?? Math.floor(Date.now() / 1000);
      await snoozeConversations(
        db,
        allowed,
        null,
        refs,
        now + action.hours * 60 * 60,
      );
      return { snoozed: true };
    }
    case "assign":
      await assignConversations(db, allowed, null, refs, action.userId);
      return {};
    case "ai_file": {
      // Filed later, from the queue: the handler never waits on a model.
      if (!runtime) {
        console.log(
          `[ai-file] skipped rule ${ruleId} for ${input.emailId}: runtime unavailable`,
        );
        return {};
      }
      if (!triageModel(runtime.env).ok) {
        console.log(
          `[ai-file] skipped rule ${ruleId} for ${input.emailId}: no model configured`,
        );
        return {};
      }
      const job: AiFileMessage = {
        type: "ai_file",
        emailId: input.emailId,
        inbox,
        ruleId,
        archiveWhenFiled: action.archiveWhenFiled === true,
      };
      runtime.ctx.waitUntil(
        runtime.env.EMAIL_QUEUE.send(job).catch((error: unknown) => {
          console.warn(
            `[ai-file] could not queue rule ${ruleId} for ${input.emailId}:`,
            error,
          );
        }),
      );
      return {};
    }
    case "reject":
      // Acts before storage (see rejectionOf); a stored message is past it.
      return {};
    case "auto_reply":
      if (!runtime) {
        console.log(
          `[auto-reply] skipped rule ${ruleId} for ${input.emailId}: runtime unavailable`,
        );
        return {};
      }
      runtime.ctx.waitUntil(
        runAutoReply(db, runtime.env, {
          ruleId,
          emailId: input.emailId,
          inbox,
          subject: action.subject,
          bodyText: action.bodyText,
          now: input.now,
        }).catch((error) => {
          console.warn(
            `[auto-reply] failed rule ${ruleId} for ${input.emailId}:`,
            error,
          );
        }),
      );
      return {};
  }
}

/**
 * Which enabled rules match a message, in order, stopping after the first
 * matching rule with "stop processing". Reads the parsed message only and
 * writes nothing, so it can run before the message is stored. Malformed
 * rules are skipped with a warning.
 */
export async function selectMatchingRules(
  db: DrizzleD1Database<any>,
  input: { inbox: string; message: RuleMessage },
): Promise<MatchedRule[]> {
  const inbox = input.inbox.trim().toLowerCase();
  const candidates = await db
    .select()
    .from(rules)
    .where(
      and(
        eq(rules.enabled, 1),
        eq(rules.trigger, "message.received"),
        or(isNull(rules.inbox), sql`lower(${rules.inbox}) = ${inbox}`),
      ),
    )
    .orderBy(asc(rules.position), asc(rules.id));

  const matched: MatchedRule[] = [];
  for (const rule of candidates) {
    const parsedConditions = RuleConditionsSchema.safeParse(rule.conditions);
    const parsedActions = RuleActionsSchema.safeParse(rule.actions);
    if (!parsedConditions.success || !parsedActions.success) {
      console.warn(`[rules] skipping malformed rule ${rule.id}:`, {
        conditions: parsedConditions.success
          ? undefined
          : parsedConditions.error,
        actions: parsedActions.success ? undefined : parsedActions.error,
      });
      continue;
    }
    if (!matchConditions(parsedConditions.data, input.message).matched) {
      continue;
    }
    matched.push({ rule, actions: parsedActions.data });
    if (rule.stopProcessing === 1) break;
  }
  return matched;
}

/** The first matched rule that rejects the message, with its reason. */
export function rejectionOf(
  matched: MatchedRule[],
): { rule: RuleRow; reason: string } | null {
  for (const entry of matched) {
    const reject = entry.actions.find((action) => action.type === "reject");
    if (reject && reject.type === "reject") {
      return {
        rule: entry.rule,
        reason: reject.reason ?? DEFAULT_REJECT_REASON,
      };
    }
  }
  return null;
}

/** Counts a match on the rule; a failure is logged, never thrown. */
export async function recordRuleMatch(
  db: DrizzleD1Database<any>,
  ruleId: string,
  now: number,
): Promise<void> {
  try {
    await db
      .update(rules)
      .set({
        matchCount: sql`${rules.matchCount} + 1`,
        lastMatchedAt: now,
      })
      .where(eq(rules.id, ruleId));
  } catch (error) {
    console.warn(`[rules] failed to update match stats for ${ruleId}:`, error);
  }
}

/**
 * Runs the actions of rules already selected for a stored message, each
 * action on its own (one failing does not stop the others), as the rule.
 */
export async function runMatchedRules(
  db: DrizzleD1Database<any>,
  matched: MatchedRule[],
  input: RuleEvaluationInput,
  runtime?: RuleEvaluationRuntime,
): Promise<RuleEvaluationResult> {
  const result: RuleEvaluationResult = { markedSpam: false, snoozed: false };

  for (const { rule, actions } of matched) {
    // What the rule's actions do (a send, a junk mark) is audited as the
    // rule, by name. An auto-reply started here keeps that actor even though
    // it finishes later under waitUntil.
    await runWithAudit(ruleActor(rule), async () => {
      for (const action of actions) {
        try {
          const actionResult = await runAction(
            db,
            input,
            action,
            rule.id,
            runtime,
          );
          result.markedSpam ||= actionResult.markedSpam === true;
          result.snoozed ||= actionResult.snoozed === true;
        } catch (error) {
          console.warn(
            `[rules] action ${action.type} failed for rule ${rule.id}:`,
            error,
          );
        }
      }
    });

    await recordRuleMatch(
      db,
      rule.id,
      input.now ?? Math.floor(Date.now() / 1000),
    );
  }

  return result;
}

/** Selects and runs the rules for a stored message in one call. */
export async function evaluateRules(
  db: DrizzleD1Database<any>,
  input: RuleEvaluationInput,
  runtime?: RuleEvaluationRuntime,
): Promise<RuleEvaluationResult> {
  const matched = await selectMatchingRules(db, {
    inbox: input.inbox,
    message: input,
  });
  return runMatchedRules(db, matched, input, runtime);
}
