/**
 * Delivery to native devices through Expo's push service.
 *
 * Web Push and this are different transports for the same event, not variants
 * of one. Web Push encrypts a payload to a keypair the browser generated and
 * POSTs it to a push-service URL (RFC 8291); Expo takes an opaque token and a
 * JSON message and routes it to APNs or FCM on our behalf. Nothing about the
 * RFC 8291/8292 path is reusable here, which is why this is a separate module
 * rather than a branch inside `web-push.ts`.
 *
 * ## On credentials, which is the part worth understanding before deploying
 *
 * APNs and FCM credentials live on the *Expo project that built the app*, not
 * on the saasmail deployment. A self-hosted server therefore cannot hold them,
 * and there is nothing sensible to configure: the server POSTs to `exp.host`
 * unauthenticated and Expo routes by token.
 *
 * The consequence is that **an Expo push token is a bearer capability** —
 * anyone holding one can send that device a notification through this same
 * public endpoint. Two things bound the damage, and both must hold:
 *
 *  - Tokens are stored server-side and never returned by any API, so obtaining
 *    one means already having database access.
 *  - The payload is a wake-up, not a copy of the message (see `buildMessage`),
 *    so a stolen token cannot be used to *read* anything. It could be used to
 *    send a misleading notification, which is why the client treats a push as
 *    untrusted and fetches the real data before displaying anything specific.
 *
 * If the Expo project ever enables enhanced push security, unauthenticated
 * sends stop working and this needs an Expo access token. That is a deliberate
 * either/or, not something to paper over.
 */

const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";

/** Expo rejects a request carrying more than 100 messages. */
const MAX_MESSAGES_PER_REQUEST = 100;

/**
 * How long Expo should keep trying. The web-push path uses 60 seconds, which is
 * aggressive even for a browser and simply wrong for a phone: a handset that is
 * asleep, in a tunnel, or off overnight would never receive the notification at
 * all. A day is long enough to survive that and short enough that nothing
 * arrives so stale it confuses.
 */
const TTL_SECONDS = 24 * 60 * 60;

export interface ExpoMessage {
  to: string;
  title: string;
  body: string;
  data: Record<string, unknown>;
  ttl: number;
  priority: "default" | "normal" | "high";
  sound: "default" | null;
  /**
   * APNs and Expo require a *number* here. The web-push payload puts an image
   * path in its `badge` field — that is the Web Notification badge icon, an
   * unrelated field that happens to share a name. Passing it through would be a
   * type error at the push service.
   */
  badge?: number;
}

export interface ExpoTicket {
  status: "ok" | "error";
  id?: string;
  message?: string;
  details?: { error?: string };
}

export interface ExpoSendResult {
  /** Tokens Expo says are no longer valid; the caller should delete them. */
  invalidTokens: string[];
  sent: number;
  failed: number;
  /** True when the request was throttled and not all messages were attempted. */
  throttled: boolean;
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size)
    out.push(items.slice(i, i + size));
  return out;
}

/**
 * Build the message for a token.
 *
 * `withPreview` is off by default and that default is the point. saasmail is
 * self-hosted, and a notification carrying the sender and subject routes
 * mailbox metadata through Expo *and* Apple or Google, plus whatever is
 * rendered on a lock screen. A deployment that never turns previews on leaks
 * only the fact that mail arrived. Routing identifiers are always opaque ids,
 * so the client can navigate without the payload describing anything.
 */
export function buildMessage(args: {
  token: string;
  senderName: string;
  subject: string;
  data: Record<string, unknown>;
  withPreview: boolean;
  badge?: number;
}): ExpoMessage {
  return {
    to: args.token,
    title: args.withPreview ? args.senderName || "New email" : "New email",
    body: args.withPreview ? args.subject || "" : "",
    data: args.data,
    ttl: TTL_SECONDS,
    priority: "high",
    sound: "default",
    badge: args.badge,
  };
}

/**
 * Send a batch, returning the tokens that should be dropped.
 *
 * Deliberately best-effort. A lost notification means the user opens the app
 * and sees the mail — the WebSocket stream and a pull-to-refresh already cover
 * that — so this does not persist a job ledger or retry across requests. It
 * chunks, classifies what Expo returns, and reports.
 *
 * Note that Expo reports per-message failures *inside* an HTTP 200: a request
 * can succeed while every message in it failed, so the ticket array has to be
 * read rather than the status code trusted.
 */
export async function sendExpoPush(
  messages: ExpoMessage[],
): Promise<ExpoSendResult> {
  const result: ExpoSendResult = {
    invalidTokens: [],
    sent: 0,
    failed: 0,
    throttled: false,
  };
  if (messages.length === 0) return result;

  for (const batch of chunk(messages, MAX_MESSAGES_PER_REQUEST)) {
    let res: Response;
    try {
      res = await fetch(EXPO_PUSH_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify(batch),
      });
    } catch (err) {
      result.failed += batch.length;
      console.error(
        `[expo-push] request threw: ${err instanceof Error ? err.message : String(err)}`,
      );
      continue;
    }

    // Throttled. Nothing in this batch was delivered; say so rather than
    // counting it as sent, and stop — hammering a rate limiter makes it worse.
    if (res.status === 429) {
      result.throttled = true;
      result.failed += batch.length;
      console.warn(
        `[expo-push] throttled (retry-after=${res.headers.get("Retry-After") ?? "unset"}); ${batch.length} message(s) not delivered`,
      );
      break;
    }

    if (!res.ok) {
      result.failed += batch.length;
      console.warn(`[expo-push] non-2xx from push service: ${res.status}`);
      continue;
    }

    let tickets: ExpoTicket[];
    try {
      const body = (await res.json()) as { data?: ExpoTicket[] };
      tickets = body.data ?? [];
    } catch {
      result.failed += batch.length;
      console.warn("[expo-push] unparseable response body");
      continue;
    }

    tickets.forEach((ticket, i) => {
      if (ticket.status === "ok") {
        result.sent++;
        return;
      }
      result.failed++;
      // The one error worth acting on: the token is gone (app uninstalled,
      // token rotated). Anything else is transient or ours to fix, and
      // deleting a row over it would silence a device that is still there.
      if (ticket.details?.error === "DeviceNotRegistered") {
        const token = batch[i]?.to;
        if (token) result.invalidTokens.push(token);
      } else {
        console.warn(
          `[expo-push] ticket error: ${ticket.details?.error ?? "unknown"} — ${ticket.message ?? ""}`,
        );
      }
    });
  }

  return result;
}
