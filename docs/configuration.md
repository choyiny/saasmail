[saasmail](../README.md) › [Docs](README.md) › **Configuration**

# Configuration

Two files, both gitignored, both created from a committed example. Neither
ships with your deployment's values — each deployer maintains their own.

## wrangler.jsonc

Your Cloudflare Workers configuration. Created from `wrangler.jsonc.example`. This file is gitignored so each deployer maintains their own config. Key sections:

- `d1_databases` — D1 database binding
- `r2_buckets` — R2 bucket for attachments
- `queues` — Queue for sequence email processing
- `triggers.crons` — Hourly cron to check for due sequence emails
- `send_email` (optional) — Binding for Cloudflare Email Sending
- `vars.BASE_URL` — Your deployed URL (used for OAuth redirects and BetterAuth)
- `vars.TRUSTED_ORIGINS` — CORS allowed origins
- `vars.COOKIE_PREFIX` — Prefix for better-auth session cookies
- `vars.VAPID_PUBLIC_KEY` / `vars.VAPID_SUBJECT` — public VAPID config for
  browser push notifications. Generate with `yarn vapid:generate` and store
  the private key via `wrangler secret put VAPID_PRIVATE_KEY`. Leave blank
  to disable push.

To rebrand the UI, drop a replacement `public/saasmail-logo.png` — it's used as both the favicon and the in-app logo. The `/saasmail-onboarding` skill will do this for you interactively.

## .dev.vars

Local development secrets. Created from `.dev.vars.example`. This file is gitignored.

- `vars.PROVIDER_DAILY_SEND_LIMIT` — optional. Refuses to start a newsletter
  campaign that would push the sending identity past this many messages in 24
  hours. Unset by default, in which case the check is skipped entirely. Set it
  to your provider's real daily quota so an oversized blast is refused up front
  rather than discovered half-delivered.
- `BAVIMAIL_API_KEY` — Bavimail API bearer token (required for Bavimail, must be paired with `BAVIMAIL_ALIAS_ID`)
- `BAVIMAIL_ALIAS_ID` — Bavimail alias UUID identifying the sending alias (required for Bavimail)
- `POSTMARK_API_KEY` — Postmark server API token (if using Postmark)
- `RESEND_API_KEY` — Resend API key (if using Resend)
- `BETTER_AUTH_SECRET` — Secret for session signing
- `UNSUBSCRIBE_SECRET` — Secret used to HMAC-sign one-click unsubscribe tokens. Generate with `openssl rand -hex 32`. Set in prod via `wrangler secret put UNSUBSCRIBE_SECRET`. Required for the [suppressions/unsubscribe](suppressions.md) feature.
- `DISABLE_PASSKEY_GATE` — Local-only: set to `"true"` to skip the server-side passkey requirement so you can sign in with email+password during development. **Never set this in production.**

In production these are Cloudflare secrets (`wrangler secret put …`), not
entries in this file.

---

**See also:** [Setup](setup.md) · [Email providers](email-providers.md) · [Local development](development.md)
