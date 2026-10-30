import type { DrizzleD1Database } from "drizzle-orm/d1";
import { getWebhookConfig, webhookWants } from "../webhook-config";
import {
  dispatchWebhook,
  webhookIntent,
  webhookMessageOf,
} from "../webhook-delivery";
import { parseCloudflareEvent } from "./cloudflare";
import {
  correlateDeliveryEvent,
  deliveryEventId,
  recordDeliveryEvent,
  type DeliveryBatchExtension,
} from "./record";
import type { DeliveryEvent } from "./types";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = DrizzleD1Database<any>;

/** How long a first, uncorrelated attempt waits for its sent row. */
export const UNCORRELATED_RETRY_DELAY_SECONDS = 60;

/**
 * One `delivery_event` queue message: parse, correlate, record, ack. A throw
 * is left to the consumer's catch, which retries; recording is idempotent.
 */
export async function handleDeliveryEventMessage(
  db: Db,
  msg: Pick<Message<unknown>, "body" | "attempts" | "ack" | "retry">,
  env: CloudflareBindings,
): Promise<void> {
  const event = parseCloudflareEvent(msg.body);
  if (event === "ignore") {
    msg.ack();
    return;
  }
  if (event === null) {
    console.error(
      "[delivery] malformed Cloudflare event, acking:",
      JSON.stringify(msg.body)?.slice(0, 500),
    );
    msg.ack();
    return;
  }
  const correlation = await correlateDeliveryEvent(db, event);
  // The sent row is written after the provider answers, and a bounce can
  // arrive first: wait once before recording the event uncorrelated. Before
  // any write, or the retry would be a duplicate that never correlates.
  if (!correlation && event.messageId?.trim() && msg.attempts <= 1) {
    msg.retry({ delaySeconds: UNCORRELATED_RETRY_DELAY_SECONDS });
    return;
  }
  const webhook = await deliveryWebhook(
    db,
    env,
    event,
    correlation?.sentEmailId ?? null,
  );
  const outcome = await recordDeliveryEvent(db, event, {
    correlation,
    ...(webhook ? { extend: webhook.extend } : {}),
  });
  // Null for a repeated event: its webhook row was not added either.
  const deliveryId = webhook?.deliveryId();
  if (outcome && deliveryId) await dispatchWebhook(env, deliveryId);
  msg.ack();
}

const WEBHOOK_EVENT = {
  bounced: "message.bounced",
  complained: "message.complained",
  failed: "message.failed",
  rejected: "message.failed",
} as const;

/** "550 5.1.1" → { smtpStatus: "550", enhancedStatus: "5.1.1" }. */
export function splitSmtpStatus(value: string | null): {
  smtpStatus: string | null;
  enhancedStatus: string | null;
} {
  const [code, enhanced] = (value ?? "").trim().split(/\s+/);
  return {
    smtpStatus: code || null,
    enhancedStatus:
      enhanced && /^\d\.\d{1,3}\.\d{1,3}$/.test(enhanced) ? enhanced : null,
  };
}

/**
 * The webhook row of a correlated event, built before the batch (its payload
 * needs the sent row) and added to it with the event's guard, so it commits
 * with the event or not at all (docs/webhooks.md). Null when the event is not
 * wanted or matches no sent message: the payload needs a `message.id`.
 */
export async function deliveryWebhook(
  db: Db,
  env: CloudflareBindings,
  event: DeliveryEvent,
  sentEmailId: string | null,
): Promise<{
  extend: DeliveryBatchExtension;
  /** The id `extend` gave the row, once it ran. */
  deliveryId: () => string | null;
} | null> {
  if (!sentEmailId) return null;
  const config = await getWebhookConfig(db);
  const name = WEBHOOK_EVENT[event.kind];
  if (!webhookWants(config, name)) return null;
  const sent = await webhookMessageOf(db, sentEmailId, env.BASE_URL);
  if (!sent) return null;
  // A Bcc recipient stays blind: the event never names them.
  const blind = sent.bcc.includes(event.recipient.trim().toLowerCase());
  const input = {
    event: name,
    occurredAt: event.occurredAt,
    message: sent.message,
    delivery: {
      recipient: blind ? null : event.recipient,
      status: event.kind,
      bounceType: event.bounceType,
      ...splitSmtpStatus(event.smtpStatus),
      // The provider's text usually quotes the address: dropped for a Bcc.
      reason: !blind && event.detail ? event.detail.slice(0, 200) : null,
      provider: event.provider,
    },
  };
  let deliveryId: string | null = null;
  return {
    extend: ({ guard }) => {
      const intent = webhookIntent(
        env,
        db,
        config,
        input,
        `delivery:${deliveryEventId(event)}`,
        { guard, frozen: true },
      );
      deliveryId = intent?.deliveryId ?? null;
      return intent ? [intent.statement] : [];
    },
    deliveryId: () => deliveryId,
  };
}
