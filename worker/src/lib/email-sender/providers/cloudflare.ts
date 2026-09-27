import type {
  EmailSender,
  SendEmailAttachment,
  SendEmailParams,
  SendEmailResult,
} from "../types";
import { parseFrom } from "../shared";
import { classifyErrorMessage } from "../classify";

/**
 * Headers Cloudflare generates itself; sending one fails the whole message with
 * E_HEADER_NOT_ALLOWED. The Message-ID Cloudflare assigns comes back in the
 * result instead.
 * https://developers.cloudflare.com/email-service/reference/headers/
 */
const PLATFORM_HEADERS = new Set([
  "message-id",
  "date",
  "mime-version",
  "content-type",
  "content-transfer-encoding",
]);

/** Failures that retrying won't fix: configuration, recipients, the message itself. */
const PERMANENT_CODES = new Set([
  "E_SENDER_NOT_VERIFIED",
  "E_RECIPIENT_NOT_ALLOWED",
  "E_RECIPIENT_SUPPRESSED",
  "E_TOO_MANY_RECIPIENTS",
  "E_TOO_MANY_ATTACHMENTS",
]);

type Address = string | { email: string; name: string };

/** "Name <addr>" as Cloudflare's address object; a bare address as a string. */
function address(value: string): Address {
  const { name, address: email } = parseFrom(value);
  return name ? { email, name } : email;
}

function attachment(a: SendEmailAttachment) {
  const base = {
    filename: a.filename,
    type: a.contentType,
    // Bytes, although the docs also allow a base64 string: live, Cloudflare
    // sent such a string verbatim instead of decoding it. Known Cloudflare
    // quirks with bytes (docs/email-providers.md): a text/* part arrives with a
    // line break appended, and an inline part loses its filename.
    content: a.content,
  };
  // A part is only inline when the HTML can reference it by Content-ID.
  return a.disposition === "inline" && a.contentId
    ? { disposition: "inline" as const, contentId: a.contentId, ...base }
    : { disposition: "attachment" as const, ...base };
}

/**
 * Cloudflare Email Service through the `send_email` binding's structured form,
 * which delivers to every To, Cc and Bcc. The raw `EmailMessage` form this
 * replaced has a single envelope recipient, so Cc was only ever a header.
 * https://developers.cloudflare.com/email-service/api/send-emails/workers-api/
 */
export class CloudflareSender implements EmailSender {
  readonly provider = "cloudflare" as const;
  constructor(private binding: SendEmail) {}

  async send(params: SendEmailParams): Promise<SendEmailResult> {
    let replyTo: Address | undefined;
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(params.headers ?? {})) {
      const lower = key.toLowerCase();
      if (lower === "reply-to") replyTo = address(value);
      else if (!PLATFORM_HEADERS.has(lower)) headers[key] = value;
    }
    try {
      const result = await this.binding.send({
        from: address(params.from),
        to: [address(params.to)],
        ...(params.cc && params.cc.length > 0
          ? { cc: params.cc.map(address) }
          : {}),
        ...(replyTo ? { replyTo } : {}),
        subject: params.subject,
        ...(params.html ? { html: params.html } : {}),
        ...(params.text ? { text: params.text } : {}),
        ...(Object.keys(headers).length > 0 ? { headers } : {}),
        ...(params.attachments && params.attachments.length > 0
          ? { attachments: params.attachments.map(attachment) }
          : {}),
        // The binding's declared types take plain-string recipients; the
        // service also accepts { email, name } objects, which keep names.
      } as unknown as Parameters<SendEmail["send"]>[0]);
      // Cloudflare generates the Message-ID (it is platform-controlled), so the
      // id it returns is the one recipients see.
      return {
        id: result?.messageId ?? null,
        deliveredMessageId: result?.messageId ?? null,
        error: null,
      };
    } catch (e) {
      const code =
        e && typeof e === "object" && "code" in e ? String(e.code) : null;
      const detail = e instanceof Error ? e.message : String(e);
      const message = code ? `${code}: ${detail}` : detail;
      // Surface the cause: this path was previously swallowed, making send
      // failures invisible in logs and the API response.
      console.error(
        "[CloudflareSender] send failed:",
        message,
        e instanceof Error ? e.stack : "",
      );
      const permanent =
        code !== null &&
        (PERMANENT_CODES.has(code) || code.startsWith("E_HEADER"));
      return {
        id: null,
        error: {
          message,
          transient: permanent ? false : classifyErrorMessage(message),
        },
      };
    }
  }

  maxAttachmentBytes(): number {
    // The 5 MiB cap is on the whole message; base64 grows attachments by about
    // 4/3 and headers and bodies need room, hence the 1.4 margin. Conservative,
    // not exact: the JMAP path measures the real message (maxMessageBytes).
    return Math.floor(this.maxMessageBytes() / 1.4);
  }

  maxMessageBytes(): number {
    // Cloudflare Email Service caps a message at 5 MiB (attachments included)
    // to arbitrary recipients; 25 MiB applies to verified destinations only.
    // https://developers.cloudflare.com/email-service/platform/limits/
    return 5 * 1024 * 1024;
  }
}
