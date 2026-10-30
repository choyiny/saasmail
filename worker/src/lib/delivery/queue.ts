import type { DrizzleD1Database } from "drizzle-orm/d1";
import { parseCloudflareEvent } from "./cloudflare";
import { correlateDeliveryEvent, recordDeliveryEvent } from "./record";

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
  await recordDeliveryEvent(db, event, { correlation });
  msg.ack();
}
