import { drizzle } from "drizzle-orm/d1";
import { schema } from "../db/schema";
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
export type QueueMessageBody =
  | SequenceEmailMessage
  | ListImportMessage
  | CampaignFanOutMessage
  | CampaignSendMessage;

export type QueueMessageKind =
  | "sequence_email"
  | "list_import"
  | "campaign_fan_out"
  | "campaign_send"
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
): Promise<void> {
  if (isDemoMode(env)) {
    // No queue binding exists in demo, so this should never fire — ack anything
    // that somehow lands here so it doesn't infinitely retry.
    for (const msg of batch.messages) msg.ack();
    return;
  }

  const db = drizzle(env.DB, { schema });
  const sender = createEmailSender(env);

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
      } else {
        const body = msg.body as CampaignSendMessage;
        await sendCampaignRecipient(db, env, sender, body.campaignRecipientId);
      }
      msg.ack();
    } catch (err) {
      console.error(`[queue] ${kind} failed:`, err);
      msg.retry();
    }
  }
}
