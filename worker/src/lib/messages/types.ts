import type { attachments } from "../../db/attachments.schema";

export type MessageKind = "received" | "sent";

export interface MessageRef {
  kind: MessageKind;
  id: string;
}

export interface MailAddress {
  email: string;
  name?: string | null;
}

export type AttachmentRow = typeof attachments.$inferSelect;

export interface UnifiedMessage {
  ref: MessageRef;
  direction: "inbound" | "outbound";
  inbox: string;
  personId: string | null;
  conversationId: string | null;
  messageId: string | null;
  inReplyTo: string | null;
  from: MailAddress | null;
  to: MailAddress;
  cc: MailAddress[];
  subject: string | null;
  bodyText: string | null;
  bodyHtml: string | null;
  occurredAt: number;
  isRead: boolean | null;
  source: {
    campaignId: string | null;
  };
  delivery: {
    status: string;
  } | null;
  attachmentCount?: number;
  attachments?: AttachmentRow[];
}

export function serializeMessageRef(ref: MessageRef): string {
  return `${ref.kind}:${ref.id}`;
}

export function parseMessageRef(value: string): MessageRef | null {
  const separator = value.indexOf(":");
  if (separator <= 0 || separator === value.length - 1) return null;

  const kind = value.slice(0, separator);
  if (kind !== "received" && kind !== "sent") return null;

  return {
    kind,
    id: value.slice(separator + 1),
  };
}
