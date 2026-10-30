import { eq } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { users } from "../../db/auth.schema";
import { mailboxes } from "../../db/mailboxes.schema";
import { isInboxAllowed, resolveAllowedInboxes } from "../inbox-permissions";
import { describedFolders } from "../triage/folders";
import type { RuleAction } from "./types";

export class InvalidRuleError extends Error {
  constructor(
    message: string,
    /** A machine-readable reason, for the HTTP answer. */
    readonly code?: string,
  ) {
    super(message);
    this.name = "InvalidRuleError";
  }
}

export async function validateRuleActions(
  db: DrizzleD1Database<any>,
  input: {
    inbox: string | null;
    actions: RuleAction[];
    /**
     * Whether an `ai_file` action needs a described folder now: on create and
     * when the actions change, not when an existing rule is switched off or
     * renamed after the inbox lost its descriptions.
     */
    checkAiFolders?: boolean;
  },
): Promise<void> {
  const inbox = input.inbox?.trim().toLowerCase() ?? null;
  // A rejected message is never stored, so no other action could run on it.
  if (
    input.actions.some((action) => action.type === "reject") &&
    input.actions.length !== 1
  ) {
    throw new InvalidRuleError(
      "A reject action must be the rule's only action",
    );
  }
  const aiFilings = input.actions.filter((action) => action.type === "ai_file");
  if (aiFilings.length > 1) {
    throw new InvalidRuleError("A rule may have at most one ai_file action");
  }
  if (aiFilings.length > 0) {
    if (!inbox) {
      throw new InvalidRuleError("ai_file requires an inbox-scoped rule");
    }
    if (
      input.checkAiFolders !== false &&
      (await describedFolders(db, inbox)).length === 0
    ) {
      throw new InvalidRuleError(
        "ai_file needs at least one folder with a description in this inbox: describe what belongs in a folder first",
        "NO_AI_FOLDERS",
      );
    }
  }
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
