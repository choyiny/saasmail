// docs/webhooks.md: shared setup for the outbound delivery-event tests.
import { vi } from "vitest";
import { env } from "cloudflare:workers";
import { getDb } from "./helpers";
import { webhookDeliveries } from "../db/webhook-deliveries.schema";
import { setWebhookConfig, type WebhookEvent } from "../lib/webhook-config";

export const HOOK_URL = "https://hook.example.com/events";
export const HOOK_SECRET = "whsec_test";

export async function configureWebhook(
  events: WebhookEvent[] = ["message.received", "message.sent"],
) {
  await setWebhookConfig(
    getDb(),
    { url: HOOK_URL, secret: HOOK_SECRET, events },
    null,
  );
}

/** Replace `EMAIL_QUEUE` with one that records what is sent; call restore after. */
export function captureQueue(opts: { fail?: boolean } = {}) {
  const original = (env as any).EMAIL_QUEUE;
  const sent: unknown[] = [];
  /** The options of each `send`, in step with `sent` for single sends. */
  const options: (QueueSendOptions | undefined)[] = [];
  (env as any).EMAIL_QUEUE = {
    send: async (body: unknown, sendOptions?: QueueSendOptions) => {
      if (opts.fail) throw new Error("queue unavailable");
      sent.push(body);
      options.push(sendOptions);
    },
    sendBatch: async (messages: { body: unknown }[]) => {
      if (opts.fail) throw new Error("queue unavailable");
      sent.push(...messages.map((m) => m.body));
    },
  };
  return {
    sent,
    options,
    restore: () => {
      (env as any).EMAIL_QUEUE = original;
    },
  };
}

export function queueMessage(body: unknown, attempts = 1) {
  return {
    id: `m-${Math.random()}`,
    timestamp: new Date(),
    body,
    attempts,
    ack: vi.fn(),
    retry: vi.fn(),
  };
}

/** A fetch that answers each call with the next status (the last repeats). */
export function scriptedFetch(statuses: (number | Error)[]) {
  let call = 0;
  return vi.fn<typeof fetch>(async () => {
    const next = statuses[Math.min(call, statuses.length - 1)];
    call += 1;
    if (next instanceof Error) throw next;
    return new Response(null, { status: next });
  });
}

export async function deliveryRows() {
  return getDb().select().from(webhookDeliveries);
}
