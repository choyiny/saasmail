import { isDemoMode } from "../is-dev";
import type { EmailSender } from "./types";
import { ResendSender } from "./providers/resend";
import { CloudflareSender } from "./providers/cloudflare";
import { BavimailSender } from "./providers/bavimail";
import { PostmarkSender } from "./providers/postmark";
import { NoopSender } from "./providers/noop";
import { DemoSender } from "./providers/demo";

export type {
  SendEmailAttachment,
  SendEmailParams,
  SendEmailResult,
  SendEmailError,
  EmailSender,
} from "./types";
export { transientFromStatus, classifyErrorMessage } from "./classify";
export { ResendSender } from "./providers/resend";
export { CloudflareSender } from "./providers/cloudflare";
export { BavimailSender } from "./providers/bavimail";
export { PostmarkSender } from "./providers/postmark";
export { NoopSender } from "./providers/noop";
export { DemoSender } from "./providers/demo";

export function createEmailSender(
  env: CloudflareBindings & {
    RESEND_API_KEY?: string;
    EMAIL?: SendEmail;
    BAVIMAIL_API_KEY?: string;
    BAVIMAIL_ALIAS_ID?: string;
    POSTMARK_API_KEY?: string;
  },
): EmailSender {
  if (isDemoMode(env)) {
    return new DemoSender();
  }
  if (env.BAVIMAIL_API_KEY && env.BAVIMAIL_ALIAS_ID) {
    return new BavimailSender(env.BAVIMAIL_API_KEY, env.BAVIMAIL_ALIAS_ID);
  }
  if (env.POSTMARK_API_KEY) {
    return new PostmarkSender(env.POSTMARK_API_KEY);
  }
  if (env.RESEND_API_KEY) {
    return new ResendSender(env.RESEND_API_KEY);
  }
  if (env.EMAIL) {
    return new CloudflareSender(env.EMAIL);
  }
  return new NoopSender();
}
