export interface SendEmailAttachment {
  filename: string;
  contentType: string;
  /** Raw bytes. */
  content: ArrayBuffer | Uint8Array;
  /**
   * Content-ID without angle brackets, for parts the HTML references as
   * `cid:…`. Null/absent for ordinary attachments.
   */
  contentId?: string | null;
  /** "inline" for parts shown in the body (multipart/related). Default "attachment". */
  disposition?: "attachment" | "inline";
}

export interface SendEmailParams {
  from: string;
  to: string;
  /**
   * More To recipients after `to`, bare or "Name <addr>". Only for a sender
   * whose `recipientSupport().multipleTo` is true.
   */
  additionalTo?: string[];
  /** Optional CC list — each entry can be a bare address or "Name <addr>". */
  cc?: string[];
  /**
   * Blind recipients: delivered to, never written into the message's headers.
   * Only for a sender whose `recipientSupport().bcc` is true.
   */
  bcc?: string[];
  subject: string;
  html: string;
  text?: string;
  headers?: Record<string, string>;
  attachments?: SendEmailAttachment[];
  /**
   * The same on the first attempt and every retry of one message, so a
   * provider that supports it (Resend, for 24 hours) sends it at most once even
   * if an earlier attempt succeeded without saasmail learning so. Others ignore it.
   */
  idempotencyKey?: string;
  /**
   * Gmail thread to reply within, instead of starting a new conversation.
   * Optional and Gmail-specific — other providers ignore it.
   */
  threadId?: string;
}

export interface SendEmailError {
  message: string;
  /**
   * true = worth retrying via the outbox (429/5xx/quota/network);
   * false = terminal reject (bad recipient, auth failure).
   */
  transient: boolean;
  /**
   * Set when nothing was attempted because outbound sending is paused: the
   * outbox holds the message until sending resumes (sending-controls.ts).
   */
  paused?: boolean;
  /**
   * Set when the provider's credentials for this mailbox are dead and a
   * resend of the identical request can never succeed — today, a Gmail grant
   * that was revoked or otherwise no longer refreshes.
   *
   * `transient: false` already says "do not queue this"; this says the
   * stronger thing the USER has to be told, which is that pressing send again
   * is pointless until the mailbox is reconnected.
   */
  reconnect?: boolean;
  /**
   * Set when the provider ACCEPTED the message and the failure is only that
   * we could not record it — today, a Gmail 2xx whose body carried no message
   * id. The mail is on its way to the recipient, so this is the one error on
   * which "send it again" is the wrong advice: it would deliver a second copy
   * of a real reply. A caller wrapping this error in its own sentence must
   * not add a retry instruction; `message` already says what happened.
   */
  delivered?: boolean;
  /**
   * Set when the request may have reached the provider and been accepted:
   * a timeout, a network error or a 5xx after the request went out. Only the
   * Gmail and Outlook senders set it: their mail is never queued, so the
   * caller must not let a retry send it again (see lib/direct-send.ts).
   */
  uncertain?: boolean;
}

export interface SendEmailResult {
  /**
   * The provider's own id for the send (stored as `sent_emails.resend_id`). Its
   * meaning is provider-specific: never treat it as an RFC 5322 Message-ID.
   */
  id: string | null;
  /**
   * The Message-ID the recipients actually received, when the provider replaced
   * the caller's `Message-ID` header with its own (Cloudflare does, always).
   * Absent when the provider sends the caller's header as given.
   */
  deliveredMessageId?: string | null;
  /**
   * Gmail's thread id for the message that was just sent — present on a
   * successful Gmail send whether or not a `threadId` was supplied on the
   * request (Gmail assigns a fresh one when it wasn't). Other providers
   * never set this. A reply to a Cloudflare-sourced message has no known
   * thread to pass in, so this is how the caller learns the one Gmail
   * assigned, to persist for later threading.
   */
  threadId?: string | null;
  error: SendEmailError | null;
}

export interface EmailSender {
  provider:
    | "resend"
    | "cloudflare"
    | "none"
    | "demo"
    | "bavimail"
    | "postmark"
    | "gmail"
    | "outlook";
  send(params: SendEmailParams): Promise<SendEmailResult>;
  /**
   * Recipient forms the provider delivers besides one To and Cc. Absent means
   * neither: callers must not pass `additionalTo` or `bcc`.
   */
  recipientSupport?(): RecipientSupport;
  maxAttachmentBytes(): number;
  /**
   * The provider's documented cap on a whole message, in octets, measured the
   * way the provider measures it (after transfer encoding). JMAP reports it as
   * `tooLarge.maxSize`; it is never derived from `maxAttachmentBytes()`.
   */
  maxMessageBytes(): number;
}

export interface RecipientSupport {
  multipleTo: boolean;
  bcc: boolean;
}

/** What a sender delivers; a sender that doesn't say supports neither. */
export function recipientSupportOf(sender: EmailSender): RecipientSupport {
  return sender.recipientSupport?.() ?? { multipleTo: false, bcc: false };
}
