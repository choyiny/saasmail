import { nanoid } from "nanoid";
import type { EmailSender, SendEmailParams, SendEmailResult } from "../types";

export class DemoSender implements EmailSender {
  readonly provider = "demo" as const;
  async send(params: SendEmailParams): Promise<SendEmailResult> {
    const toLabel = [params.to, ...(params.additionalTo ?? [])].join(", ");
    const ccLabel =
      params.cc && params.cc.length > 0 ? `, cc: ${params.cc.join(", ")}` : "";
    const bccLabel =
      params.bcc && params.bcc.length > 0
        ? `, bcc: ${params.bcc.join(", ")}`
        : "";
    const attLabel =
      params.attachments && params.attachments.length > 0
        ? `, attachments: ${params.attachments.map((a) => a.filename).join(", ")}`
        : "";
    console.log(
      `[demo] Pretending to send email from ${params.from} to ${toLabel}${ccLabel}${bccLabel}${attLabel} (subject: "${params.subject}")`,
    );
    return { id: `demo_${nanoid(10)}`, error: null };
  }

  recipientSupport() {
    return { multipleTo: true, bcc: true };
  }

  maxAttachmentBytes(): number {
    return 25 * 1024 * 1024;
  }

  maxMessageBytes(): number {
    return 25 * 1024 * 1024;
  }
}
