import { and, asc, eq, isNull, or, sql } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { rules } from "../../db/rules.schema";
import {
  assignConversations,
  snoozeConversations,
} from "../messages/conversation-state";
import { setMailboxMembership, setMailboxState } from "../messages/state";
import { matchConditions, type RuleMessage } from "./match";
import {
  RuleActionsSchema,
  RuleConditionsSchema,
  type RuleAction,
} from "./types";

export type RuleEvaluationInput = RuleMessage & {
  emailId: string;
  inbox: string;
  now?: number;
};

export type RuleEvaluationResult = {
  markedSpam: boolean;
  snoozed: boolean;
};

async function runAction(
  db: DrizzleD1Database<any>,
  input: RuleEvaluationInput,
  action: RuleAction,
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
    case "move_to_folder":
      await setMailboxMembership(db, allowed, null, refs, {
        add: [action.mailboxId],
      });
      return {};
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
  }
}

export async function evaluateRules(
  db: DrizzleD1Database<any>,
  input: RuleEvaluationInput,
): Promise<RuleEvaluationResult> {
  const inbox = input.inbox.trim().toLowerCase();
  const matchingRules = await db
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

  const result: RuleEvaluationResult = { markedSpam: false, snoozed: false };

  for (const rule of matchingRules) {
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

    if (!matchConditions(parsedConditions.data, input).matched) continue;

    for (const action of parsedActions.data) {
      try {
        const actionResult = await runAction(db, input, action);
        result.markedSpam ||= actionResult.markedSpam === true;
        result.snoozed ||= actionResult.snoozed === true;
      } catch (error) {
        console.warn(
          `[rules] action ${action.type} failed for rule ${rule.id}:`,
          error,
        );
      }
    }

    const now = input.now ?? Math.floor(Date.now() / 1000);
    try {
      await db
        .update(rules)
        .set({
          matchCount: sql`${rules.matchCount} + 1`,
          lastMatchedAt: now,
        })
        .where(eq(rules.id, rule.id));
    } catch (error) {
      console.warn(
        `[rules] failed to update match stats for ${rule.id}:`,
        error,
      );
    }

    if (rule.stopProcessing === 1) break;
  }

  return result;
}
