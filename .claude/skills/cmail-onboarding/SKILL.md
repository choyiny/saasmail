---
name: cmail-onboarding
description: Interactive setup wizard for deploying your own cmail instance on Cloudflare Workers. Use this skill when the user wants to set up cmail, deploy it, configure Cloudflare resources, or get started with the project. Also trigger when the user says "onboarding", "setup", "deploy cmail", "get started", or asks how to install/configure cmail.
---

# cmail Onboarding Wizard

Walk the user through setting up their own cmail instance from scratch. This is an interactive, step-by-step process — explain each step, run commands, report results, and pause for user input when needed.

## Before You Start

Read `wrangler.jsonc.example` and `.dev.vars.example` in the project root to understand what configuration is needed. These are your source of truth for what resources need to be created.

## Setup Steps

Work through these steps in order. After each step, confirm success before moving on. If something fails, help the user troubleshoot before continuing.

### Step 1: Check Prerequisites

Verify these are installed and accessible:

- **Node.js** (v18+): Run `node --version`
- **Yarn**: Run `yarn --version`
- **Wrangler CLI**: Run `wrangler --version`

If wrangler is missing, offer to install it: `npm install -g wrangler`

### Step 2: Authenticate with Cloudflare

Check if already logged in: `wrangler whoami`

If not authenticated, tell the user to run `wrangler login` themselves (it opens a browser, which requires interactive input). Use the `!` prefix suggestion:

> Type `! wrangler login` in the prompt to authenticate with Cloudflare.

Wait for confirmation before proceeding.

### Step 3: Install Dependencies

Run `yarn install` if `node_modules/` doesn't exist or looks stale.

### Step 4: Create Cloudflare Resources

Create each resource and capture the output. The user's Cloudflare account must be on a paid plan for Queues.

**D1 Database:**
```bash
wrangler d1 create cmail-db
```
Capture the `database_id` from the output.

**R2 Bucket:**
```bash
wrangler r2 bucket create cmail-attachments
```

**Queue:**
```bash
wrangler queues create cmail-sequence-emails
```

If any creation fails because the resource already exists, that's fine — just note it and move on.

### Step 5: Configure wrangler.jsonc

Copy the example:
```bash
cp wrangler.jsonc.example wrangler.jsonc
```

Then edit `wrangler.jsonc` to fill in:
- `account_id`: Get from `wrangler whoami` output or ask the user
- `database_id` in `d1_databases`: Use the ID captured from Step 4
- `BASE_URL`: Ask the user what domain they'll use (e.g., `https://mail.example.com`)
- `TRUSTED_ORIGINS`: Set to `http://localhost:8080,<BASE_URL>`

If the user wants a custom domain, uncomment and configure the `routes` section.

### Step 6: Configure Secrets

Copy the example:
```bash
cp .dev.vars.example .dev.vars
```

Ask the user for:
- **RESEND_API_KEY**: Their Resend API key (from https://resend.com/api-keys)
- **BETTER_AUTH_SECRET**: Generate one for them with `openssl rand -hex 32`

Write these values into `.dev.vars`.

For production deployment, also set them as Cloudflare secrets:
```bash
wrangler secret put RESEND_API_KEY
wrangler secret put BETTER_AUTH_SECRET
```

Tell the user they'll need to paste the values when prompted by wrangler.

### Step 7: Run Migrations

Apply database migrations:
```bash
# Local development database
yarn db:migrate:dev

# Production database (on Cloudflare)
yarn db:migrate:prod
```

### Step 8: Configure Email Routing

This step requires manual action in the Cloudflare dashboard. Instruct the user:

> Go to the [Cloudflare dashboard](https://dash.cloudflare.com/), select your domain, then navigate to **Email > Email Routing > Routing Rules**. Add a catch-all rule that routes all incoming email to your cmail worker.
>
> If you haven't set up email routing on this domain before, you'll need to add the required DNS records that Cloudflare prompts you to add.

### Step 9: Deploy

Build and deploy:
```bash
yarn deploy
```

### Step 10: Verify

Tell the user to visit their deployed URL and create their first user account. The first user registered becomes the admin.

Suggest they also try:
- Sending a test email to their configured domain to verify receiving works
- Sending a reply from the UI to verify Resend sending works

## Completion

When all steps are done, summarize what was set up:
- Cloudflare Worker deployed at `<BASE_URL>`
- D1 database for email storage
- R2 bucket for attachments
- Queue for email sequence processing
- Hourly cron for checking due sequence emails
- Email routing configured to receive incoming mail

Mention that they can run `yarn dev` for local development going forward.
