import { sql } from "drizzle-orm";
import { isDevEnvironment } from "../is-dev";
import { count, isLocalUrl, type Check } from "./types";

/** The env as loose strings: secrets and vars the generated `Env` types narrowly. */
type Loose = Record<string, unknown>;
const value = (env: CloudflareBindings, name: string) =>
  (env as unknown as Loose)[name];
const isSet = (env: CloudflareBindings, name: string) => !!value(env, name);

const secretHint = (name: string) => `Run \`npx wrangler secret put ${name}\`.`;

export const secretChecks: Check[] = [
  {
    id: "secrets.better_auth",
    group: "secrets",
    mandatory: true,
    async run({ env }) {
      return isSet(env, "BETTER_AUTH_SECRET")
        ? { status: "pass", summary: "BETTER_AUTH_SECRET is set." }
        : {
            status: "fail",
            summary:
              "BETTER_AUTH_SECRET is not set: sessions are signed with the library's public default.",
            hint: secretHint("BETTER_AUTH_SECRET"),
          };
    },
  },
  {
    id: "secrets.unsubscribe",
    group: "secrets",
    mandatory: false,
    async run({ env, db }) {
      if (isSet(env, "UNSUBSCRIBE_SECRET")) {
        return { status: "pass", summary: "UNSUBSCRIBE_SECRET is set." };
      }
      const row = await db.get<{ n: number }>(
        sql`SELECT (EXISTS (SELECT 1 FROM lists) OR EXISTS (SELECT 1 FROM campaigns)) AS n`,
      );
      return {
        status: count(row) > 0 ? "fail" : "warn",
        summary:
          count(row) > 0
            ? "UNSUBSCRIBE_SECRET is not set and lists or campaigns exist: unsubscribe links cannot be signed."
            : "UNSUBSCRIBE_SECRET is not set: lists and campaigns will need it.",
        hint: secretHint("UNSUBSCRIBE_SECRET"),
      };
    },
  },
  {
    id: "secrets.vapid",
    group: "secrets",
    mandatory: false,
    async run({ env }) {
      const pub = isSet(env, "VAPID_PUBLIC_KEY");
      const priv = isSet(env, "VAPID_PRIVATE_KEY");
      if (pub && priv) {
        return { status: "pass", summary: "Push notification keys are set." };
      }
      if (!pub && !priv) {
        return {
          status: "info",
          summary: "Push notifications are off (no VAPID keys).",
          hint: "Run `yarn vapid:generate` to turn them on.",
        };
      }
      return {
        status: "warn",
        summary: `${pub ? "VAPID_PUBLIC_KEY" : "VAPID_PRIVATE_KEY"} is set without ${pub ? "VAPID_PRIVATE_KEY" : "VAPID_PUBLIC_KEY"}: push notifications cannot be sent.`,
        hint: "Set both keys from one `yarn vapid:generate` run.",
      };
    },
  },
  {
    id: "secrets.optional",
    group: "secrets",
    mandatory: false,
    async run({ env }) {
      const parts = ["BACKUP_ENCRYPTION_KEY", "AGENT_APPROVAL_SECRET"].map(
        (name) => `${name} ${isSet(env, name) ? "set" : "not set"}`,
      );
      return { status: "info", summary: `Optional: ${parts.join(", ")}.` };
    },
  },
  {
    id: "secrets.token_encryption",
    group: "secrets",
    mandatory: false,
    async run({ env, db }) {
      if (isSet(env, "TOKEN_ENCRYPTION_KEY")) {
        return { status: "pass", summary: "TOKEN_ENCRYPTION_KEY is set." };
      }
      // A Google app set by env vars is configured too: connecting Gmail
      // then fails without the key (lib/oauth-providers.ts; Microsoft has no
      // env fallback).
      const googleEnv =
        isSet(env, "GOOGLE_OAUTH_CLIENT_ID") &&
        isSet(env, "GOOGLE_OAUTH_CLIENT_SECRET");
      const row = await db.get<{ n: number }>(
        sql`SELECT (
          EXISTS (SELECT 1 FROM gmail_accounts)
          OR EXISTS (SELECT 1 FROM outlook_accounts)
          OR EXISTS (SELECT 1 FROM app_settings WHERE key IN ('oauth_provider:google', 'oauth_provider:microsoft'))
        ) AS n`,
      );
      return googleEnv || count(row) > 0
        ? {
            status: "fail",
            summary:
              "TOKEN_ENCRYPTION_KEY is not set while Gmail or Outlook is configured: connecting a mailbox fails and stored refresh tokens cannot be opened.",
            hint: secretHint("TOKEN_ENCRYPTION_KEY"),
          }
        : {
            status: "info",
            summary:
              "TOKEN_ENCRYPTION_KEY is not set (only Gmail and Outlook need it).",
          };
    },
  },
  {
    id: "secrets.dev_flags",
    group: "secrets",
    mandatory: true,
    async run({ env }) {
      const on = isDevEnvironment(env);
      if (!on) {
        return {
          status: "pass",
          summary: "DISABLE_PASSKEY_GATE and DEMO_MODE are off.",
        };
      }
      const flags = [
        value(env, "DISABLE_PASSKEY_GATE") === "true" && "DISABLE_PASSKEY_GATE",
        value(env, "DEMO_MODE") === "1" && "DEMO_MODE",
      ].filter(Boolean);
      if (isLocalUrl(value(env, "BASE_URL") as string | undefined)) {
        return {
          status: "info",
          summary: `${flags.join(" and ")} on, on a local address.`,
        };
      }
      return {
        status: "fail",
        summary: `${flags.join(" and ")} on while BASE_URL is not a local address: the passkey gate is off in production.`,
        hint: "Remove the flag from the deployment's vars and deploy again.",
      };
    },
  },
];
