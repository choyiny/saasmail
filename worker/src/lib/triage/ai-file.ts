import { eq } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { APICallError, generateText, type LanguageModel } from "ai";
import { inboxPermissions } from "../../db/inbox-permissions.schema";
import { users } from "../../db/auth.schema";
import {
  selectModel,
  type AgentModelEnv,
  type SelectedAgentModel,
} from "../agent/provider";
import { queryMessages } from "../messages/query";
import {
  MessageStateAccessError,
  setMailboxMembership,
  setMailboxState,
} from "../messages/state";
import { MAX_ADMIN_FANOUT, computeFanoutTargets } from "../notification-fanout";
import { describedFolders } from "./folders";
import { buildFilingPrompt, parseFilingAnswer } from "./prompt";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = DrizzleD1Database<any>;

/** A queued request to file one received message with a model. */
export type AiFileMessage = {
  type: "ai_file";
  emailId: string;
  inbox: string;
  /** The rule that asked, or null when a person did (POST /api/messages/ai-file). */
  ruleId: string | null;
  archiveWhenFiled: boolean;
};

const FILING_TIMEOUT_MS = 30_000;
const FILING_OUTPUT_TOKENS = 200;

/** As for suggested replies (D38): no reasoning, so the answer is the text. */
const NO_REASONING_OPTIONS = {
  reasoning: "none" as const,
  providerOptions: {
    "workers-ai": {
      chat_template_kwargs: { enable_thinking: false },
    },
  },
};

/**
 * The model that files mail: the agent's provider, with `TRIAGE_MODEL`
 * naming the model when set, so a cheap model can file while a strong one
 * chats.
 */
export function triageModel(
  env: AgentModelEnv & { TRIAGE_MODEL?: string },
): SelectedAgentModel {
  return selectModel({
    ...env,
    AGENT_MODEL: env.TRIAGE_MODEL?.trim() || env.AGENT_MODEL,
  });
}

/**
 * Files one received message into the folders of its inbox that the model
 * picks from their descriptions, and archives it too when asked and it was
 * filed. Returns the folder ids added. A message that is gone, in Junk or
 * Trash, an inbox with no described folder or no model configured: nothing.
 * A model error the provider may recover from throws (the queue retries,
 * after a delay); one it will not (an unknown model) and an answer that names
 * no known folder change nothing.
 */
export async function fileWithAi(
  db: Db,
  env: CloudflareBindings & AgentModelEnv & { TRIAGE_MODEL?: string },
  job: AiFileMessage,
  modelOverride?: LanguageModel,
): Promise<string[]> {
  const inbox = job.inbox.trim().toLowerCase();
  const allowed = { isAdmin: false as const, inboxes: [inbox] };
  const ref = { kind: "received" as const, id: job.emailId };

  // Mail in Junk or Trash is not filed: it would show in the folder.
  const page = await queryMessages(db, allowed, {
    messageRef: ref,
    limit: 1,
    includeArchived: true,
    includeSnoozed: true,
    includeSpam: false,
    includeTrashed: false,
    withAttachments: true,
  });
  const message = page.messages[0];
  if (!message) return [];

  const folders = await describedFolders(db, inbox);
  if (folders.length === 0) return [];

  let model = modelOverride;
  if (!model) {
    const selected = triageModel(env);
    if (!selected.ok) return [];
    model = selected.model;
  }

  const { instructions, prompt } = buildFilingPrompt({
    folders,
    message: {
      from: message.from?.email ?? null,
      subject: message.subject,
      bodyText: message.bodyText,
      bodyHtml: message.bodyHtml,
      attachments: (message.attachments ?? []).map((attachment) => ({
        filename: attachment.filename,
        contentType: attachment.contentType,
      })),
    },
  });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FILING_TIMEOUT_MS);
  let answer: string;
  try {
    const result = await generateText({
      model,
      instructions,
      prompt,
      temperature: 0,
      maxOutputTokens: FILING_OUTPUT_TOKENS,
      ...NO_REASONING_OPTIONS,
      abortSignal: controller.signal,
    });
    answer = result.text;
  } catch (error) {
    // A request the provider will never accept (an unknown model, a bad key)
    // is not retried: the job ends with a warning.
    if (APICallError.isInstance(error) && !error.isRetryable) {
      console.warn(
        `[ai-file] the model refused the request for ${job.emailId}:`,
        error.message,
      );
      return [];
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }

  const add = parseFilingAnswer(
    answer,
    folders.map((folder) => folder.id),
  );
  if (add.length === 0) {
    if (!/"folders"\s*:\s*\[\s*\]/.test(answer)) {
      console.warn(
        `[ai-file] no usable answer for ${job.emailId}:`,
        JSON.stringify(answer).slice(0, 200),
      );
    }
    return [];
  }

  // Routine filing, like a rule's: no user id, so no audit row. A folder
  // deleted since it was offered ends the job; a retry would ask again.
  try {
    await setMailboxMembership(db, allowed, null, [ref], { add });
    if (job.archiveWhenFiled) {
      await setMailboxState(db, allowed, null, [ref], { archived: true });
    }
  } catch (error) {
    if (error instanceof MessageStateAccessError) {
      console.warn(`[ai-file] could not file ${job.emailId}:`, error.message);
      return [];
    }
    throw error;
  }
  await notifyMailRefresh(db, env, inbox);
  return add;
}

/**
 * Tells the open tabs of everyone who can see the inbox to reload its mail,
 * the way a new suggested reply is announced. Best-effort.
 */
async function notifyMailRefresh(
  db: Db,
  env: CloudflareBindings,
  inbox: string,
): Promise<void> {
  try {
    const [permRows, adminRows] = await Promise.all([
      db
        .select({ userId: inboxPermissions.userId })
        .from(inboxPermissions)
        .where(eq(inboxPermissions.email, inbox)),
      db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.role, "admin"))
        .limit(MAX_ADMIN_FANOUT + 1),
    ]);
    const { userIds } = computeFanoutTargets({
      permissionUserIds: permRows.map((row) => row.userId),
      adminUserIds: adminRows.map((row) => row.id),
    });
    const payload = JSON.stringify({ type: "mail_refresh", inbox });
    await Promise.allSettled(
      userIds.map((userId) =>
        env.NOTIFICATIONS_HUB.get(
          env.NOTIFICATIONS_HUB.idFromName(userId),
        ).fetch(
          new Request("http://do/realtime", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: payload,
          }),
        ),
      ),
    );
  } catch (error) {
    console.warn("[ai-file] realtime refresh failed:", error);
  }
}
