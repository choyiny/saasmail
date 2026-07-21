import type { EmailSender, SendEmailParams, SendEmailResult } from "../types";

export class NoopSender implements EmailSender {
  readonly provider = "none" as const;
  async send(_: SendEmailParams): Promise<SendEmailResult> {
    return {
      id: null,
      error: { message: "No email provider configured", transient: false },
    };
  }

  maxAttachmentBytes(): number {
    return 0;
  }
}
