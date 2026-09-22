export interface SendEmailAttachment {
  filename: string;
  contentType: string;
  /** Raw bytes. */
  content: ArrayBuffer | Uint8Array;
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
}

export interface SendEmailResult {
  id: string | null;
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
    | "gmail";
  send(params: SendEmailParams): Promise<SendEmailResult>;
  maxAttachmentBytes(): number;
}
