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
  /** Optional CC list — each entry can be a bare address or "Name <addr>". */
  cc?: string[];
  subject: string;
  html: string;
  text?: string;
  headers?: Record<string, string>;
  attachments?: SendEmailAttachment[];
}

export interface SendEmailError {
  message: string;
  /**
   * true = worth retrying via the outbox (429/5xx/quota/network);
   * false = terminal reject (bad recipient, auth failure).
   */
  transient: boolean;
}

export interface SendEmailResult {
  id: string | null;
  error: SendEmailError | null;
}

export interface EmailSender {
  provider: "resend" | "cloudflare" | "none" | "demo" | "bavimail" | "postmark";
  send(params: SendEmailParams): Promise<SendEmailResult>;
  maxAttachmentBytes(): number;
  /**
   * The provider's documented cap on a whole message, in octets, measured the
   * way the provider measures it (after transfer encoding). JMAP reports it as
   * `tooLarge.maxSize`; it is never derived from `maxAttachmentBytes()`.
   */
  maxMessageBytes(): number;
}
