import type { EmailSender, SendEmailParams, SendEmailResult } from "../types";
import { toBase64 } from "../shared";
import { inlineDataImages } from "../inline-images";
import { transientFromStatus, classifyErrorMessage } from "../classify";

/** Postmark's "inactive recipient" error: the address is on their suppression list. */
const POSTMARK_INACTIVE_RECIPIENT = 406;

/**
 * Pull the addresses out of a Postmark 406 message. The wording has shifted
 * over the years ("a recipient" / "recipient(s)", sentences separated by
 * spaces or newlines), but the list always sits between "inactive
 * addresses:" and the sentence-ending period before "Inactive recipients".
 * Postmark reports bare, lowercased addresses.
 */
export function parsePostmarkInactiveAddresses(message: string): string[] {
  const match =
    /inactive addresses:\s*([\s\S]*?)\.\s*(?:Inactive recipients|$)/i.exec(
      message,
    );
  if (!match) return [];
  return match[1]
    .split(/[,;\s]+/)
    .map((a) => a.trim().toLowerCase())
    .filter((a) => a.includes("@"));
}

/**
 * The recipients a Postmark error says are permanently undeliverable, or
 * undefined when the error isn't about recipients. A 406 whose message names
 * no addresses falls back to the request's recipients only when there was
 * exactly one — with several we can't tell which one was refused.
 */
function undeliverableFor(
  errorCode: number | undefined,
  message: string,
  recipients: string[],
): string[] | undefined {
  if (errorCode !== POSTMARK_INACTIVE_RECIPIENT) return undefined;
  const parsed = parsePostmarkInactiveAddresses(message);
  if (parsed.length > 0) return parsed;
  return recipients.length === 1 ? recipients : undefined;
}

/** The bare address out of a `"Name <addr>"` or bare recipient string. */
function bareAddress(value: string): string {
  const angle = /<([^>]+)>/.exec(value);
  return (angle ? angle[1] : value).trim().toLowerCase();
}

async function extractPostmarkError(
  res: Response,
): Promise<{ message: string; errorCode?: number }> {
  try {
    const data = (await res.json()) as { Message?: string; ErrorCode?: number };
    if (data.Message)
      return { message: data.Message, errorCode: data.ErrorCode };
  } catch {
    // fall through
  }
  return {
    message: `Postmark request failed: ${res.status} ${res.statusText}`.trim(),
  };
}

export class PostmarkSender implements EmailSender {
  readonly provider = "postmark" as const;
  private apiKey: string;
  private fetchFn: typeof fetch;

  constructor(apiKey: string, fetchFn?: typeof fetch) {
    this.apiKey = apiKey;
    // Bind to globalThis: invoking the global `fetch` as a method reference
    // (`this.fetchFn(...)`) throws "Illegal invocation" in the Cloudflare
    // Workers runtime. Tests inject their own fetch, so the unbound default
    // only ever runs in production — exactly where it would break.
    this.fetchFn = fetchFn ?? fetch.bind(globalThis);
  }

  async send(input: SendEmailParams): Promise<SendEmailResult> {
    try {
      const params = inlineDataImages(input);
      const payload: Record<string, unknown> = {
        From: params.from,
        To: params.to,
        Subject: params.subject,
        HtmlBody: params.html,
      };
      if (params.text) {
        payload.TextBody = params.text;
      }
      if (params.cc && params.cc.length > 0) {
        payload.Cc = params.cc.join(",");
      }
      if (params.headers) {
        const entries = Object.entries(params.headers);
        // Postmark has a dedicated ReplyTo field; everything else goes through
        // the generic Headers array.
        const replyTo = entries.find(([k]) => k.toLowerCase() === "reply-to");
        if (replyTo) {
          payload.ReplyTo = replyTo[1];
        }
        const rest = entries.filter(([k]) => k.toLowerCase() !== "reply-to");
        if (rest.length > 0) {
          payload.Headers = rest.map(([Name, Value]) => ({ Name, Value }));
        }
      }
      if (params.attachments && params.attachments.length > 0) {
        payload.Attachments = params.attachments.map((a) => ({
          Name: a.filename,
          Content: toBase64(a.content),
          ContentType: a.contentType,
          ...(a.contentId ? { ContentID: `cid:${a.contentId}` } : {}),
        }));
      }

      const res = await this.fetchFn("https://api.postmarkapp.com/email", {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "X-Postmark-Server-Token": this.apiKey,
        },
        body: JSON.stringify(payload),
      });

      const recipients = [params.to, ...(params.cc ?? [])].map(bareAddress);

      if (!res.ok) {
        const { message, errorCode } = await extractPostmarkError(res);
        const undeliverable = undeliverableFor(errorCode, message, recipients);
        return {
          id: null,
          error: {
            message,
            transient: undeliverable ? false : transientFromStatus(res.status),
            ...(undeliverable ? { undeliverable } : {}),
          },
        };
      }

      const data = (await res.json().catch(() => ({}))) as {
        MessageID?: string;
        ErrorCode?: number;
        Message?: string;
      };
      // Postmark can return HTTP 200 with a non-zero ErrorCode on some failures.
      if (data.ErrorCode && data.ErrorCode !== 0) {
        const message = data.Message ?? `Postmark error ${data.ErrorCode}`;
        const undeliverable = undeliverableFor(
          data.ErrorCode,
          message,
          recipients,
        );
        return {
          id: null,
          error: {
            message,
            transient: undeliverable ? false : classifyErrorMessage(message),
            ...(undeliverable ? { undeliverable } : {}),
          },
        };
      }
      return { id: data.MessageID ?? null, error: null };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      console.error(
        "[PostmarkSender] send failed:",
        message,
        e instanceof Error ? e.stack : "",
      );
      return { id: null, error: { message, transient: true } };
    }
  }

  maxAttachmentBytes(): number {
    // Postmark caps total message size at 10 MB; base64 inflates ~1.4x.
    return Math.floor((10 * 1024 * 1024) / 1.4);
  }
}
