import { createMimeMessage, Mailbox } from "mimetext/browser";
import type { SendEmailParams } from "../types";
import { parseFrom, toBase64 } from "../shared";
import { inlineDataImages } from "../inline-images";

/**
 * A reply as a raw RFC 5322 message, for the providers that take MIME rather
 * than structured fields: Gmail (`messages.send`) and Outlook (`sendMail`).
 * Headers from `params.headers` — Message-ID, In-Reply-To, References — are
 * written as given, which is what threads the reply and what lets the
 * provider's Sent copy be recognised as saasmail's own.
 */
export function buildMimeMessage(input: SendEmailParams): string {
  const params = inlineDataImages(input);
  const { name, address } = parseFrom(params.from);
  const msg = createMimeMessage();
  msg.setSender(name ? { name, addr: address } : { addr: address });
  if (params.additionalTo && params.additionalTo.length > 0) {
    msg.setRecipient([params.to, ...params.additionalTo].map(mailbox));
  } else {
    msg.setRecipient(params.to);
  }
  if (params.cc && params.cc.length > 0) {
    msg.setCc(params.cc.map(mailbox));
  }
  // Gmail and Microsoft deliver to a Bcc header's addresses and remove it
  // from the copy the other recipients get.
  if (params.bcc && params.bcc.length > 0) {
    msg.setBcc(params.bcc.map(mailbox));
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
        ...(a.contentId
          ? { inline: true, headers: { "Content-ID": `<${a.contentId}>` } }
          : {}),
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

/** "Name <addr>" or a bare address, as mimetext's mailbox object. */
function mailbox(value: string): { name?: string; addr: string } {
  const parsed = parseFrom(value);
  return parsed.name
    ? { name: parsed.name, addr: parsed.address }
    : { addr: parsed.address };
}
