[saasmail](../README.md) › [Docs](README.md) › **Configuration**

# Configuration

Two files, both gitignored, both created from a committed example. Neither
ships with your deployment's values — each deployer maintains their own.

## wrangler.jsonc

Your Cloudflare Workers configuration. Created from `wrangler.jsonc.example`. This file is gitignored so each deployer maintains their own config. Key sections:

- `d1_databases` — D1 database binding
- `r2_buckets` — R2 bucket for attachments
- `queues` — Queue for sequence email processing
- `triggers.crons` — `*/15 * * * *`, every 15 minutes. One tick dispatches due
  sequence emails, processes the retry outbox, and polls every connected
  [Gmail mailbox](gmail.md). This is the cadence the Gmail integration rides
  on: change it and mail takes correspondingly longer to appear.
- `send_email` (optional) — Binding for Cloudflare Email Sending
- `vars.BASE_URL` — Your deployed URL (used for OAuth redirects and
  BetterAuth). The [Gmail integration](gmail.md) builds its Google redirect
  URI from it, so working locally means setting this to
  `http://localhost:8080` — pointed at production, every local Connect click
  sends you to the production callback.
- `vars.TRUSTED_ORIGINS` — CORS allowed origins
- `vars.COOKIE_PREFIX` — Prefix for better-auth session cookies
- `vars.VAPID_PUBLIC_KEY` / `vars.VAPID_SUBJECT` — public VAPID config for
  browser push notifications. Generate with `yarn vapid:generate` and store
  the private key via `wrangler secret put VAPID_PRIVATE_KEY`. Leave blank
  to disable push.

To rebrand the UI, drop a replacement `public/saasmail-logo.png` — it's used as both the favicon and the in-app logo. The `/saasmail-onboarding` skill will do this for you interactively.

## .dev.vars

Local development secrets. Created from `.dev.vars.example`. This file is gitignored.

- `BAVIMAIL_API_KEY` — Bavimail API bearer token (required for Bavimail, must be paired with `BAVIMAIL_ALIAS_ID`)
- `BAVIMAIL_ALIAS_ID` — Bavimail alias UUID identifying the sending alias (required for Bavimail)
- `POSTMARK_API_KEY` — Postmark server API token (if using Postmark)
- `RESEND_API_KEY` — Resend API key (if using Resend)
- `BETTER_AUTH_SECRET` — Secret for session signing
- `UNSUBSCRIBE_SECRET` — Secret used to HMAC-sign one-click unsubscribe tokens. Generate with `openssl rand -hex 32`. Set in prod via `wrangler secret put UNSUBSCRIBE_SECRET`. Required for the [suppressions/unsubscribe](suppressions.md) feature.
- `DISABLE_PASSKEY_GATE` — Local-only: set to `"true"` to skip the server-side passkey requirement so you can sign in with email+password during development. **Never set this in production.** Required for local [Gmail](gmail.md) work: the gate covers every `/api/*` route, including the OAuth callback Google redirects to, so without it a passkey-less admin never gets a mailbox connected.
- `GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET` — OAuth client credentials for the [Gmail integration](gmail.md), from an **Internal** consent screen. Set in prod via `wrangler secret put`.
- `TOKEN_ENCRYPTION_KEY` — Does two jobs for the [Gmail integration](gmail.md): it encrypts stored Gmail refresh tokens, and it is the HMAC secret that signs the OAuth `state` parameter carried through Google's consent screen. 32 random bytes, base64-encoded (`openssl rand -base64 32`). Set in prod via `wrangler secret put`. Never rotate this without reconnecting every mailbox. A key of the wrong length does not fail at connect time — it signs the state fine and then throws in the OAuth callback, which returns a bare `?gmail=error` with the reason only in the Worker log.

In production these are Cloudflare secrets (`wrangler secret put …`), not
entries in this file.

---

**See also:** [Setup](setup.md) · [Email providers](email-providers.md) · [Local development](development.md) · [Gmail on a local instance](gmail-local-setup.md)
