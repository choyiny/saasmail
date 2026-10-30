---
name: saasmail-onboarding
description: Interactive setup wizard for deploying your own saasmail instance to Cloudflare. Use this skill when the user wants to set up saasmail, deploy it, configure Cloudflare resources, or get started with the project. Also trigger when the user says "onboarding", "setup", "deploy saasmail", "get started", or asks how to install/configure saasmail.
---

# saasmail Onboarding Wizard

Guide the user through deploying a production saasmail instance to **their Cloudflare account**. This wizard is deployment-only — it does not set up local development (`docs/development.md`). Never deploy outside it.

## Before You Start

The deployment itself is `npx saasmail install` (the published `saasmail` package; source in `scripts/saasmail/`, described in `docs/setup.md`). No clone is needed: its state and generated `wrangler.jsonc` live in `~/.saasmail/<slug>/` (`SAASMAIL_HOME` overrides), never committed. Only a fork or modified code uses `yarn saasmail install` from a clone (then every `npx saasmail` below is `yarn saasmail`). It creates the resources, generates `wrangler.jsonc`, migrates, generates the secrets, deploys, wires up Email Routing and Email Sending, and verifies, the same way every time. You choose the inputs, show the user the plan, and interpret failures; **the user runs the apply**.

## What the user is signing up for

Tell the user this before touching anything, so they can back out cheaply:

- **~15 minutes** of work, plus DNS propagation (5–15 minutes) if they use Cloudflare Email Sending.
- **A few decisions**: which hostname the UI runs on (a custom domain or `*.workers.dev`), which domains receive mail, and which outbound provider (Cloudflare Email Sending, Resend, Bavimail, or Postmark) and from which domains.
- **Cost**: a Cloudflare **Workers Paid plan (about 5 USD/month)** is required. saasmail uses Queues, which aren't on the free plan. Email Routing is free; Cloudflare Email Sending is usage-based.

## Before the plan

Confirm each of these **explicitly** — ask, don't assume. If any answer is "no", stop and help them resolve it. The installer re-checks the account, zones and Cloudflare plan itself.

1. **Domains on Cloudflare.** Any domain they use (UI hostname, inbound, send-from) must be an active zone in their Cloudflare account (dashboard → **Add a Site**, then switch nameservers at the registrar). A domain that receives mail must be a zone of its own, and must not already have other MX records (the installer stops rather than take over a domain's mail). Without a domain they can use `--workers-dev` for the UI, but not inbound mail.
2. **Workers Paid.** If not, send them to https://dash.cloudflare.com/?to=/:account/workers/plans and wait.
3. **Tooling.** Run `node --version`: it must be v22 or newer. (Only a clone install needs Yarn and `yarn install`.)
4. **Cloudflare credentials.** Run `npx saasmail install --plan` (step 1 below) and read the result: if it says `Run npx wrangler@<version> login first.`, the user runs exactly that command themselves (it opens a browser): ask them to type it with `!`. A `CLOUDFLARE_API_TOKEN` also works (permissions in `docs/setup.md`); never ask them to paste one into the chat.

## Decisions

Ask the inputs one at a time:

1. **Name** (default `saasmail`; it names the worker and every resource).
2. **Account**, if the login sees several (`--account <id|name>`).
3. **UI host**: a custom hostname on a zone in the account (`--hostname mail.example.com`) or the free address (`--workers-dev`). The hostname must have no DNS record or other route yet.
4. **Inbound domains** (`--inbound-domain example.com`, repeatable, may be none): zones whose mail lands in saasmail. The installer enables Email Routing there and points the catch-all at the worker.
5. **Outbound provider** (`--provider`):
   - `cloudflare` (default, recommended for a pure-Cloudflare setup): also ask the **send-from domains** (`--send-domain`, repeatable). The installer onboards each in Email Sending and lists the DNS records to add; it does not write DNS.
   - `resend`, `postmark`, or `bavimail`: each send-from domain is verified in that provider's dashboard; the credential (Resend or Postmark API key; Bavimail API key and alias ID) is entered in the user's terminal.
   - `none`: sending fails until a provider is configured.
6. **Cookie prefix** (rarely changed; `--cookie-prefix`, default `saasmail`): only for several deployments on sibling subdomains that must not share cookies.

Optional: the logo. saasmail ships `public/saasmail-logo.png` (favicon and in-app logo). If they want their own, ask them to drag a PNG into the chat or say "skip", then `cp <their-file> public/saasmail-logo.png` **before** the apply, since it is deployed with the worker. The npm package ships the default logo, so a custom one means a clone install (`yarn saasmail install`). Wide logos (about 3:1 to 4:1, icon on the left) look best.

## Deployment

### Step 1: The plan

Run (flags from the answers; this is read-only, so it is safe from your shell):

```bash
npx saasmail install --plan --name <name> --hostname <host> --inbound-domain <domain> --provider cloudflare --send-domain <domain>
```

Never pass `--yes` yourself: your shell is not a terminal, so the apply must be run by the user. If preflight reports problems, nothing was changed: each failure comes with its fix. Help the user resolve them and run the plan again. Common ones: Workers Paid missing, R2 not enabled, no workers.dev subdomain yet (open Workers & Pages once), a zone not found or not active, the UI hostname already has DNS records or a route, an inbound domain with foreign MX records or a catch-all that does something else, an API token lacking a permission (a custom hostname or inbound domains may need `CLOUDFLARE_API_TOKEN` with Zone → DNS → Read; `wrangler login` may not cover reading DNS records).

Walk the user through the plan: what will be created (D1 database, R2 bucket, Queue, the worker and its Workflow), the address it will serve on, each Email Routing and Email Sending domain, anything that "exists but was not created by this installation" (the installer stops rather than touch it), and the plan digest. In a clone, if `wrangler.jsonc` exists and was written by hand, the installer refuses to overwrite it; the user moves it aside (`mv wrangler.jsonc wrangler.jsonc.hand`).

### Step 2: Apply

Ask for an explicit yes, then give the user the apply command the plan printed (it ends with `--expect-plan <digest> --yes`, so it applies exactly the plan they reviewed). Ask them to run it **in their own terminal window, not with `!` here**: the setup code it prints and any provider API key must stay out of this conversation, and the masked credential prompts need a real terminal, which `!` may not provide. Provider credentials are read from the environment (`SAASMAIL_RESEND_API_KEY`, `SAASMAIL_POSTMARK_API_KEY`, `SAASMAIL_BAVIMAIL_API_KEY` and `SAASMAIL_BAVIMAIL_ALIAS_ID`) or asked for in masked prompts; never ask them to paste one to you.

```
npx saasmail install --name <name> ... --expect-plan <digest> --yes
```

At the end it prints a **setup code** once and `<BASE_URL>/onboarding`. Tell the user to keep the code and enter it there to create the admin account; only someone with the code can. Ask them to come back and say whether it succeeded, **without pasting the setup code** (or any output line that contains it). Then run `npx saasmail status --name <name>` yourself: it shows the recorded installation and asks the deployed worker whether it matches.

If the run fails, the message names the failed step and prints `npx saasmail install --resume --name <name>`. Ask the user for the error lines (never the `Setup code:` line: a failure after the secrets went live prints the code too, so they keep it), help fix the cause, and have them run that command in their terminal (it skips what is done and creates nothing twice). "The plan changed since it was reviewed" means something moved: run `--plan` again yourself and review the new one. A lost code before the admin exists: they run `npx saasmail install --resume --name <name> --new-setup-code` in their terminal (the old code stops working; plain `--resume` in a terminal asks first).

### Step 3: Verify end to end

1. Open `<BASE_URL>/onboarding`. It asks for the setup code, then creates the account, which **becomes the admin**. Do it before sharing the URL.
2. Complete passkey enrollment on the prompt. saasmail enforces passkey auth for `/api/*` in production; without it, you'll be locked out of admin actions.
3. **Inbound test**: send an email from an external account (e.g. Gmail) to any address at each inbound domain. It should appear in the UI within seconds. If not, see Common Issues.
4. **Outbound test**: reply to that email from the UI using a send-from address on a verified domain. If it never arrives, the send-from domain is almost certainly not verified yet (DNS records pending).
5. **Bounce events** (Cloudflare Email Sending only): give the user the command that subscribes the queue `<name>-sequence-emails` to each send-from domain's events, to run in their terminal: `npx wrangler queues subscription create <name>-sequence-emails --source email.sending --zone-id <zone id> --domain <send-from domain> --events message.bounced,message.complained,message.failed,message.rejected`. Without it saasmail never learns of a bounce or a spam complaint (`docs/email-providers.md`, "Bounces and complaints").

## Completion Summary

Show the user what was set up, substituting their real values (the installer's own summary lists most of it):

- Worker deployed at `<BASE_URL>`, recorded in `~/.saasmail/<slug>/`
- Inbound: Cloudflare Email Routing catch-all → worker, on `<inbound domain(s)>`
- Outbound: `<Cloudflare Email Sending | Resend | Bavimail | Postmark>`, from `<send-from domain(s)>` (and any DNS records still to add)
- D1 database `<name>-db`, R2 bucket `<name>-attachments`, Queue `<name>-sequence-emails`
- Durable Objects `NotificationsHub` (realtime and push) and `MailAgent` (native mail agent)
- Workers AI binding `AI` (the agent's fallback provider)
- Generated secrets: `BETTER_AUTH_SECRET`, `UNSUBSCRIBE_SECRET`, `TOKEN_ENCRYPTION_KEY` (Gmail), and the VAPID keys for push
- Hourly cron for sequence emails, the outbox, backups and pruning (and connected-mailbox sync)
- Later: add domains or credentials with `npx saasmail install --resume --name <name> ...`; update with `/update-saasmail` (`npx saasmail@latest upgrade`)

## Common Issues

- **Preflight: "Queues are not available" / Workers Paid** — the plan isn't actually active. Recheck at https://dash.cloudflare.com/?to=/:account/workers/plans.
- **"The API token cannot read: …"** — the token lacks a permission listed in `docs/setup.md`; or use `npx wrangler@<version> login`. DNS records are read from public DNS, so no permission covers them; a "Public DNS lookup … failed" error means cloudflare-dns.com was unreachable: retry.
- **"Not running in a terminal: pass --yes"** — the apply runs in the user's own terminal window; Claude's shell (and `!`) is not a terminal.
- **"wrangler.jsonc exists and was not generated by saasmail"** — the file it names was written by hand; move it aside (the message gives the command) and rerun.
- **"`<name>` already exists and was not created by this installation"** — a resource with that name belongs to something else. Nothing was changed; pick another `--name`.
- **"`<host>` already has DNS records" / "is routed to `<worker>`"** — the deploy would replace them without asking, so the installer stops first: delete those records or routes, or choose another hostname.
- **"`<domain>` already has MX records"** — enabling Email Routing would take over that domain's mail. Use a domain (or a subdomain zone) you want saasmail to receive, or remove the MX records yourself. A recorded domain that later gains foreign MX records blocks every resume: edit it out of the install's state file (`~/.saasmail/<slug>/`) or pick another.
- **A catch-all that "does something else"** — the zone's catch-all forwards elsewhere; change it in the dashboard (Email → Email Routing → Routing rules) or use another domain.
- **"Email Routing on `<domain>` did not become ready within 60 s"** — check the zone's Email Routing page in the dashboard, then `--resume`. It fails again on each resume until the zone is healthy.
- **Inbound test email never arrives** — MX records haven't propagated, or the catch-all isn't saved. Email Routing **Overview** should say **Active**; `dig MX <inbound domain>` should return `*.mx.cloudflare.net` hosts.
- **Sending shows "pending" / outbound mail never arrives** — add the DNS records the installer listed as `missing` to the zone and wait 5–15 minutes for them to propagate. With Resend, Bavimail, or Postmark, check the provider's dashboard; status must read **Verified**.
- **"The plan changed since it was reviewed"** — something moved between the plan and the apply; run `--plan` again and review the new one.
- **Verify step times out** — a new custom domain's certificate can take a few minutes; run `npx saasmail status` and `--resume` if it still doesn't answer.
- **Locked out after sign-up** — passkey enrollment wasn't completed. Sign in again and finish the prompt; the server requires a passkey for `/api/*` in production.
- **Setup code lost before the admin exists** — `npx saasmail install --resume --name <name> --new-setup-code` in the user's terminal.
- **Gmail connect fails** — see `docs/gmail.md`; the installer already generated `TOKEN_ENCRYPTION_KEY`, but Google OAuth credentials are yours to add.
