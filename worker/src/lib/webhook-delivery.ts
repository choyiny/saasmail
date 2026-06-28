import type { DrizzleD1Database } from "drizzle-orm/d1";
import { getWebhookConfig, type WebhookConfig } from "./webhook-config";
import { signWebhookBody } from "./webhook-signature";

const TIMEOUT_MS = 10_000;
const PREVIEW_LEN = 280;

export interface WebhookAttachment {
  filename: string;
  contentType: string;
  size: number;
}

export interface WebhookPayload {
  event: "message.received";
  id: string;
  receivedAt: number;
  inbox: string;
  from: { address: string; name: string | null };
  subject: string;
  textPreview: string;
  conversationId: string;
  attachments: WebhookAttachment[];
  auth: { spf: string | null; dkim: string | null; dmarc: string | null };
  url: string;
}

/** Pure: assemble the webhook body from already-parsed email data. */
export function buildWebhookPayload(args: {
  emailId: string;
  receivedAt: number;
  inbox: string;
  fromAddress: string;
  fromName: string | null;
  subject: string | null;
  bodyText: string | null;
  conversationId: string;
  attachments: WebhookAttachment[];
  auth: { spf: string | null; dkim: string | null; dmarc: string | null };
  baseUrl: string;
}): WebhookPayload {
  return {
    event: "message.received",
    id: args.emailId,
    receivedAt: args.receivedAt,
    inbox: args.inbox,
    from: { address: args.fromAddress, name: args.fromName },
    subject: args.subject ?? "",
    textPreview: (args.bodyText ?? "").slice(0, PREVIEW_LEN),
    conversationId: args.conversationId,
    attachments: args.attachments,
    auth: args.auth,
    url: `${args.baseUrl.replace(/\/$/, "")}/m/${encodeURIComponent(args.emailId)}`,
  };
}

/**
 * Awaitable single POST. Never throws; returns a delivery result.
 * `fetchImpl` is injectable so tests don't have to mutate the global `fetch`
 * (which leaks across the parallel vitest-pool-workers isolates).
 */
export async function sendWebhook(
  config: WebhookConfig,
  payload: WebhookPayload,
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: boolean; status?: number; error?: string }> {
  const body = JSON.stringify(payload);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "User-Agent": "SaaSMail-Webhook/1",
    "X-SaaSMail-Event": payload.event,
  };
  if (config.secret) {
    headers["X-SaaSMail-Signature"] = await signWebhookBody(
      body,
      config.secret,
    );
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetchImpl(config.url, {
      method: "POST",
      headers,
      body,
      signal: controller.signal,
    });
    return { ok: res.ok, status: res.status };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Fire-and-forget delivery off the ingest path. No-op when unconfigured. */
export function deliverWebhook(
  db: DrizzleD1Database<any>,
  ctx: ExecutionContext,
  payload: WebhookPayload,
): void {
  ctx.waitUntil(
    (async () => {
      try {
        const config = await getWebhookConfig(db);
        if (!config) return;
        const result = await sendWebhook(config, payload);
        if (!result.ok) {
          console.warn(
            `Webhook delivery failed: ${result.status ?? result.error}`,
          );
        }
      } catch (err) {
        console.warn("Webhook delivery error:", err);
      }
    })(),
  );
}
