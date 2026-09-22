import type { MailAddress, UnifiedMessage } from "./types";

export type ReceivedSelect = {
  id: string;
  personId: string | null;
  recipient: string;
  subject: string | null;
  bodyHtml: string | null;
  bodyText: string | null;
  messageId: string | null;
  isRead: number;
  cc: string | null;
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
  sentAt: number;
  personName: string | null;
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

export function adaptReceived(row: ReceivedSelect): UnifiedMessage {
  return {
    ref: { kind: "received", id: row.id },
    direction: "inbound",
    inbox: row.recipient,
    personId: row.personId,
    conversationId: row.conversationId,
    messageId: row.messageId,
    inReplyTo: null,
    from: row.personEmail
      ? {
          email: row.personEmail,
          name: row.personName,
        }
      : null,
    to: { email: row.recipient },
    cc: parseCc(row.cc),
    subject: row.subject,
    bodyText: row.bodyText,
    bodyHtml: row.bodyHtml,
    occurredAt: row.receivedAt,
    isRead: row.isRead === 1,
    source: { campaignId: null },
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
    from: { email: row.fromAddress },
    to: {
      email: row.toAddress,
      name: row.personName,
    },
    cc: parseCc(row.cc),
    subject: row.subject,
    bodyText: row.bodyText,
    bodyHtml: row.bodyHtml,
    occurredAt: row.sentAt,
    isRead: null,
    source: { campaignId: row.campaignId },
    delivery: { status: row.status },
  };
}
