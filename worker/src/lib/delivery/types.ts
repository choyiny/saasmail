/**
 * A provider's report about a message it accepted, normalized so the service
 * (`record.ts`) does not depend on the provider. Cloudflare is the first
 * adapter (`cloudflare.ts`); docs/suppressions.md describes the rules.
 */
export type DeliveryEventKind =
  | "bounced"
  | "complained"
  | "failed"
  | "rejected";

export type DeliverySuppressionReason =
  | "hard_bounce"
  | "soft_bounce"
  | "complaint"
  | "provider";

export interface DeliveryEvent {
  provider: "cloudflare";
  providerEventId: string;
  kind: DeliveryEventKind;
  bounceType: "hard" | "soft" | null;
  /** As the provider sent it. */
  messageId: string | null;
  /** Lowercased and trimmed. */
  recipient: string;
  sender: string | null;
  /** "550 5.1.1": the SMTP status and the enhanced status code. */
  smtpStatus: string | null;
  /** At most 500 characters. */
  detail: string | null;
  /** A rejection's reason code, e.g. `suppressed`. */
  rejectionReason: string | null;
  /** Unix seconds. */
  occurredAt: number;
}

export interface DeliveryEventOutcome {
  event: DeliveryEvent;
  sentEmailId: string | null;
  campaignId: string | null;
  suppression: DeliverySuppressionReason | null;
  listsLeft: number;
}

/** The sent message an event is about, when one matches. */
export interface DeliveryCorrelation {
  sentEmailId: string;
  campaignId: string | null;
}
