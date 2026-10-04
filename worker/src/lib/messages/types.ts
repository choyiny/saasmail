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

export interface UnifiedMessageState {
  seen: boolean;
  starredAt: number | null;
  archivedAt: number | null;
  spamAt: number | null;
  trashedAt: number | null;
  mailboxIds: string[];
  conversationKey: string | null;
  snoozedUntil: number | null;
  assignedUserId: string | null;
}

export interface UnifiedMessage {
  ref: MessageRef;
  direction: "inbound" | "outbound";
  inbox: string;
  personId: string | null;
  conversationId: string | null;
  messageId: string | null;
  inReplyTo: string | null;
  /** The raw References header of received mail; null for sent mail. */
  references?: string | null;
  /** Octets of received mail's stored raw message (JMAP blobId and size). */
  rawSize?: number;
  /**
   * Received mail's score from its inbox's learning filter (0–1), or null
   * when it was not scored. Absent for sent mail.
   */
  spamProbability?: number | null;
  from: MailAddress | null;
  to: MailAddress;
  /**
   * Further To recipients, after `to`: a sent message's extra To (JMAP), or
   * received mail's To addresses other than its inbox.
   */
  additionalTo?: MailAddress[];
  /**
   * Received mail's To header exactly as it lists them (JMAP `to`); absent
   * when the stored headers have no To.
   */
  toList?: MailAddress[];
  cc: MailAddress[];
  /** Blind recipients of a sent message (JMAP). Only the sender sees these. */
  bcc?: MailAddress[];
  /**
   * Received mail's Reply-To list (`replyToOf`), `[]` for sent mail. Only set
   * when the query asked for `withReplyTo`.
   */
  replyTo?: MailAddress[];
  subject: string | null;
  bodyText: string | null;
  bodyHtml: string | null;
  occurredAt: number;
  isRead: boolean | null;
  source: {
    campaignId: string | null;
    sequenceId: string | null;
    sequenceEnrollmentId: string | null;
  };
  delivery: {
    status: string;
  } | null;
  attachmentCount?: number;
  attachments?: AttachmentRow[];
  state?: UnifiedMessageState;
  /**
   * Mail sent through JMAP EmailSubmission: its content row, that content's
   * thread key, and, once a submission's on-success step filed the draft into
   * Sent, the draft id it now shows as (`emailId`) and the draft's receivedAt.
   * Only set when the query asked for `withJmap`.
   */
  jmap?: {
    contentId: string;
    threadKey: string;
    emailId: string | null;
    receivedAt: number | null;
  };
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
