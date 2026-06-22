import type { EmailSender, SendEmailParams, SendEmailResult } from "../types";
import { toBase64 } from "../shared";

async function extractPostmarkError(res: Response): Promise<string> {
  try {
    const data = (await res.json()) as { Message?: string; ErrorCode?: number };
    if (data.Message) return data.Message;
  } catch {
    // fall through
  }
  return `Postmark request failed: ${res.status} ${res.statusText}`.trim();
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

  async send(params: SendEmailParams): Promise<SendEmailResult> {
    try {
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

      if (!res.ok) {
        return {
          id: null,
          error: { message: await extractPostmarkError(res) },
        };
      }

      const data = (await res.json().catch(() => ({}))) as {
        MessageID?: string;
        ErrorCode?: number;
        Message?: string;
      };
      // Postmark can return HTTP 200 with a non-zero ErrorCode on some failures.
      if (data.ErrorCode && data.ErrorCode !== 0) {
        return {
          id: null,
          error: {
            message: data.Message ?? `Postmark error ${data.ErrorCode}`,
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
      return { id: null, error: { message } };
    }
  }

  maxAttachmentBytes(): number {
    // Postmark caps total message size at 10 MB; base64 inflates ~1.4x.
    return Math.floor((10 * 1024 * 1024) / 1.4);
  }
}
