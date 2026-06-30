import { isDemoMode } from "../is-dev";
import type { EmailSender } from "./types";
import { ResendSender } from "./providers/resend";
import { CloudflareSender } from "./providers/cloudflare";
import { BavimailSender } from "./providers/bavimail";
import { NoopSender } from "./providers/noop";
import { DemoSender } from "./providers/demo";

export type {
  SendEmailAttachment,
  SendEmailParams,
  SendEmailResult,
  EmailSender,
} from "./types";
export { ResendSender } from "./providers/resend";
export { CloudflareSender } from "./providers/cloudflare";
export { BavimailSender } from "./providers/bavimail";
export { NoopSender } from "./providers/noop";
export { DemoSender } from "./providers/demo";

export function createEmailSender(
  env: CloudflareBindings & {
    RESEND_API_KEY?: string;
    EMAIL?: SendEmail;
    BAVIMAIL_API_KEY?: string;
    BAVIMAIL_ALIAS_ID?: string;
  },
): EmailSender {
  if (isDemoMode(env)) {
    return new DemoSender();
  }
  if (env.BAVIMAIL_API_KEY && env.BAVIMAIL_ALIAS_ID) {
    return new BavimailSender(env.BAVIMAIL_API_KEY, env.BAVIMAIL_ALIAS_ID);
  }
  if (env.RESEND_API_KEY) {
    return new ResendSender(env.RESEND_API_KEY);
  }
  if (env.EMAIL) {
    return new CloudflareSender(env.EMAIL);
  }
  return new NoopSender();
}
