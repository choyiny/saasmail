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

export interface SendEmailParams {
  from: string;
  to: string;
  subject: string;
  html: string;
  text?: string;
  headers?: Record<string, string>;
}

export interface SendEmailResult {
  id: string | null;
  error: { message: string } | null;
}

export interface EmailSender {
  provider: "resend" | "cloudflare" | "none" | "demo";
  send(params: SendEmailParams): Promise<SendEmailResult>;
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
      subject: params.subject,
      html: params.html,
      text: params.text,
      headers: params.headers,
    });
    if (result.error) {
      return {
        id: null,
        error: { message: result.error.message ?? "Resend send failed" },
      };
    }
    return { id: result.data?.id ?? null, error: null };
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
      msg.setSubject(params.subject);
      if (params.text) {
        msg.addMessage({ contentType: "text/plain", data: params.text });
      }
      if (params.html) {
        msg.addMessage({ contentType: "text/html", data: params.html });
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
}

class NoopSender implements EmailSender {
  readonly provider = "none" as const;
  async send(_: SendEmailParams): Promise<SendEmailResult> {
    return { id: null, error: { message: "No email provider configured" } };
  }
}

class DemoSender implements EmailSender {
  readonly provider = "demo" as const;
  async send(params: SendEmailParams): Promise<SendEmailResult> {
    console.log(
      `[demo] Pretending to send email from ${params.from} to ${params.to} (subject: "${params.subject}")`,
    );
    return { id: `demo_${nanoid(10)}`, error: null };
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
