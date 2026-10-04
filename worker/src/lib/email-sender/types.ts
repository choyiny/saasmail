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
  error: SendEmailError | null;
}

export interface EmailSender {
  provider: "resend" | "cloudflare" | "none" | "demo" | "bavimail" | "postmark";
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
