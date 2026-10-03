import { parseAddressHeader, parseReplyToHeader } from "../email-parser";
import type { MailAddress, UnifiedMessage } from "./types";

export type ReceivedSelect = {
  id: string;
  personId: string | null;
  recipient: string;
  subject: string | null;
  bodyHtml: string | null;
  bodyText: string | null;
  messageId: string | null;
  /** Raw In-Reply-To / References headers, when the select read them. */
  inReplyTo?: string | null;
  referencesHeader?: string | null;
  /** Octets of the stored raw message, when there is one. */
  rawSize?: number | null;
  isRead: number;
  cc: string | null;
  /** The raw To header from `raw_headers`, when the select read it. */
  toHeader?: string | null;
  /**
   * `reply_to`, and for a row where it is NULL the `reply-to` value from
   * `raw_headers`, when the select read them (`withReplyTo`).
   */
  replyTo?: string | null;
  replyToHeader?: string | null;
  conversationId: string | null;
  receivedAt: number;
  personEmail: string | null;
  personName: string | null;
};

export type SentSelect = {
  id: string;
  personId: string | null;
  fromAddress: string;
  toAddress: string;
  subject: string | null;
  bodyHtml: string | null;
  bodyText: string | null;
  inReplyTo: string | null;
  messageId: string | null;
  status: string;
  cc: string | null;
  conversationId: string | null;
  campaignId: string | null;
  sequenceId: string | null;
  sequenceEnrollmentId: string | null;
  sentAt: number;
  personName: string | null;
  /** The inbox identity's display name, when the select joined it. */
  fromName?: string | null;
  /** JSON [{email,name}], set by JMAP sends with several To or Bcc. */
  additionalTo?: string | null;
  bcc?: string | null;
};

export function parseCc(raw: string | null | undefined): MailAddress[] {
  if (!raw) return [];

  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];

    return parsed.filter(
      (entry): entry is MailAddress =>
        typeof entry === "object" &&
        entry !== null &&
        typeof (entry as { email?: unknown }).email === "string",
    );
  } catch {
    return [];
  }
}

/** The `reply-to` value kept in a stored `raw_headers` object, if any. */
function replyToHeader(rawHeaders: string | null): string | null {
  if (!rawHeaders) return null;
  try {
    const value = (JSON.parse(rawHeaders) as Record<string, unknown>)[
      "reply-to"
    ];
    return typeof value === "string" ? value : null;
  } catch {
    // Malformed raw_headers: no Reply-To rather than a failed read.
    return null;
  }
}

/**
 * A received message's Reply-To list: the stored column, or, for a row from
 * before it existed (`reply_to` NULL), the header kept in `raw_headers`.
 * `header` is that one value when a query already pulled it out.
 */
function replyToList(
  stored: string | null,
  header: string | null | undefined,
): MailAddress[] {
  if (stored !== null) return parseCc(stored);
  return header ? parseReplyToHeader(header) : [];
}

/**
 * Where the sender of a received message asked for replies. Every reader of
 * Reply-To goes through this; nothing else parses `raw_headers` for it.
 */
export function replyToOf(row: {
  replyTo: string | null;
  rawHeaders: string | null;
}): MailAddress[] {
  return replyToList(
    row.replyTo,
    row.replyTo === null ? replyToHeader(row.rawHeaders) : null,
  );
}

export function adaptReceived(row: ReceivedSelect): UnifiedMessage {
  const toList =
    typeof row.toHeader === "string"
      ? parseAddressHeader(row.toHeader)
      : undefined;
  const inbox = row.recipient.toLowerCase();
  const others = (toList ?? []).filter((address) => address.email !== inbox);
  return {
    ref: { kind: "received", id: row.id },
    direction: "inbound",
    inbox: row.recipient,
    personId: row.personId,
    conversationId: row.conversationId,
    messageId: row.messageId,
    inReplyTo: row.inReplyTo ?? null,
    references: row.referencesHeader ?? null,
    ...(row.rawSize != null ? { rawSize: row.rawSize } : {}),
    from: row.personEmail
      ? {
          email: row.personEmail,
          name: row.personName,
        }
      : null,
    to: { email: row.recipient },
    ...(others.length > 0 ? { additionalTo: others } : {}),
    ...(toList ? { toList } : {}),
    cc: parseCc(row.cc),
    ...(row.replyTo !== undefined
      ? { replyTo: replyToList(row.replyTo, row.replyToHeader) }
      : {}),
    subject: row.subject,
    bodyText: row.bodyText,
    bodyHtml: row.bodyHtml,
    occurredAt: row.receivedAt,
    isRead: row.isRead === 1,
    source: {
      campaignId: null,
      sequenceId: null,
      sequenceEnrollmentId: null,
    },
    delivery: null,
  };
}

export function adaptSent(row: SentSelect): UnifiedMessage {
  return {
    ref: { kind: "sent", id: row.id },
    direction: "outbound",
    inbox: row.fromAddress,
    personId: row.personId,
    conversationId: row.conversationId,
    messageId: row.messageId,
    inReplyTo: row.inReplyTo,
    from: row.fromName
      ? { email: row.fromAddress, name: row.fromName }
      : { email: row.fromAddress },
    to: {
      email: row.toAddress,
      name: row.personName,
    },
    ...(row.additionalTo ? { additionalTo: parseCc(row.additionalTo) } : {}),
    cc: parseCc(row.cc),
    ...(row.bcc ? { bcc: parseCc(row.bcc) } : {}),
    subject: row.subject,
    bodyText: row.bodyText,
    bodyHtml: row.bodyHtml,
    occurredAt: row.sentAt,
    isRead: null,
    source: {
      campaignId: row.campaignId,
      sequenceId: row.sequenceId,
      sequenceEnrollmentId: row.sequenceEnrollmentId,
    },
    delivery: { status: row.status },
  };
}
