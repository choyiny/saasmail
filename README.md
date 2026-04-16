# cmail

Self-hosted email server on Cloudflare Workers.

Receive email with **Cloudflare Email Workers**. Send email with **Cloudflare Email Sending** or **Resend**. Manage everything through a dark-themed web UI.

## Provider Matrix

|               | Cloudflare         | Resend |
| ------------- | ------------------ | ------ |
| **Sending**   | ✅                 | ✅     |
| **Receiving** | ✅                 | ❌     |

Pick one outbound provider at deploy time:

- **Cloudflare Email Sending** — add a `send_email` binding (`EMAIL`) in `wrangler.jsonc` and onboard your domain at [Email Service](https://dash.cloudflare.com/?to=/:account/email-service).
- **Resend** — set `RESEND_API_KEY` as a secret.

If `RESEND_API_KEY` is set it takes precedence; otherwise the `EMAIL` binding is used. If neither is configured, send attempts return a "No email provider configured" error.

## Features

### Consolidated Inbox

All incoming email lands in one place. Senders are grouped and sorted by recency with unread counts. Click a sender to see the latest message, then open the thread sidebar to browse the full conversation history.

### Email Templates

Create reusable HTML email templates with `{{variable}}` interpolation. Edit templates with a live HTML editor, preview rendered output, and send them via the API or the UI. Variables are automatically extracted and validated before sending.

### Email Sequencing

Build multi-step drip campaigns. Enroll a sender into a sequence and cmail will send templated emails on a schedule. Supports step skipping, delay overrides, custom variables, and automatic cancellation when the sender replies.

## Architecture

| Layer             | Technology                              |
| ----------------- | --------------------------------------- |
| **Receive email** | Cloudflare Email Workers                |
| **Send email**    | Cloudflare Email Sending or Resend      |
| **Runtime**       | Cloudflare Workers + Hono               |
| **Database**      | Cloudflare D1 (SQLite)                  |
| **File storage**  | Cloudflare R2 (attachments)             |
| **Queue**         | Cloudflare Queues (sequence processing) |
| **Frontend**      | React + Tailwind CSS                    |
| **ORM**           | Drizzle                                 |
| **Auth**          | BetterAuth with passkey support         |

## Quick Start

### Prerequisites

- [Node.js](https://nodejs.org/) v18+
- [Yarn](https://yarnpkg.com/)
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/) (`npm install -g wrangler`)
- A [Cloudflare](https://dash.cloudflare.com/) account
- A [Resend](https://resend.com/) account and API key

> **Tip:** If you have [Claude Code](https://claude.ai/claude-code) installed, you can run `/cmail-onboarding` to walk through the setup interactively.

### 1. Clone and install

```bash
git clone https://github.com/choyiny/cmail.git
cd cmail
yarn install
```

### 2. Authenticate with Cloudflare

```bash
wrangler login
```

### 3. Create Cloudflare resources

```bash
# D1 database
wrangler d1 create cmail-db

# R2 bucket
wrangler r2 bucket create cmail-attachments

# Queue for email sequencing
wrangler queues create cmail-sequence-emails
```

### 4. Configure wrangler

Copy the example config and fill in your values:

```bash
cp wrangler.jsonc.example wrangler.jsonc
```

Edit `wrangler.jsonc`:

- Set `account_id` to your Cloudflare account ID
- Set the `database_id` in `d1_databases` to the ID from step 3
- Set `BASE_URL` to your deployed URL
- Set `TRUSTED_ORIGINS` to include your deployed URL

### 5. Configure secrets

Copy the example and fill in your values:

```bash
cp .dev.vars.example .dev.vars
```

Edit `.dev.vars`:

- `RESEND_API_KEY` — your Resend API key
- `BETTER_AUTH_SECRET` — generate a random string (`openssl rand -hex 32`)

For production, set these as Cloudflare secrets:

```bash
wrangler secret put RESEND_API_KEY
wrangler secret put BETTER_AUTH_SECRET
```

### 6. Run migrations

```bash
# Local development database
yarn db:migrate:dev

# Production database
yarn db:migrate:prod
```

### 7. Configure email routing

In the [Cloudflare dashboard](https://dash.cloudflare.com/), go to your domain's **Email Routing** settings and add a catch-all rule that routes to your cmail worker.

### 8. Deploy

```bash
yarn deploy
```

Visit your deployed URL to create your first user account.

## Local Development

```bash
# Start dev server (frontend + worker)
yarn dev

# Run tests
yarn test

# Generate a migration after schema changes
yarn db:generate

# Apply migrations locally
yarn db:migrate:dev

# Open Drizzle Studio (local)
yarn db:studio:dev
```

## Configuration

### wrangler.jsonc

Your Cloudflare Workers configuration. Created from `wrangler.jsonc.example`. This file is gitignored so each deployer maintains their own config. Key sections:

- `d1_databases` — D1 database binding
- `r2_buckets` — R2 bucket for attachments
- `queues` — Queue for sequence email processing
- `triggers.crons` — Hourly cron to check for due sequence emails
- `vars.BASE_URL` — Your deployed URL (used for OAuth redirects)
- `vars.TRUSTED_ORIGINS` — CORS allowed origins

### .dev.vars

Local development secrets. Created from `.dev.vars.example`. This file is gitignored.

- `RESEND_API_KEY` — Resend API key for sending email
- `BETTER_AUTH_SECRET` — Secret for session signing

## Roadmap

- **Agentic email steering** — AI-driven conversation flows that intelligently gather information from contacts through multi-turn email exchanges

## License

[Apache License 2.0](LICENSE)
