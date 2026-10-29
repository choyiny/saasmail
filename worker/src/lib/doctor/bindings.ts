import { sql } from "drizzle-orm";
import {
  BavimailSender,
  CloudflareSender,
  createEmailSender,
  DemoSender,
  NoopSender,
  PostmarkSender,
  ResendSender,
} from "../email-sender";
import { readSendingPause } from "../sending-controls";
import { count, isLocalUrl, type Check } from "./types";

const REQUIRED = [
  "DB",
  "R2",
  "EMAIL_QUEUE",
  "NOTIFICATIONS_HUB",
  "MAIL_AGENT",
] as const;

const bound = (env: CloudflareBindings, name: string) =>
  !!(env as unknown as Record<string, unknown>)[name];

/**
 * By `instanceof`, never `constructor.name`: a minified bundle renames classes.
 * The class name is in the summary so `yarn doctor` can tell the provider.
 */
function providerName(sender: unknown): string {
  if (sender instanceof DemoSender) return "demo mode (DemoSender)";
  if (sender instanceof BavimailSender) return "Bavimail (BavimailSender)";
  if (sender instanceof PostmarkSender) return "Postmark (PostmarkSender)";
  if (sender instanceof ResendSender) return "Resend (ResendSender)";
  if (sender instanceof CloudflareSender)
    return "Cloudflare Email Sending (CloudflareSender)";
  if (sender instanceof NoopSender) return "none (NoopSender)";
  return "an unknown sender";
}

export const bindingChecks: Check[] = [
  {
    id: "bindings.required",
    group: "bindings",
    mandatory: true,
    async run({ env }) {
      const missing = REQUIRED.filter((name) => !bound(env, name));
      return missing.length > 0
        ? {
            status: "fail",
            summary: `Missing binding${missing.length === 1 ? "" : "s"}: ${missing.join(", ")}.`,
            hint: "Add them to the Wrangler config (see wrangler.jsonc.example) and deploy again.",
          }
        : {
            status: "pass",
            summary: `Bound: ${REQUIRED.join(", ")}.`,
          };
    },
  },
  {
    id: "bindings.ai",
    group: "bindings",
    mandatory: false,
    async run({ env }) {
      return bound(env, "AI")
        ? { status: "pass", summary: "Workers AI is bound." }
        : {
            status: "warn",
            summary:
              "Workers AI (AI) is not bound: the agent and AI filing need ANTHROPIC_API_KEY or OPENAI_API_KEY.",
            hint: 'Add `"ai": { "binding": "AI" }` to the Wrangler config, or set one of the keys.',
          };
    },
  },
  {
    id: "bindings.backups",
    group: "bindings",
    mandatory: false,
    async run({ env }) {
      return bound(env, "BACKUPS")
        ? { status: "pass", summary: "A backup bucket (BACKUPS) is bound." }
        : {
            status: "info",
            summary:
              "No BACKUPS bucket: backups go to the attachments bucket under backups/.",
          };
    },
  },
  {
    id: "bindings.gmail_backfill",
    group: "bindings",
    mandatory: false,
    async run({ env, db }) {
      if (bound(env, "GMAIL_BACKFILL")) {
        return {
          status: "pass",
          summary: "The Gmail import workflow is bound.",
        };
      }
      const row = await db.get<{ n: number }>(
        sql`SELECT EXISTS (SELECT 1 FROM gmail_accounts) AS n`,
      );
      return count(row) > 0
        ? {
            status: "info",
            summary:
              "GMAIL_BACKFILL is not bound: Gmail imports run inside the cron sync, more slowly.",
          }
        : {
            status: "info",
            summary: "GMAIL_BACKFILL is not bound (no Gmail account).",
          };
    },
  },
  {
    id: "provider.outbound",
    group: "provider",
    mandatory: true,
    async run({ env, db }) {
      const sender = createEmailSender(env);
      const name = providerName(sender);
      const local = isLocalUrl((env as { BASE_URL?: string }).BASE_URL);
      if (sender instanceof DemoSender) {
        return local
          ? { status: "info", summary: `Outbound provider: ${name}.` }
          : {
              status: "fail",
              summary: `Outbound provider: ${name} on a public address: no mail is sent.`,
              hint: "Remove DEMO_MODE from the deployment's vars.",
            };
      }
      if (sender instanceof NoopSender) {
        const row = await db.get<{ n: number }>(
          sql`SELECT EXISTS (SELECT 1 FROM sender_identities WHERE source IN ('gmail', 'outlook')) AS n`,
        );
        const hint =
          "Set RESEND_API_KEY, POSTMARK_API_KEY or BAVIMAIL_API_KEY, or bind Cloudflare Email Sending (EMAIL).";
        return count(row) > 0
          ? {
              status: "warn",
              summary: `Outbound provider: ${name}. Only replies from mapped inboxes can send; new mail, campaigns and sequences use the configured provider.`,
              hint,
            }
          : {
              status: "fail",
              summary: `Outbound provider: ${name}. No mail can be sent.`,
              hint,
            };
      }
      return { status: "pass", summary: `Outbound provider: ${name}.` };
    },
  },
  {
    id: "provider.mailbox_errors",
    group: "provider",
    mandatory: false,
    async run({ db }) {
      const row = await db.get<{ gmail: number; outlook: number }>(
        sql`SELECT
          (SELECT COUNT(*) FROM gmail_accounts WHERE last_error IS NOT NULL) AS gmail,
          (SELECT COUNT(*) FROM outlook_accounts WHERE last_error IS NOT NULL) AS outlook`,
      );
      const parts = [
        Number(row?.gmail ?? 0) > 0 && `Gmail ${row?.gmail}`,
        Number(row?.outlook ?? 0) > 0 && `Outlook ${row?.outlook}`,
      ].filter(Boolean);
      return parts.length > 0
        ? {
            status: "warn",
            summary: `Connected mailboxes with a sync error: ${parts.join(", ")}.`,
            hint: "Reconnect them on the Inboxes page.",
          }
        : {
            status: "pass",
            summary: "No connected mailbox reports an error.",
          };
    },
  },
  {
    id: "provider.paused",
    group: "provider",
    mandatory: false,
    async run({ db }) {
      const pause = await readSendingPause(db);
      return pause
        ? {
            status: "warn",
            summary: "Outbound sending is paused: messages are queued.",
            hint: "Resume it in Settings → Sending controls.",
          }
        : { status: "pass", summary: "Outbound sending is running." };
    },
  },
];
