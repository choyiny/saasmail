[saasmail](../README.md) › [Docs](README.md) › **Setup**

# Setup

Two paths: let Claude Code do it, or wire it up by hand. They cover the same
ground — the skill automates exactly the manual steps below.

## Recommended: install with Claude Code

saasmail ships with two [Claude Code](https://claude.ai/claude-code) skills that do the install and upgrade for you. This is the path we actively maintain — everything in the manual setup below is what the skills automate.

```bash
git clone https://github.com/choyiny/saasmail.git
cd saasmail
claude
```

Then, inside Claude Code:

- **`/saasmail-onboarding`** — interactive setup wizard. Walks you through Cloudflare login, creating D1/R2/Queue resources, filling out `wrangler.jsonc` and `.dev.vars`, running migrations, configuring Email Routing, and deploying. Expect ~30–40 minutes; most of that is DNS propagation, not typing.
- **`/update-saasmail`** — pull the latest upstream changes. See [Updating](updating.md).

Don't have Claude Code? The manual steps below cover the same ground.

## Manual setup

### Prerequisites

- [Node.js](https://nodejs.org/) v18+
- [Yarn](https://yarnpkg.com/)
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/) (`npm install -g wrangler`)
- A [Cloudflare](https://dash.cloudflare.com/) account with Email Routing available for your domain
- _Optional:_ an account with one of the third-party outbound providers — see [Email providers](email-providers.md)

### 1. Clone and install

```bash
git clone https://github.com/choyiny/saasmail.git
cd saasmail
yarn install
```

### 2. Authenticate with Cloudflare

```bash
wrangler login
```

### 3. Create Cloudflare resources

```bash
# D1 database
wrangler d1 create saasmail-db

# R2 bucket
wrangler r2 bucket create saasmail-attachments

# Queue for email sequencing
wrangler queues create saasmail-sequence-emails
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
- If using Cloudflare Email Sending, uncomment the `send_email` binding

Every key is described in [Configuration](configuration.md#wranglerjsonc).

### 5. Configure secrets

Copy the example and fill in your values:

```bash
cp .dev.vars.example .dev.vars
```

Edit `.dev.vars`:

- `BAVIMAIL_API_KEY` and `BAVIMAIL_ALIAS_ID` — your Bavimail bearer token and alias UUID (only if using Bavimail; both must be set)
- `POSTMARK_API_KEY` — your Postmark server API token (only if using Postmark)
- `RESEND_API_KEY` — your Resend API key (omit if using Cloudflare Email Sending, Bavimail, or Postmark)
- `BETTER_AUTH_SECRET` — **required**; generate a random string (`openssl rand -hex 32`). Signs sessions and protects the OAuth signing keys used by the MCP endpoint. Set this before deploying: without it the auth library silently falls back to a publicly known default value.
- `UNSUBSCRIBE_SECRET` — generate a random string (`openssl rand -hex 32`); used to sign one-click unsubscribe tokens

For production, set these as Cloudflare secrets:

```bash
wrangler secret put BETTER_AUTH_SECRET
wrangler secret put UNSUBSCRIBE_SECRET
wrangler secret put RESEND_API_KEY      # only if using Resend
wrangler secret put BAVIMAIL_API_KEY    # only if using Bavimail
wrangler secret put BAVIMAIL_ALIAS_ID   # only if using Bavimail
wrangler secret put POSTMARK_API_KEY    # only if using Postmark
```

The full list of secrets and what each one does is in [Configuration](configuration.md#devvars).

### 6. Run migrations

```bash
# Local development database
yarn db:migrate:dev

# Production database
yarn db:migrate:prod
```

Run the production migration before opening the deployed app for the first setup. If the production D1 database has not been initialized, the onboarding screen will show **Database migration required** with the same command.

### 7. Configure email routing

In the [Cloudflare dashboard](https://dash.cloudflare.com/), go to your domain's **Email Routing** settings and add a catch-all rule that routes to your saasmail worker.

### 8. Deploy

```bash
yarn deploy
```

Visit your deployed URL to create your first admin account. Once signed in, go to **Inboxes** to name your inbound addresses and **Users** to invite additional team members.

---

**Next:** [Email providers](email-providers.md) · [Configuration](configuration.md) · [Local development](development.md) · [Updating](updating.md)
