import type { EmailSender, SendEmailParams, SendEmailResult } from "../types";
import { toBase64 } from "../shared";
import { classifyErrorMessage, transientFromStatus } from "../classify";
import { sendMime } from "../../outlook/api";
import { MicrosoftAuthError } from "../../outlook/oauth";
import { buildMimeMessage } from "./mime";

const UNAUTHORIZED = 401;

/**
 * Graph caps a request body at 4 MB, and the MIME travels base64-encoded
 * twice over: attachments inside the message, then the whole message in the
 * request. So the raw attachments must fit in 4 MB / (4/3)².
 */
const GRAPH_MAX_REQUEST_BYTES = 4 * 1024 * 1024;
export const OUTLOOK_MAX_ATTACHMENT_BYTES = Math.floor(
  GRAPH_MAX_REQUEST_BYTES / ((4 / 3) * (4 / 3)),
);

/** Re-authorize after a 401: refresh the token and hand back the new one. */
export type OutlookReauthorize = () => Promise<string>;

async function readJson(res: Response): Promise<any> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

function graphErrorMessage(res: Response, data: any): string {
  const message = data?.error?.message;
  if (typeof message === "string" && message) return message;
  return `Outlook request failed: ${res.status} ${res.statusText}`.trim();
}

/**
 * Sends a reply through the connected Outlook mailbox with Graph's
 * `sendMail`, as MIME, so it leaves from the mailbox itself — signed by
 * Microsoft, in its Sent Items, and threaded by its In-Reply-To/References.
 *
 * Graph answers 202 with no body, so a successful send has no id
 * (`id: null`). The Sent Items copy is recognised later by its Message-ID,
 * which saasmail wrote (see `mirrorSentMessage`).
 */
export class OutlookSender implements EmailSender {
  readonly provider = "outlook" as const;
  readonly accountId: string | null;
  private tokenSource: string | (() => Promise<string>);
  private fetchFn: typeof fetch;
  private reauthorize: OutlookReauthorize | null;

  constructor(
    accessToken: string | (() => Promise<string>),
    fetchFn?: typeof fetch,
    opts?: { accountId?: string; reauthorize?: OutlookReauthorize },
  ) {
    this.tokenSource = accessToken;
    this.accountId = opts?.accountId ?? null;
    this.reauthorize = opts?.reauthorize ?? null;
    this.fetchFn = fetchFn ?? fetch.bind(globalThis);
  }

  maxAttachmentBytes(): number {
    return OUTLOOK_MAX_ATTACHMENT_BYTES;
  }

  private async resolveToken(): Promise<string> {
    return typeof this.tokenSource === "function"
      ? this.tokenSource()
      : this.tokenSource;
  }

  async send(params: SendEmailParams): Promise<SendEmailResult> {
    try {
      const raw = buildMimeMessage(params);
      const body = toBase64(new TextEncoder().encode(raw));

      let res = await sendMime(await this.resolveToken(), body, this.fetchFn);

      // A cached token Microsoft has stopped honouring: refresh once.
      if (res.status === UNAUTHORIZED && this.reauthorize) {
        let refreshed: string;
        try {
          refreshed = await this.reauthorize();
        } catch (e) {
          const code =
            e instanceof MicrosoftAuthError ? e.code : "reauthorize_failed";
          console.error(
            `[OutlookSender] re-authorizing the mailbox failed: ${code}`,
          );
          return {
            id: null,
            error: {
              message:
                "Microsoft rejected saasmail's access to this mailbox and " +
                "re-authorizing it failed. The grant looks revoked — " +
                "reconnect this mailbox on the Inboxes page.",
              transient: false,
              reconnect: true,
            },
          };
        }
        res = await sendMime(refreshed, body, this.fetchFn);
        if (res.status === UNAUTHORIZED) {
          const data = await readJson(res);
          return {
            id: null,
            error: {
              message:
                "Microsoft rejected saasmail's access to this mailbox even " +
                `after re-authorizing (${graphErrorMessage(res, data)}). ` +
                "Reconnect this mailbox on the Inboxes page.",
              transient: false,
              reconnect: true,
            },
          };
        }
      }

      if (res.status === 202 || res.ok) {
        return { id: null, error: null };
      }
      const data = await readJson(res);
      return {
        id: null,
        error: {
          message: graphErrorMessage(res, data),
          transient: transientFromStatus(res.status),
        },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        id: null,
        error: { message, transient: classifyErrorMessage(message) },
      };
    }
  }
}
