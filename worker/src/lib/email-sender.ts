import { Resend } from "resend";
import { nanoid } from "nanoid";
import { EmailMessage } from "cloudflare:email";
import { createMimeMessage } from "mimetext";
import { isDemoMode } from "./is-dev";

function parseFrom(input: string): { name?: string; address: string } {
  const match = input.match(/^\s*(.*)\s*<([^>]+)>\s*$/);
  if (match && match[2]) {
    const name = match[1].replace(/^"|"$/g, "").trim();
    return { name: name || undefined, address: match[2].trim() };
  }
  return { address: input.trim() };
}

export interface SendEmailAttachment {
  filename: string;
  contentType: string;
  /** Raw bytes. */
  content: ArrayBuffer | Uint8Array;
}

export interface SendEmailParams {
  from: string;
  to: string;
  /** Optional CC list — each entry can be a bare address or "Name <addr>". */
  cc?: string[];
  subject: string;
  html: string;
  text?: string;
  headers?: Record<string, string>;
  attachments?: SendEmailAttachment[];
}

export interface SendEmailResult {
  id: string | null;
  error: { message: string } | null;
}

export interface EmailSender {
  provider: "resend" | "cloudflare" | "none" | "demo";
  send(params: SendEmailParams): Promise<SendEmailResult>;
  maxAttachmentBytes(): number;
}

function toBase64(bytes: ArrayBuffer | Uint8Array): string {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  // btoa expects a binary string; chunk to avoid call-stack overflow on
  // large buffers.
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < u8.length; i += chunk) {
    binary += String.fromCharCode.apply(
      null,
      Array.from(u8.subarray(i, i + chunk)),
    );
  }
  return btoa(binary);
}

class ResendSender implements EmailSender {
  readonly provider = "resend" as const;
  private client: Resend;

  constructor(apiKey: string) {
    this.client = new Resend(apiKey);
  }

  async send(params: SendEmailParams): Promise<SendEmailResult> {
    const result = await this.client.emails.send({
      from: params.from,
      to: params.to,
      ...(params.cc && params.cc.length > 0 ? { cc: params.cc } : {}),
      subject: params.subject,
      html: params.html,
      text: params.text,
      headers: params.headers,
      ...(params.attachments && params.attachments.length > 0
        ? {
            attachments: params.attachments.map((a) => ({
              filename: a.filename,
              content: toBase64(a.content),
            })),
          }
        : {}),
    });
    if (result.error) {
      return {
        id: null,
        error: { message: result.error.message ?? "Resend send failed" },
      };
    }
    return { id: result.data?.id ?? null, error: null };
  }

  maxAttachmentBytes(): number {
    return 25 * 1024 * 1024;
  }
}

class CloudflareSender implements EmailSender {
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
          msg.setHeader(key, value);
        }
      }
      const message = new EmailMessage(address, params.to, msg.asRaw());
      const result = await this.binding.send(message);
      return { id: result?.messageId ?? null, error: null };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return { id: null, error: { message } };
    }
  }

  maxAttachmentBytes(): number {
    return Math.floor((25 * 1024 * 1024) / 1.4);
  }
}

class NoopSender implements EmailSender {
  readonly provider = "none" as const;
  async send(_: SendEmailParams): Promise<SendEmailResult> {
    return { id: null, error: { message: "No email provider configured" } };
  }

  maxAttachmentBytes(): number {
    return 0;
  }
}

class DemoSender implements EmailSender {
  readonly provider = "demo" as const;
  async send(params: SendEmailParams): Promise<SendEmailResult> {
    const ccLabel =
      params.cc && params.cc.length > 0 ? `, cc: ${params.cc.join(", ")}` : "";
    const attLabel =
      params.attachments && params.attachments.length > 0
        ? `, attachments: ${params.attachments.map((a) => a.filename).join(", ")}`
        : "";
    console.log(
      `[demo] Pretending to send email from ${params.from} to ${params.to}${ccLabel}${attLabel} (subject: "${params.subject}")`,
    );
    return { id: `demo_${nanoid(10)}`, error: null };
  }

  maxAttachmentBytes(): number {
    return 25 * 1024 * 1024;
  }
}

export function createEmailSender(
  env: CloudflareBindings & { RESEND_API_KEY?: string; EMAIL?: SendEmail },
): EmailSender {
  if (isDemoMode(env)) {
    return new DemoSender();
  }
  if (env.RESEND_API_KEY) {
    return new ResendSender(env.RESEND_API_KEY);
  }
  if (env.EMAIL) {
    return new CloudflareSender(env.EMAIL);
  }
  return new NoopSender();
}
