---
name: saasmail-onboarding
description: Interactive setup wizard for deploying your own saasmail instance to Cloudflare. Use this skill when the user wants to set up saasmail, deploy it, configure Cloudflare resources, or get started with the project. Also trigger when the user says "onboarding", "setup", "deploy saasmail", "get started", or asks how to install/configure saasmail.
---

# saasmail Onboarding Wizard

Guide the user through deploying a production saasmail instance to **their Cloudflare account**. This wizard is deployment-only — it does not set up local development. Every step targets the user's live Cloudflare environment.

## Before You Start

Read `wrangler.jsonc.example` in the project root so you know the exact shape of the config that will be filled in. It is your source of truth for which resources and bindings are required.

## What the user is signing up for

Set expectations up front, so the user knows what they're committing to:

- **~30–40 minutes** total; most of the wait is DNS propagation, not typing.
- **Two decisions**: which domains will be used, and which outbound email provider (Cloudflare Email Sending or Resend).
- **Three manual Cloudflare-dashboard steps** (Email Routing per inbound domain, Email Service per send-from domain, and checking the deployed worker).
- **Cost**: a Cloudflare **Workers Paid plan (~$5/mo)** is required. saasmail uses Queues, which aren't on the free plan. Email Routing is free; Cloudflare Email Sending is usage-based.

Tell the user all of this before touching anything, so they can back out cheaply.

## Preflight Checkpoints (hard gates)

Confirm each of these **explicitly** with the user — ask, don't assume. If any answer is "no", stop and help them resolve it before continuing. These exist because every later step assumes them, and a half-configured Cloudflare account is annoying to clean up.

### Checkpoint 1 — Do you own a domain?

Ask: "Do you already own a domain you want to use for saasmail?"

- **No** → Stop. Tell them to buy one (Cloudflare Registrar, Namecheap, etc.) and come back. A single domain can cover all three roles; split domains are also fine.

### Checkpoint 2 — Is that domain on Cloudflare?

Ask: "Are the domain's nameservers pointing to Cloudflare (the domain is an active Cloudflare zone)?"

- **No** → Stop. Instruct them to open the Cloudflare dashboard → **Add a Site**, then switch nameservers at their registrar to the ones Cloudflare provides. Propagation can take up to a few hours. Both Email Routing and `custom_domain` worker routes require the zone to live on Cloudflare.

### Checkpoint 3 — Workers Paid plan?

Ask: "Is your Cloudflare account on the **Workers Paid** plan (~$5/month)?"

- **No** → Stop. Send them to https://dash.cloudflare.com/?to=/:account/workers/plans to upgrade, and wait for them to come back. Without it, `wrangler queues create` will fail and the deploy will not succeed.

### Checkpoint 4 — Tooling

Run (the user has cloned the repo):

```bash
node --version    # v18+
yarn --version
wrangler --version
```

If wrangler is missing: `npm install -g wrangler`.

### Final confirmation

Before creating a single resource, restate to the user what they've confirmed:

> You've told me: you own `<domain>`, it's on Cloudflare, your account is on Workers Paid, and tooling is installed. I'm about to create a D1 database, an R2 bucket, and a Queue in your Cloudflare account, and deploy a worker. Ready?

Wait for an explicit yes. This is the last low-cost checkpoint.

## Decisions

### Decision 1: Domain roles

saasmail distinguishes three roles. They can be the same domain, or split across several:

1. **UI / API host** — where the web app is served (e.g. `mail.example.com`). Becomes `BASE_URL`.
2. **Inbound domain(s)** — domains whose incoming mail should land in saasmail. If you want `support@example.com` to show up in the app, `example.com` is an inbound domain.
3. **Send-from domain(s)** — domains saasmail will send _from_. If outgoing mail should come from `hello@example.com`, `example.com` is a send-from domain.

Most single-domain setups use the same domain for all three, with the UI on a subdomain (`mail.example.com`). Ask the user to assign each role, and record the answers — you'll reuse them below.

### Decision 2: Outbound email provider

- **Option A — Cloudflare Email Sending** (default; recommended for a pure-Cloudflare setup). Uses the `send_email` binding. Each send-from domain must be onboarded in Cloudflare Email Service (Step 8 below).
- **Option B — Resend**. Set `RESEND_API_KEY` as a secret. Each send-from domain must be verified in the Resend dashboard instead.

At runtime, if `RESEND_API_KEY` is set, Resend wins; otherwise the `send_email` binding is used. Default the user to Option A unless they already have a Resend account and prefer it.

## Deployment Steps

Run these in order, straight through. Don't pause between steps unless the user must make a decision or input a credential.

### Step 1: Authenticate with Cloudflare

```bash
wrangler whoami
```

If not authenticated, the user runs it themselves (it opens a browser):

> Type `! wrangler login` in the prompt.

Wait for their confirmation before continuing.

### Step 2: Install Dependencies

```bash
yarn install
```

### Step 3: Create Cloudflare Resources

```bash
wrangler d1 create saasmail-db
wrangler r2 bucket create saasmail-attachments
wrangler queues create saasmail-sequence-emails
```

**Capture the `database_id`** printed by `wrangler d1 create` — you'll paste it into `wrangler.jsonc` next.

If any resource already exists, note it and move on. If the queue command fails with a plan error, Checkpoint 3 was not actually satisfied — stop and have the user upgrade.

### Step 4: Configure `wrangler.jsonc`

```bash
cp wrangler.jsonc.example wrangler.jsonc
```

Edit `wrangler.jsonc` and fill in:

- `account_id` — from `wrangler whoami`.
- `d1_databases[0].database_id` — the ID captured in Step 3.
- `routes` — uncomment the block and set `pattern` to the UI host from Decision 1. Keep `custom_domain: true`.
- `BASE_URL` — `https://<UI host>`.
- `TRUSTED_ORIGINS` — `<BASE_URL>` (production-only; do not add localhost).
- If Decision 2 is **Option A**, uncomment the `send_email` block.
- Optional: override `COOKIE_PREFIX` if you want to run multiple saasmail deployments on sibling subdomains without cookie collisions.

**Do not rename bindings.** The worker code looks them up by exact name — renaming any of these will break the app:

| Key in `wrangler.jsonc`      | Required value  |
| ---------------------------- | --------------- |
| `d1_databases[].binding`     | `"DB"`          |
| `r2_buckets[].binding`       | `"R2"`          |
| `queues.producers[].binding` | `"EMAIL_QUEUE"` |
| `send_email[].name`          | `"EMAIL"`       |

`database_name`, `bucket_name`, `queue`, `account_id`, and all IDs can be freely changed. Only the `binding` / `name` values above are load-bearing.

### Step 4.5: Optional — Replace the logo

saasmail ships with its own logo at `public/saasmail-logo.png`. That file is used as both the favicon and the in-app logo (sidebar, login, invite, onboarding pages). Vite serves it at `/saasmail-logo.png`.

Ask the user:

> Want to use your own logo instead of the default saasmail logo? Drag a PNG into this chat, or just say "skip".

If they drag a file in, you'll receive a path like `/Users/<them>/Downloads/<name>.png`. Overwrite the repo's copy:

```bash
cp <their-file> public/saasmail-logo.png
```

Accept any PNG. Wide horizontal logos (roughly 3:1 to 4:1, matching the default) display best because the sidebar uses the full image when expanded and crops to the left edge when collapsed — so an icon + wordmark with the icon on the left is the sweet spot. If they give you something square or tall, it'll still work but the collapsed sidebar will show the top-left corner, which may look off.

If they say skip, leave the file alone and move on.

No config to change — the reference is hardcoded to `/saasmail-logo.png`.

### Step 5: Set Production Secrets

```bash
wrangler secret put BETTER_AUTH_SECRET
```

Generate the value to paste when wrangler prompts:

```bash
openssl rand -hex 32
```

If Decision 2 is **Option B (Resend)**, also run:

```bash
wrangler secret put RESEND_API_KEY
```

Paste the Resend API key (from https://resend.com/api-keys) when prompted.

Do **not** set `RESEND_API_KEY` for Option A — its mere presence tells saasmail to use Resend, overriding the `send_email` binding.

### Step 6: Apply Database Migrations

```bash
yarn db:migrate:prod
```

This applies schema migrations to the remote D1 database directly via wrangler; the worker does not need to be deployed yet.

### Step 6.5: Configure VAPID Keys (Browser Push Notifications)

Check whether VAPID keys are already configured:

```bash
# Check wrangler.jsonc for the public key
grep -q "VAPID_PUBLIC_KEY" wrangler.jsonc && echo "public key present" || echo "public key missing"

# Check Cloudflare secrets for the private key
wrangler secret list
```

If `VAPID_PUBLIC_KEY` appears in `wrangler.jsonc` **and** `VAPID_PRIVATE_KEY` appears in `wrangler secret list`, say:

> VAPID keys already configured, skipping.

Otherwise, ask the user:

> saasmail supports browser push notifications via the Web Push API. Would you like to generate VAPID keys now? (Recommended — push notifications won't work without them.)

**If yes:**

1. Generate the keypair:

   ```bash
   yarn vapid:generate
   ```

   The script prints a `VAPID_PUBLIC_KEY` and a `VAPID_PRIVATE_KEY`. Copy both values.

2. Store the private key as a Cloudflare secret:

   ```bash
   wrangler secret put VAPID_PRIVATE_KEY
   ```

   Paste the `VAPID_PRIVATE_KEY` value when wrangler prompts.

3. Add the public key and subject to `wrangler.jsonc` under `[vars]` (or the top-level `vars` object, matching the existing style):
   ```jsonc
   "VAPID_PUBLIC_KEY": "<paste VAPID_PUBLIC_KEY here>",
   "VAPID_SUBJECT": "mailto:admin@<host-of-BASE_URL>"
   ```
   Replace `<host-of-BASE_URL>` with the hostname from `BASE_URL` (e.g. `mail.example.com`).

**If no:**

> Push notifications will remain disabled until you run `yarn vapid:generate` and configure the keys.

Proceed to the next step either way.

### Step 7: Deploy

```bash
yarn deploy
```

Once this succeeds, the worker exists in the user's account and can be referenced by Email Routing rules. (The next step needs the worker to be deployable-from-dashboard-dropdown, which is why deploy happens before routing.)

Verify the custom domain is attached: open `https://<BASE_URL>` in a browser — you should see the saasmail sign-in page. If it's the Cloudflare "not found" page, `routes` wasn't uncommented in Step 4.

### Step 8: Configure Email Routing (inbound)

Manual dashboard step, repeated **for each inbound domain** from Decision 1:

1. Cloudflare dashboard → select the inbound domain → **Email → Email Routing**.
2. If Email Routing isn't enabled, click **Enable Email Routing**. Cloudflare will show MX + TXT (SPF) records to add; since the zone is on Cloudflare (Checkpoint 2), one-click install works.
3. Under **Routing Rules**, add a **catch-all** rule with action **Send to a Worker** and pick the worker (`saasmail` by default, or whatever `name` was kept in `wrangler.jsonc`). Save.

If the worker isn't in the dropdown, Step 7 didn't actually succeed — go back and check `wrangler deployments list`.

### Step 9: Verify Send-From Domains

**Option B (Resend)**: verify each send-from domain in the Resend dashboard → **Domains → Add Domain**, and add the DKIM/SPF records Resend provides. Then skip the rest of this step.

**Option A (Cloudflare Email Sending)**: repeat for each send-from domain from Decision 1:

1. Open [Email Service](https://dash.cloudflare.com/?to=/:account/email-service) — **account-level**, not a per-zone setting.
2. **Add a domain** → enter the send-from domain.
3. Add the DKIM / SPF / DMARC records Cloudflare shows (one-click if the zone is on Cloudflare).
4. Wait for the status to flip to **Verified**. Until then, sends from that domain will fail at the provider.

Email Routing (Step 8) and Email Service (Step 9) are independent systems — enabling one does not enable the other. A domain can do inbound only, outbound only, both, or neither.

### Step 10: Verify End-to-End

1. Visit `https://<BASE_URL>` and sign up. **The first account registered becomes the admin** — do this before sharing the URL with anyone else.
2. Complete passkey enrollment on the prompt. saasmail enforces passkey auth for `/api/*` in production; without it, you'll be locked out of admin actions.
3. **Inbound test**: send an email from an external account (e.g. Gmail) to any address at each inbound domain. It should appear in the UI within seconds. If not: recheck Step 8 and confirm `dig MX <inbound domain>` returns Cloudflare's MX hosts.
4. **Outbound test**: reply to that email from the UI using a send-from address on a verified domain. If it never arrives, the send-from domain is almost certainly unverified (Step 9).

## Completion Summary

Show the user exactly what was set up, substituting their real values:

- Worker deployed at `<BASE_URL>`
- Inbound: Cloudflare Email Routing → worker, on `<inbound domain(s)>`
- Outbound: `<Cloudflare Email Sending | Resend>`, from `<send-from domain(s)>`
- D1 database `saasmail-db` (binding `DB`)
- R2 bucket `saasmail-attachments` (binding `R2`)
- Queue `saasmail-sequence-emails` (binding `EMAIL_QUEUE`)
- Hourly cron for sequence email delivery

## Common Issues

- **`wrangler queues create` fails with a plan error** — Workers Paid plan isn't actually active. Recheck at https://dash.cloudflare.com/?to=/:account/workers/plans.
- **Worker missing from Email Routing "Send to a Worker" dropdown** — Step 7 didn't succeed, or the dashboard is cached. Run `wrangler deployments list` to confirm, then refresh the dashboard.
- **Inbound test email never arrives** — MX records haven't propagated, or the catch-all isn't saved. Email Routing **Overview** should say status **Active**; `dig MX <inbound domain>` should return `*.mx.cloudflare.net` hosts.
- **Outbound email looks sent but never arrives** — the send-from domain isn't verified. Check Email Service (Option A) or Resend → Domains (Option B); status must read **Verified**.
- **Locked out after sign-up** — passkey enrollment wasn't completed. Sign in again and finish the prompt; the server requires a passkey for `/api/*` in production.
- **`BASE_URL` serves a blank Cloudflare page instead of saasmail** — the `routes` block in `wrangler.jsonc` wasn't uncommented, or `custom_domain: true` is missing. Fix and redeploy.
