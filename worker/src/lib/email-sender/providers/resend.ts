import { Resend } from "resend";
import type { EmailSender, SendEmailParams, SendEmailResult } from "../types";
import { toBase64, withoutHeader } from "../shared";
import { classifyErrorMessage } from "../classify";

export class ResendSender implements EmailSender {
  readonly provider = "resend" as const;
  private client: Resend;

  constructor(apiKey: string) {
    this.client = new Resend(apiKey);
  }

  async send(params: SendEmailParams): Promise<SendEmailResult> {
    const result = await this.client.emails.send({
      from: params.from,
      to:
        params.additionalTo && params.additionalTo.length > 0
          ? [params.to, ...params.additionalTo]
          : params.to,
      ...(params.cc && params.cc.length > 0 ? { cc: params.cc } : {}),
      ...(params.bcc && params.bcc.length > 0 ? { bcc: params.bcc } : {}),
      subject: params.subject,
      // A text-only message (a JMAP draft) has no HTML body to send.
      ...(params.html ? { html: params.html } : {}),
      text: params.text,
      // Resend stamps Date itself; overriding it isn't documented.
      headers: withoutHeader(params.headers, "Date"),
      ...(params.attachments && params.attachments.length > 0
        ? {
            attachments: params.attachments.map((a) => ({
              filename: a.filename,
              content: toBase64(a.content),
              contentType: a.contentType,
              // The SDK sends a part with contentId as inline.
              ...(a.contentId ? { contentId: a.contentId } : {}),
            })),
          }
        : {}),
    });
    if (result.error) {
      const message = result.error.message ?? "Resend send failed";
      return {
        id: null,
        error: {
          message,
          transient: classifyErrorMessage(
            `${result.error.name ?? ""} ${message}`,
          ),
        },
      };
    }
    return { id: result.data?.id ?? null, error: null };
  }

  recipientSupport() {
    return { multipleTo: true, bcc: true };
  }

  maxAttachmentBytes(): number {
    return 25 * 1024 * 1024;
  }

  maxMessageBytes(): number {
    // "max 40MB per email, after Base64 encoding of the attachments"
    // (resend.com/docs/api-reference/emails/send-email).
    return 40_000_000;
  }
}
