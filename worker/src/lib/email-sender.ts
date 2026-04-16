import { Resend } from "resend";

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
  provider: "resend" | "cloudflare" | "none";
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
      const result = await this.binding.send({
        from: params.from,
        to: params.to,
        subject: params.subject,
        html: params.html,
        text: params.text,
        headers: params.headers,
      });
      return { id: result.messageId, error: null };
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

export function createEmailSender(
  env: CloudflareBindings & { RESEND_API_KEY?: string; EMAIL?: SendEmail },
): EmailSender {
  if (env.RESEND_API_KEY) {
    return new ResendSender(env.RESEND_API_KEY);
  }
  if (env.EMAIL) {
    return new CloudflareSender(env.EMAIL);
  }
  return new NoopSender();
}
