import type { DeliveryEvent, DeliveryEventKind } from "./types";

/** Every Cloudflare Email Sending event's `type` starts with this. */
export const CLOUDFLARE_EVENT_PREFIX = "cf.email.sending.message.";

// A Map, not an object: `message.constructor` must not find a prototype key.
const HANDLED = new Map<string, DeliveryEventKind>([
  ["bounced", "bounced"],
  ["complained", "complained"],
  ["failed", "failed"],
  ["rejected", "rejected"],
]);

const DETAIL_MAX = 500;

type Obj = Record<string, unknown>;

function obj(value: unknown): Obj | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Obj)
    : null;
}

/** A non-empty trimmed string, or null. Numbers count: SMTP codes may be either. */
function str(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * One Cloudflare Email Sending queue message (docs/email-providers.md) as a
 * `DeliveryEvent`. `"ignore"`: a well-formed type this server does not act
 * on (`delivered`, `deferred`, a future one). `null`: the body is malformed.
 */
export function parseCloudflareEvent(
  body: unknown,
  now: number = Math.floor(Date.now() / 1000),
): DeliveryEvent | "ignore" | null {
  const root = obj(body);
  if (!root || typeof root.type !== "string") return null;
  if (!root.type.startsWith(CLOUDFLARE_EVENT_PREFIX)) return null;
  const kind = HANDLED.get(root.type.slice(CLOUDFLARE_EVENT_PREFIX.length));
  if (!kind) return "ignore";

  const payload = obj(root.payload);
  if (!payload) return null;
  if (typeof payload.eventId !== "string" || payload.eventId.trim() === "") {
    return null;
  }
  if (
    typeof payload.recipient !== "string" ||
    payload.recipient.trim() === ""
  ) {
    return null;
  }

  const delivery = obj(payload.delivery);
  const bounce = obj(payload.bounce);
  const rejection = obj(payload.rejection);
  const failure = obj(payload.failure);
  const complaint = obj(payload.complaint);

  const bounceType =
    kind === "bounced" && (bounce?.type === "hard" || bounce?.type === "soft")
      ? bounce.type
      : null;
  const smtpParts = [
    str(delivery?.smtpStatusCode),
    str(delivery?.smtpEnhancedStatusCode),
  ].filter((part): part is string => part !== null);
  const detail =
    (kind === "bounced" ? str(bounce?.reason) : null) ??
    (kind === "rejected"
      ? (str(rejection?.detail) ?? str(rejection?.reason))
      : null) ??
    (kind === "failed" ? str(failure?.reason) : null) ??
    (kind === "complained" ? str(complaint?.type) : null) ??
    str(delivery?.smtpResponse);

  const metadata = obj(root.metadata);
  const parsedAt =
    typeof metadata?.eventTimestamp === "string"
      ? Math.floor(Date.parse(metadata.eventTimestamp) / 1000)
      : NaN;

  return {
    provider: "cloudflare",
    providerEventId: payload.eventId.trim(),
    kind,
    bounceType,
    messageId: typeof payload.messageId === "string" ? payload.messageId : null,
    recipient: payload.recipient.trim().toLowerCase(),
    sender: str(payload.sender),
    smtpStatus: smtpParts.length > 0 ? smtpParts.join(" ") : null,
    detail: detail ? detail.slice(0, DETAIL_MAX) : null,
    rejectionReason: kind === "rejected" ? str(rejection?.reason) : null,
    occurredAt: Number.isFinite(parsedAt) ? parsedAt : now,
  };
}
