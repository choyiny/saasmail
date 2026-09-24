import { createMimeMessage, Mailbox } from "mimetext/browser";
import type { EmailSender, SendEmailParams, SendEmailResult } from "../types";
import { parseFrom, toBase64 } from "../shared";
import { classifyErrorMessage, transientFromStatus } from "../classify";
import { GoogleAuthError } from "../../gmail/oauth";

const SEND_URL = "https://gmail.googleapis.com/gmail/v1/users/me/messages/send";

/** Gmail's answer to a dead access token. */
const UNAUTHORIZED = 401;

/**
 * Gmail's own 25 MB ceiling on a single message, and the two encodings that
 * stand between an attachment's bytes and that ceiling.
 *
 * `messages.send` (the non-upload endpoint) carries the whole RFC822 message
 * base64url-encoded inside a JSON body, and the attachment is ALREADY base64
 * inside that message — so a byte of attachment costs 4/3 × 4/3 ≈ 1.78 bytes
 * on the wire. A flat 25 MB budget therefore lets through an attachment that
 * produces a ~44 MB request, which Gmail rejects; and because a Gmail reply
 * is never queued, that rejection is a dead end the user cannot retry past.
 * Budget against the ENCODED size so the limit we advertise is one Gmail can
 * actually accept.
 */
const GMAIL_MAX_MESSAGE_BYTES = 25 * 1024 * 1024;
const BASE64_INFLATION = 4 / 3;
export const GMAIL_MAX_ATTACHMENT_BYTES = Math.floor(
  GMAIL_MAX_MESSAGE_BYTES / (BASE64_INFLATION * BASE64_INFLATION),
);

/**
 * Forces a token refresh and returns the fresh token — see
 * `invalidateAccessToken`. Supplied by whoever owns the database handle;
 * `GmailSender` deliberately has none.
 */
export type GmailReauthorize = () => Promise<string>;

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
  /**
   * The `gmail_accounts` row this sender sends from, when the caller knew it.
   *
   * Gmail thread ids are per-mailbox, so a caller holding a parent message's
   * thread id needs to know WHICH mailbox it belongs to before passing it as
   * `threadId` — see the guard in `replyToEmail`.
   */
  readonly accountId: string | null;
  private tokenSource: string | (() => Promise<string>);
  private fetchFn: typeof fetch;
  private reauthorize: GmailReauthorize | null;

  /**
   * Takes an access token, or a function that resolves one on demand — but
   * never a database handle. Deciding *which* token to use (looking up the
   * mapped Gmail account, refreshing it) belongs to `createSenderForInbox`;
   * this class only knows how to send with whatever token it's given, and how
   * to ask for one more when Gmail says the one it has is dead.
   */
  constructor(
    accessToken: string | (() => Promise<string>),
    fetchFn?: typeof fetch,
    opts?: { accountId?: string; reauthorize?: GmailReauthorize },
  ) {
    this.tokenSource = accessToken;
    this.accountId = opts?.accountId ?? null;
    this.reauthorize = opts?.reauthorize ?? null;
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

  private post(
    body: Record<string, unknown>,
    accessToken: string,
  ): Promise<Response> {
    return this.fetchFn(SEND_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
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

      let res = await this.post(body, accessToken);

      // A 401 means the access token is dead. The commonest cause is a grant
      // revoked while a CACHED token was still inside its TTL: nothing
      // refreshes, so nothing ever discovers the revocation, and — because a
      // Gmail reply is deliberately never queued — every resend fails
      // identically with no outbox row, no audit row and no `lastError`.
      //
      // One forced refresh settles it. If it succeeds the token was merely
      // stale and the reply goes out; if it fails, `getAccessToken` has
      // recorded `lastError` on the account (so the admin route shows it) and
      // the caller is told to reconnect rather than to try again.
      if (res.status === UNAUTHORIZED && this.reauthorize) {
        let refreshed: string;
        try {
          refreshed = await this.reauthorize();
        } catch (e) {
          // The underlying error's text NEVER goes into this message. It
          // becomes a 502 body, and the reply route is reachable by any
          // authenticated user holding a permission on the inbox — not only
          // an admin. `reauthorize` is `invalidateAccessToken` +
          // `getAccessToken`, and `getAccessToken`'s last act is a D1 UPDATE
          // whose bound parameters are the plaintext access token and the
          // sealed refresh token; a D1 error carries its bound parameters in
          // its message. The same reasoning is written out at the OAuth
          // callback, which answers it by logging the message and never the
          // error — this is the response-body version of that rule.
          //
          // Nothing in that text was actionable anyway. What the user has to
          // do is in the fixed sentence below; the code goes to the log, for
          // whoever can read logs.
          const code =
            e instanceof GoogleAuthError ? e.code : "reauthorize_failed";
          console.error(
            `[GmailSender] re-authorizing the mailbox failed: ${code}`,
          );
          return {
            id: null,
            error: {
              message:
                "Gmail rejected saasmail's access to this mailbox and " +
                "re-authorizing it failed. The Google grant looks revoked — " +
                "reconnect this mailbox under Gmail settings.",
              transient: false,
              reconnect: true,
            },
          };
        }
        res = await this.post(body, refreshed);
        if (res.status === UNAUTHORIZED) {
          // A token minted seconds ago that Gmail still refuses: the grant
          // itself no longer carries the send scope for this mailbox.
          const data = await readJson(res);
          return {
            id: null,
            error: {
              message:
                "Gmail rejected saasmail's access to this mailbox even " +
                `after re-authorizing (${extractGmailError(res, data)}). ` +
                "Reconnect this mailbox under Gmail settings.",
              transient: false,
              reconnect: true,
            },
          };
        }
      }

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
        // slipped through a proxy) or that's missing the id Gmail always
        // returns on success.
        //
        // NOT transient, and the message says so plainly. A 2xx means Gmail
        // ACCEPTED the message and it is on its way to the customer — this is
        // the one error path on which retrying is unsafe, and calling it
        // transient produced "Gmail did not accept this reply… Send it again
        // to retry", which is both untrue and the worst advice available:
        // pressing send again delivers a second copy of a real reply.
        //
        // What is actually lost is the `sent_emails` row, since the id it
        // keys on never arrived. The Sent-folder mirror will pull the message
        // back onto the timeline on the next sync, so the reply is not
        // invisible either — it just is not ours to record.
        return {
          id: null,
          error: {
            message:
              "Gmail accepted this reply but did not return a message id, " +
              "so it could not be recorded on the timeline. The reply HAS " +
              "been sent — do not send it again; it will appear here after " +
              "the next sync.",
            transient: false,
            delivered: true,
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
      // Classified, not assumed: a malformed-message or validation failure
      // that threw is not something a retry can fix, and calling every one of
      // them transient invites a queue to re-attempt a send that can only
      // fail again.
      return {
        id: null,
        error: { message, transient: classifyErrorMessage(message) },
      };
    }
  }

  maxAttachmentBytes(): number {
    return GMAIL_MAX_ATTACHMENT_BYTES;
  }
}
