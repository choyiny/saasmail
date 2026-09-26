import { eq } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { users } from "../../db/auth.schema";
import { mailboxes } from "../../db/mailboxes.schema";
import { isInboxAllowed, resolveAllowedInboxes } from "../inbox-permissions";
import type { RuleAction } from "./types";

export class InvalidRuleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidRuleError";
  }
}

export async function validateRuleActions(
  db: DrizzleD1Database<any>,
  input: { inbox: string | null; actions: RuleAction[] },
): Promise<void> {
  const inbox = input.inbox?.trim().toLowerCase() ?? null;
  const autoReplies = input.actions.filter(
    (action) => action.type === "auto_reply",
  );
  if (autoReplies.length > 1) {
    throw new InvalidRuleError("A rule may have at most one auto_reply action");
  }
  if (autoReplies.length > 0 && !inbox) {
    throw new InvalidRuleError("auto_reply requires an inbox-scoped rule");
  }

  for (const action of input.actions) {
    if (action.type === "move_to_folder") {
      if (!inbox) {
        throw new InvalidRuleError(
          "move_to_folder requires an inbox-scoped rule",
        );
      }
      const [mailbox] = await db
        .select({ inbox: mailboxes.inbox })
        .from(mailboxes)
        .where(eq(mailboxes.id, action.mailboxId))
        .limit(1);
      if (!mailbox || mailbox.inbox.trim().toLowerCase() !== inbox) {
        throw new InvalidRuleError(
          "move_to_folder mailbox must belong to the rule inbox",
        );
      }
    }

    if (action.type === "assign") {
      if (!inbox) {
        throw new InvalidRuleError("assign requires an inbox-scoped rule");
      }
      const [user] = await db
        .select({ id: users.id, role: users.role })
        .from(users)
        .where(eq(users.id, action.userId))
        .limit(1);
      if (!user) throw new InvalidRuleError("Assignee does not exist");

      const allowed = await resolveAllowedInboxes(db, user);
      if (!isInboxAllowed(allowed, inbox)) {
        throw new InvalidRuleError(
          "Assignee does not have access to rule inbox",
        );
      }
    }
  }
}
