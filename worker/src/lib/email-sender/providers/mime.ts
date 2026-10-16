import { createMimeMessage, Mailbox } from "mimetext/browser";
import type { SendEmailParams } from "../types";
import { parseFrom, toBase64 } from "../shared";

/**
 * A reply as a raw RFC 5322 message, for the providers that take MIME rather
 * than structured fields: Gmail (`messages.send`) and Outlook (`sendMail`).
 * Headers from `params.headers` — Message-ID, In-Reply-To, References — are
 * written as given, which is what threads the reply and what lets the
 * provider's Sent copy be recognised as saasmail's own.
 */
export function buildMimeMessage(params: SendEmailParams): string {
  const { name, address } = parseFrom(params.from);
  const msg = createMimeMessage();
  msg.setSender(name ? { name, addr: address } : { addr: address });
  msg.setRecipient(params.to);
  if (params.cc && params.cc.length > 0) {
    msg.setCc(
      params.cc.map((c) => {
        const parsed = parseFrom(c);
        return parsed.name
          ? { name: parsed.name, addr: parsed.address }
          : { addr: parsed.address };
      }),
    );
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
      if (key.toLowerCase() === "reply-to") {
        msg.setHeader(key, new Mailbox(value));
      } else {
        msg.setHeader(key, value);
      }
    }
  }
  return msg.asRaw();
}
