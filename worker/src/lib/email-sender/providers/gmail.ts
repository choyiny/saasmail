import { createMimeMessage, Mailbox } from "mimetext/browser";
import type { EmailSender, SendEmailParams, SendEmailResult } from "../types";
import { parseFrom, toBase64 } from "../shared";
import { transientFromStatus } from "../classify";

const SEND_URL = "https://gmail.googleapis.com/gmail/v1/users/me/messages/send";

/**
 * Gmail's messages.send endpoint requires the RFC822 message as base64url
 * (`-`/`_` in place of `+`/`/`, padding stripped) — standard base64 is
 * silently rejected and surfaces as a mysterious 400 with no hint why.
 * Exported so the encoding itself can be pinned by a direct unit test.
 */
export function toBase64Url(bytes: ArrayBuffer | Uint8Array): string {
  return toBase64(bytes)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** Parse defensively: an outage can return HTML with a 200, and an
 * unguarded res.json() would throw a SyntaxError no caller branches on. */
async function readJson(res: Response): Promise<any> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

function extractGmailError(res: Response, data: any): string {
  const message = data?.error?.message;
  if (typeof message === "string" && message) return message;
  return `Gmail request failed: ${res.status} ${res.statusText}`.trim();
}

export class GmailSender implements EmailSender {
  readonly provider = "gmail" as const;
  private tokenSource: string | (() => Promise<string>);
  private fetchFn: typeof fetch;

  /**
   * Takes an access token, or a function that resolves one on demand — but
   * never a database handle. Deciding *which* token to use (looking up the
   * mapped Gmail account, refreshing it) is the next task's job; this class
   * only knows how to send with whatever token it's given.
   */
  constructor(
    accessToken: string | (() => Promise<string>),
    fetchFn?: typeof fetch,
  ) {
    this.tokenSource = accessToken;
    // Bind to globalThis: invoking the global `fetch` as a method reference
    // (`this.fetchFn(...)`) throws "Illegal invocation" in the Cloudflare
    // Workers runtime. Tests inject their own fetch, so the unbound default
    // only ever runs in production — exactly where it would break.
    this.fetchFn = fetchFn ?? fetch.bind(globalThis);
  }

  private async resolveToken(): Promise<string> {
    return typeof this.tokenSource === "function"
      ? this.tokenSource()
      : this.tokenSource;
  }

  async send(params: SendEmailParams): Promise<SendEmailResult> {
    try {
      const { name, address } = parseFrom(params.from);
      const msg = createMimeMessage();
      msg.setSender(name ? { name, addr: address } : { addr: address });
      msg.setRecipient(params.to);
      if (params.cc && params.cc.length > 0) {
        // setCc REPLACES the Cc header rather than appending to it, so
        // calling it once per address (as a loop would) keeps only the
        // last one — silently dropping every earlier recipient. Build the
        // full array first and call it exactly once.
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
          // Reply-To is a predefined address-type header in mimetext, so a
          // bare string fails its mailbox validate/dump (unlike plain
          // headers like Message-ID / In-Reply-To). Wrap it in a Mailbox so
          // it serializes.
          if (key.toLowerCase() === "reply-to") {
            msg.setHeader(key, new Mailbox(value));
          } else {
            msg.setHeader(key, value);
          }
        }
      }

      const accessToken = await this.resolveToken();
      const body: Record<string, unknown> = {
        raw: toBase64Url(new TextEncoder().encode(msg.asRaw())),
      };
      // Threading a reply onto an existing Gmail conversation instead of
      // starting a new one is purely a matter of sending this alongside
      // `raw` — Gmail does the rest.
      if (params.threadId) {
        body.threadId = params.threadId;
      }

      const res = await this.fetchFn(SEND_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });

      const data = await readJson(res);

      if (!res.ok) {
        // The HTTP status is the reliable signal here (Gmail's error bodies
        // are terse and inconsistent): 429/5xx is worth retrying via the
        // outbox, 4xx like a malformed message or bad recipient is not.
        return {
          id: null,
          error: {
            message: extractGmailError(res, data),
            transient: transientFromStatus(res.status),
          },
        };
      }

      if (!data || typeof data.id !== "string") {
        // A 2xx with a body that didn't parse (e.g. an HTML outage page
        // slipped through) or that's missing the id Gmail always returns on
        // success. There's no status code to classify from, and a wasted
        // retry is cheaper than silently dropping the mail.
        return {
          id: null,
          error: {
            message: "Gmail returned a 2xx response with no message id",
            transient: true,
          },
        };
      }

      return {
        id: data.id,
        threadId: typeof data.threadId === "string" ? data.threadId : null,
        error: null,
      };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      console.error(
        "[GmailSender] send failed:",
        message,
        e instanceof Error ? e.stack : "",
      );
      return { id: null, error: { message, transient: true } };
    }
  }

  maxAttachmentBytes(): number {
    // Gmail's own cap on a single message, unrelated to Cloudflare's
    // (which budgets for base64 inflation against a different limit).
    return 25 * 1024 * 1024;
  }
}
