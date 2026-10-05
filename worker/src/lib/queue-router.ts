import { createDb } from "../db/client";
import { createEmailSender } from "./email-sender";
import { isDemoMode } from "./is-dev";
import {
  processSequenceEmail,
  type SequenceEmailMessage,
} from "./sequence-processor";
import { runListImportPage, type ListImportMessage } from "./list-import";
import {
  runCampaignFanOutPage,
  sendCampaignRecipient,
  type CampaignFanOutMessage,
  type CampaignSendMessage,
} from "./campaign-sender";
import { runSuggestedReply } from "./agent/suggest-reply";
import {
  releaseOverdueSubmissions,
  releaseScheduledSubmission,
  type ReleaseMessage,
} from "../jmap/release";
import { drainHeldOutbox, type OutboxDrainMessage } from "./outbox";
import { fileWithAi, type AiFileMessage } from "./triage/ai-file";
import { SliceBusyError } from "./jobs/slices";
import {
  failBackup,
  runBackupStep,
  type BackupStepMessage,
} from "./backup/run";
import {
  runMailImportSlice,
  skipStuckMessage,
  type MailImportMessage,
} from "./import/mail-import";
import {
  failThreadBackfill,
  runThreadBackfillSlice,
  type ThreadBackfillMessage,
} from "./messages/thread-backfill";
import {
  failMailExport,
  runMailExportSlice,
  type MailExportMessage,
} from "./export/mail-export";

/**
 * Everything that can arrive on `EMAIL_QUEUE`.
 *
 * The queue is shared rather than split per feature (a dedicated campaign queue
 * is a wrangler infra change, deferred), so the consumer has to discriminate.
 *
 * `SequenceEmailMessage` is deliberately *not* required to carry a `type`: it
 * predates this union and its producer enqueued a bare `{ sequenceEmailId }`.
 * See `classifyQueueMessage`.
 */
export type SuggestReplyMessage = {
  type: "suggest_reply";
  emailId: string;
};

export type QueueMessageBody =
  | SequenceEmailMessage
  | ListImportMessage
  | CampaignFanOutMessage
  | CampaignSendMessage
  | SuggestReplyMessage
  | ReleaseMessage
  | OutboxDrainMessage
  | AiFileMessage
  | MailExportMessage
  | MailImportMessage
  | BackupStepMessage
  | ThreadBackfillMessage;

export const SUGGEST_REPLY_MAX_ATTEMPTS = 3;
const SUGGEST_REPLY_RETRY_DELAY_SECONDS = 30;
/** A slice that failed this often fails its export or import. */
export const MAIL_EXPORT_MAX_ATTEMPTS = 3;

export type QueueMessageKind =
  | "sequence_email"
  | "list_import"
  | "campaign_fan_out"
  | "campaign_send"
  | "suggest_reply"
  | "jmap_submission_release"
  | "outbox_drain"
  | "ai_file"
  | "mail_export"
  | "mail_import"
  | "backup_step"
  | "thread_backfill"
  | "unknown";

/**
 * Decide what a message is.
 *
 * The important case is the untagged one. When the consumer that understands
 * `type` is deployed, messages enqueued by the previous version are already in
 * flight carrying no `type` at all. Those are real sequence mail, so an absent
 * discriminant must mean "sequence email", not "unrecognised" — otherwise a
 * deploy silently drops whatever was queued at that moment.
 *
 * Kept as a pure function so that rule is testable without a queue.
 */
export function classifyQueueMessage(body: unknown): QueueMessageKind {
  if (typeof body !== "object" || body === null) return "unknown";
  const b = body as Record<string, unknown>;

  if (b.type === undefined) {
    // Legacy shape: only ever `{ sequenceEmailId }`.
    return typeof b.sequenceEmailId === "string" ? "sequence_email" : "unknown";
  }
  if (b.type === "sequence_email") {
    return typeof b.sequenceEmailId === "string" ? "sequence_email" : "unknown";
  }
  if (b.type === "list_import") {
    return typeof b.jobId === "string" ? "list_import" : "unknown";
  }
  if (b.type === "campaign_fan_out") {
    return typeof b.campaignId === "string" && typeof b.jobId === "string"
      ? "campaign_fan_out"
      : "unknown";
  }
  if (b.type === "campaign_send") {
    return typeof b.campaignId === "string" &&
      typeof b.campaignRecipientId === "string"
      ? "campaign_send"
      : "unknown";
  }
  if (b.type === "suggest_reply") {
    return typeof b.emailId === "string" ? "suggest_reply" : "unknown";
  }
  if (b.type === "jmap_submission_release") {
    return typeof b.submissionId === "string"
      ? "jmap_submission_release"
      : "unknown";
  }
  if (b.type === "outbox_drain") return "outbox_drain";
  if (b.type === "ai_file") {
    return typeof b.emailId === "string" && typeof b.inbox === "string"
      ? "ai_file"
      : "unknown";
  }
  if (b.type === "backup_step") {
    return typeof b.runId === "string" && typeof b.step === "number"
      ? "backup_step"
      : "unknown";
  }
  if (
    b.type === "mail_export" ||
    b.type === "mail_import" ||
    b.type === "thread_backfill"
  ) {
    return typeof b.jobId === "string" && typeof b.slice === "number"
      ? b.type
      : "unknown";
  }
  return "unknown";
}

/**
 * Queue consumer entry point.
 *
 * Lives here rather than in `sequence-processor.ts` because the batch is no
 * longer sequence-specific; that module keeps the sequence work itself.
 */
export async function handleQueueBatch(
  batch: MessageBatch<unknown>,
  env: CloudflareBindings,
  overrides: {
    runSuggestedReply?: typeof runSuggestedReply;
  } = {},
): Promise<void> {
  if (isDemoMode(env)) {
    // No queue binding exists in demo, so this should never fire — ack anything
    // that somehow lands here so it doesn't infinitely retry.
    for (const msg of batch.messages) msg.ack();
    return;
  }

  const db = createDb(env);
  const sender = createEmailSender(env);
  const suggestedReplyRunner = overrides.runSuggestedReply ?? runSuggestedReply;
  // An export or import slice makes a few hundred reads and writes; one per
  // batch keeps the invocation well inside its subrequest budget.
  let sliceRan = false;

  for (const msg of batch.messages) {
    const kind = classifyQueueMessage(msg.body);

    if (kind === "unknown") {
      // A discriminant we don't implement is a producer shipped without its
      // consumer. Retrying cannot make it recognisable — it would just burn the
      // retry budget and delay real mail behind it — so ack and log loudly.
      console.error(
        "[queue] unrecognised message, acking to avoid a retry loop:",
        JSON.stringify(msg.body)?.slice(0, 500),
      );
      msg.ack();
      continue;
    }

    try {
      if (kind === "sequence_email") {
        const body = msg.body as SequenceEmailMessage;
        await processSequenceEmail(db, sender, env, body.sequenceEmailId);
      } else if (kind === "list_import") {
        const body = msg.body as ListImportMessage;
        await runListImportPage(db, env, body.jobId);
      } else if (kind === "campaign_fan_out") {
        const body = msg.body as CampaignFanOutMessage;
        await runCampaignFanOutPage(db, env, body.campaignId, body.jobId);
      } else if (kind === "campaign_send") {
        const body = msg.body as CampaignSendMessage;
        await sendCampaignRecipient(db, env, sender, body.campaignRecipientId);
      } else if (kind === "jmap_submission_release") {
        // A failed release gives its claim back, so a retry (or the hourly
        // sweep) sends it; one that may have reached the provider stays for
        // recovery.
        const body = msg.body as ReleaseMessage;
        await releaseScheduledSubmission(env, body.submissionId, { sender });
      } else if (kind === "ai_file") {
        // A model error throws, and the message is retried.
        await fileWithAi(db, env, msg.body as AiFileMessage);
      } else if (kind === "backup_step") {
        const body = msg.body as BackupStepMessage;
        if (sliceRan) {
          await env.EMAIL_QUEUE.send(body);
          msg.ack();
          continue;
        }
        sliceRan = true;
        const next = await runBackupStep(db, env, body.runId, body.step);
        if (next !== null) {
          await env.EMAIL_QUEUE.send({ ...body, step: next });
        }
      } else if (
        kind === "mail_export" ||
        kind === "mail_import" ||
        kind === "thread_backfill"
      ) {
        const body = msg.body as
          | MailExportMessage
          | MailImportMessage
          | ThreadBackfillMessage;
        if (sliceRan) {
          // Back on the queue as a new message: no attempt is used up.
          await env.EMAIL_QUEUE.send(body);
          msg.ack();
          continue;
        }
        sliceRan = true;
        // One slice; it says which comes next.
        const next =
          body.type === "mail_export"
            ? await runMailExportSlice(db, env, body.jobId, body.slice)
            : body.type === "thread_backfill"
              ? await runThreadBackfillSlice(db, env, body.jobId, body.slice)
              : await runMailImportSlice(db, env, body.jobId, body.slice);
        if (next !== null) {
          await env.EMAIL_QUEUE.send({ ...body, slice: next });
        }
      } else if (kind === "outbox_drain") {
        // After a resume: a batch of held mail, then the next batch, then the
        // delayed JMAP sends that came due while paused.
        const wait = await drainHeldOutbox(env, sender);
        if (wait !== null) {
          const next: OutboxDrainMessage = { type: "outbox_drain" };
          await env.EMAIL_QUEUE.send(
            next,
            wait > 0 ? { delaySeconds: wait } : undefined,
          );
        } else {
          await releaseOverdueSubmissions(
            env,
            Math.floor(Date.now() / 1000),
            sender,
          );
        }
      } else {
        const body = msg.body as SuggestReplyMessage;
        await suggestedReplyRunner(db, env, body.emailId);
      }
      msg.ack();
    } catch (err) {
      const sliced =
        kind === "mail_export" ||
        kind === "mail_import" ||
        kind === "thread_backfill" ||
        kind === "backup_step";
      if (sliced && err instanceof SliceBusyError) {
        // Another run holds the slice; it queues the next one itself. Come
        // back once its claim has run out, in case it died (if this message
        // runs out of attempts, the hourly run queues the job again).
        msg.retry({ delaySeconds: 150 });
      } else if (sliced && msg.attempts >= MAIL_EXPORT_MAX_ATTEMPTS) {
        console.error(
          `[queue] ${kind} failed after ${msg.attempts} attempts:`,
          err,
        );
        const jobId = (msg.body as MailExportMessage | MailImportMessage).jobId;
        const reason = err instanceof Error ? err.message : `${kind} failed`;
        if (kind === "backup_step") {
          await failBackup(
            db,
            env,
            (msg.body as BackupStepMessage).runId,
            reason,
          ).catch((error) =>
            console.error("[queue] backup not failed:", error),
          );
        } else if (kind === "mail_export") {
          await failMailExport(db, env, jobId, reason).catch((error) =>
            console.error("[queue] export not failed:", error),
          );
        } else if (kind === "thread_backfill") {
          await failThreadBackfill(db, jobId, reason).catch((error) =>
            console.error("[queue] thread backfill not failed:", error),
          );
        } else {
          // One message that can never be stored must not stop the rest of
          // the file: skip it with a note and go on.
          const next = await skipStuckMessage(db, env, jobId, reason).catch(
            (error) => {
              console.error("[queue] import message not skipped:", error);
              return null;
            },
          );
          if (next !== null) {
            const message: MailImportMessage = {
              type: "mail_import",
              jobId,
              slice: next,
            };
            await env.EMAIL_QUEUE.send(message);
          }
        }
        msg.ack();
      } else if (
        kind === "suggest_reply" &&
        msg.attempts >= SUGGEST_REPLY_MAX_ATTEMPTS
      ) {
        console.error(
          `[queue] suggest_reply failed after ${msg.attempts} attempts; acking:`,
          err,
        );
        msg.ack();
      } else {
        console.error(`[queue] ${kind} failed:`, err);
        if (kind === "suggest_reply" || kind === "ai_file") {
          // A model call: give the provider time before asking again.
          msg.retry({ delaySeconds: SUGGEST_REPLY_RETRY_DELAY_SECONDS });
        } else {
          msg.retry();
        }
      }
    }
  }
}
