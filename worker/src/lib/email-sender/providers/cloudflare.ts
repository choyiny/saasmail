import { EmailMessage } from "cloudflare:email";
import { createMimeMessage, Mailbox } from "mimetext";
import type { EmailSender, SendEmailParams, SendEmailResult } from "../types";
import { parseFrom, toBase64 } from "../shared";

export class CloudflareSender implements EmailSender {
  readonly provider = "cloudflare" as const;
  constructor(private binding: SendEmail) {}

  async send(params: SendEmailParams): Promise<SendEmailResult> {
    try {
      const { name, address } = parseFrom(params.from);
      const msg = createMimeMessage();
      msg.setSender(name ? { name, addr: address } : { addr: address });
      msg.setRecipient(params.to);
      if (params.cc && params.cc.length > 0) {
        for (const c of params.cc) {
          const parsed = parseFrom(c);
          msg.setCc(
            parsed.name
              ? { name: parsed.name, addr: parsed.address }
              : { addr: parsed.address },
          );
        }
      }
      msg.setSubject(params.subject);
      if (params.text) {
        msg.addMessage({ contentType: "text/plain", data: params.text });
      }
      if (params.html) {
        msg.addMessage({ contentType: "text/html", data: params.html });
      }
      if (params.attachments) {
        for (const a of params.attachments) {
          msg.addAttachment({
            filename: a.filename,
            contentType: a.contentType,
            data: toBase64(a.content),
          });
        }
      }
      if (params.headers) {
        for (const [key, value] of Object.entries(params.headers)) {
          // Reply-To is a predefined address-type header in mimetext, so a bare
          // string fails its mailbox validate/dump (unlike plain headers like
          // Message-ID / In-Reply-To). Wrap it in a Mailbox so it serializes.
          if (key.toLowerCase() === "reply-to") {
            // mimetext defines Reply-To as a single-mailbox header
            // (validateMailboxSingle), so it needs one Mailbox, not an array.
            msg.setHeader(key, new Mailbox(value));
          } else {
            msg.setHeader(key, value);
          }
        }
      }
      const message = new EmailMessage(address, params.to, msg.asRaw());
      const result = await this.binding.send(message);
      return { id: result?.messageId ?? null, error: null };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      // Surface the cause: this path was previously swallowed, making send
      // failures invisible in logs and the API response.
      console.error(
        "[CloudflareSender] send failed:",
        message,
        e instanceof Error ? e.stack : "",
      );
      return { id: null, error: { message } };
    }
  }

  maxAttachmentBytes(): number {
    return Math.floor((25 * 1024 * 1024) / 1.4);
  }
}
