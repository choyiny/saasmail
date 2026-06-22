import type {
  EmailSender,
  SendEmailAttachment,
  SendEmailParams,
  SendEmailResult,
} from "../types";
import { parseFrom } from "../shared";

async function extractBavimailError(res: Response): Promise<string> {
  try {
    const data = (await res.json()) as {
      message?: string;
      error?: string | { message?: string };
    };
    if (typeof data.error === "string") return data.error;
    if (data.error && typeof data.error === "object" && data.error.message) {
      return data.error.message;
    }
    if (data.message) return data.message;
  } catch {
    // fall through
  }
  return `Bavimail request failed: ${res.status} ${res.statusText}`.trim();
}

export class BavimailSender implements EmailSender {
  readonly provider = "bavimail" as const;
  constructor(
    private apiKey: string,
    private aliasId: string,
    private fetchFn: typeof fetch = fetch,
  ) {}

  async send(params: SendEmailParams): Promise<SendEmailResult> {
    try {
      let attachmentIds: string[] = [];
      if (params.attachments && params.attachments.length > 0) {
        const uploadResult = await this.uploadAttachments(params.attachments);
        if (uploadResult.error) {
          return { id: null, error: uploadResult.error };
        }
        attachmentIds = uploadResult.ids;
      }

      const toAddress = parseFrom(params.to).address;
      const ccAddresses = (params.cc ?? []).map((c) => parseFrom(c).address);

      const payload: Record<string, unknown> = {
        alias_id: this.aliasId,
        to_email: toAddress,
        subject: params.subject,
        body: params.html,
      };
      if (ccAddresses.length > 0) {
        payload.cc_emails = ccAddresses;
      }
      const inReplyTo = params.headers?.["In-Reply-To"];
      if (inReplyTo) {
        payload.in_reply_to = inReplyTo;
      }
      const replyTo = params.headers?.["Reply-To"];
      if (replyTo) {
        payload.reply_to = replyTo;
      }
      if (attachmentIds.length > 0) {
        payload.attachments = attachmentIds.map((id) => ({
          attachment_id: id,
          is_inline: false,
        }));
      }

      const res = await this.fetchFn("https://api.bavimail.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const message = await extractBavimailError(res);
        return { id: null, error: { message } };
      }

      const data = (await res.json().catch(() => ({}))) as { id?: string };
      return { id: data.id ?? null, error: null };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return { id: null, error: { message } };
    }
  }

  private async uploadAttachments(
    attachments: SendEmailAttachment[],
  ): Promise<
    | { ids: string[]; error: null }
    | { ids: never[]; error: { message: string } }
  > {
    const form = new FormData();
    for (const a of attachments) {
      const u8 =
        a.content instanceof Uint8Array ? a.content : new Uint8Array(a.content);
      // Blob copy to detach from any shared buffer.
      const blob = new Blob([u8], { type: a.contentType });
      form.append("files", blob, a.filename);
    }

    // IMPORTANT: do NOT set Content-Type — fetch sets it with the multipart
    // boundary automatically when the body is FormData.
    const res = await this.fetchFn("https://api.bavimail.com/attachments", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: form,
    });

    if (!res.ok) {
      const message = await extractBavimailError(res);
      return { ids: [], error: { message } };
    }

    const data = (await res.json().catch(() => ({}))) as {
      attachments?: Array<{ id?: string }>;
    };
    const ids = (data.attachments ?? [])
      .map((a) => a.id)
      .filter((id): id is string => typeof id === "string");

    if (ids.length !== attachments.length) {
      return {
        ids: [],
        error: {
          message: `Bavimail upload returned ${ids.length} ids for ${attachments.length} attachments`,
        },
      };
    }

    return { ids, error: null };
  }

  maxAttachmentBytes(): number {
    return 25 * 1024 * 1024;
  }
}
