[saasmail](../README.md) › [Docs](README.md) › **Setup**

# Setup

Deploy saasmail to your own Cloudflare account with one command, `npx saasmail install`. It takes about 15 minutes, plus DNS propagation if you use Cloudflare Email Sending. The same inputs always give the same resource names, the same `wrangler.jsonc`, and the same plan. The [`/saasmail-onboarding`](../.claude/skills/saasmail-onboarding/SKILL.md) Claude Code skill walks you through it; you don't need Claude to use it. Running a fork or modified code? [Install from a clone](#install-from-a-clone) instead. The manual steps are kept [below](#manual-setup).

## Prerequisites

- A Cloudflare account on the **Workers Paid** plan (Queues are not on Workers Free) with **R2** enabled.
- [Node.js](https://nodejs.org/) 22 or newer (`npx` comes with it). Installing from a clone needs v22.18+ and [Yarn](https://yarnpkg.com/); the manual setup below keeps its own, lower requirement.
- For a custom hostname, and for every inbound or send domain: the domain is an **active zone in this Cloudflare account**. A domain you receive mail on must be a zone of its own (a subdomain you want routed needs its own zone).
- Cloudflare credentials: `npx wrangler@<version> login` (the installer prints the exact command with the pinned wrangler version if you are not logged in), or `CLOUDFLARE_API_TOKEN` (see [Token permissions](#token-permissions)).
- _Optional:_ an account with Resend, Postmark or Bavimail — see [Email providers](email-providers.md).

## Install

```bash
npx saasmail install
```

The package carries a built release and its own pinned wrangler, so there is nothing to clone. Everything the install records, including the generated `wrangler.jsonc`, lives in `~/.saasmail/<slug>/` (set `SAASMAIL_HOME` to put it elsewhere); none of it is committed anywhere. In a terminal it asks for an installation name, the Cloudflare account (when your login sees several), where to serve (a custom hostname or `<name>.<subdomain>.workers.dev`), the domains whose mail saasmail receives, the outbound provider, the domains to send from, and the cookie prefix. Each answer can be a flag instead:

| Flag                        | Meaning                                                                                                            |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `--name <name>`             | Installation name (default `saasmail`; lowercase letters, digits and `-`, 3 to 30); names the worker and resources |
| `--account <id\|name>`      | Cloudflare account; needed when not in a terminal and the login sees several                                       |
| `--hostname <host>`         | Serve the app on a custom hostname in one of the account's zones                                                   |
| `--workers-dev`             | Serve on `<name>.<subdomain>.workers.dev` instead                                                                  |
| `--inbound-domain <domain>` | Route this zone's mail to saasmail (repeatable; default none)                                                      |
| `--provider <provider>`     | Outbound email: `cloudflare` (default), `resend`, `postmark`, `bavimail` or `none`                                 |
| `--send-domain <domain>`    | Email Sending domain, with `--provider cloudflare` (repeatable)                                                    |
| `--cookie-prefix <prefix>`  | Session cookie prefix (default `saasmail`)                                                                         |
| `--plan`                    | Only show what would change, then print the apply command                                                          |
| `--expect-plan <digest>`    | Apply only if the plan still has this digest                                                                       |
| `--resume`                  | Continue a recorded installation, or add domains or credentials to an installed one                                |
| `--new-setup-code`          | With `--resume`, before the first admin exists: replace the setup code                                             |
| `--yes`                     | Apply without asking (required when not in a terminal)                                                             |

Environment: `CLOUDFLARE_API_TOKEN` (otherwise wrangler's login is used) and the provider's credentials: `SAASMAIL_RESEND_API_KEY`, `SAASMAIL_POSTMARK_API_KEY`, or `SAASMAIL_BAVIMAIL_API_KEY` with `SAASMAIL_BAVIMAIL_ALIAS_ID`. In a terminal without them, the installer asks in masked prompts; without a terminal it stops and names the variable. The mail inputs and the cookie prefix are asked only in a terminal without `--yes`, so a command with `--yes` means exactly what it says.

The installer first runs read-only checks (Workers Paid, R2, the workers.dev subdomain, every zone, and for a custom hostname its existing DNS records and Workers routes, which the deploy would otherwise replace without asking; for each inbound domain its MX records and catch-all) and stops with the fix for each problem before changing anything. It then prints the **plan**: every resource it will create, reuse or deploy, and a **digest**. A resource that already exists under the expected name but was not created by this installation is never touched; the plan stops instead.

`--plan` changes nothing and prints the exact apply command, ending in `--expect-plan <digest> --yes`. The apply recomputes the plan and stops if its digest differs from the one you reviewed.

What it creates: a D1 database (`<name>-db`), an R2 bucket (`<name>-attachments`), a Queue (`<name>-sequence-emails`), the worker `<name>` and its Gmail-backfill Workflow, and `wrangler.jsonc` generated from `wrangler.jsonc.example` (it refuses to overwrite a hand-written one and says how to move it aside). Then it applies the migrations and generates this instance's secrets once: `BETTER_AUTH_SECRET`, `UNSUBSCRIBE_SECRET`, `TOKEN_ENCRYPTION_KEY` and the VAPID key pair for push notifications. They go to the deploy through a temporary 0600 file, never argv or logs, and an existing secret is never regenerated. The record of what it did is the state file in the install's directory under `~/.saasmail/`.

### The setup code

At the end it prints a **setup code** once, and `<BASE_URL>/onboarding`. Open that page and enter the code to create the first admin; until then nobody else can claim the instance. The code is stored only as a hash (`SETUP_CODE_HASH`). Run the apply in your own terminal window: the code and your keys are printed there. If you lose it before creating the admin, `npx saasmail install --resume --name <name> --new-setup-code` issues a new one and the old one stops working (in a terminal, `--resume` alone asks first, default no).

### Email Routing (inbound)

For each `--inbound-domain`, after the deploy, the installer turns on Email Routing for the zone (Cloudflare adds its MX and an SPF TXT record), waits for it to be ready, and points the zone's **catch-all** at the worker. It stops, changing nothing, when:

- the domain has MX records other than Cloudflare's own (`route1`–`route3.mx.cloudflare.net`): enabling routing would take over that domain's mail; or
- the catch-all already does something else, such as forwarding to an address or another worker. A catch-all that is off or set to drop (the dashboard default) is taken over.

Enabling Email Routing adds Cloudflare's MX and an SPF TXT record to the zone. A zone that already publishes an SPF record should merge them, because two SPF records are invalid.

### Email Sending (outbound)

With `--provider cloudflare`, each `--send-domain` is onboarded as an Email Sending subdomain. The installer **reports the DNS records it needs and whether the zone has them, and never writes DNS**: add any it lists as missing yourself. DNS propagation (5 to 15 minutes) shows as pending and is normal, not a failure; sending from that domain works once the records resolve. With Resend, Postmark or Bavimail you verify the sending domain in that provider's dashboard as before.

Email Routing and Email Sending are independent: a domain can do either, both or neither.

### Resume, status, and adding domains

If a run stops, it prints the step that failed and the command to continue: `npx saasmail install --resume --name <name>` skips what is done and creates nothing twice. `--resume` on a finished installation adds what you supply now:

- **Domains** given with `--inbound-domain` or `--send-domain` are _added_ to the recorded ones. A recorded domain can't be removed through the CLI; to drop one (including one that later gained foreign MX records and now blocks every resume), edit the install's state file or pick another domain.
- **Credentials** are required until the first deploy has sent them and optional afterwards (added only when given; a terminal asks for the ones you skipped).
- A new setup code, only with consent and while no user exists.

A zone whose Email Routing never becomes ready within 60 seconds fails that step, and fails again each resume until the zone is healthy. `--resume` never upgrades a deployed instance: updates go through `npx saasmail@latest upgrade` ([Updating](updating.md)).

`npx saasmail status` shows the recorded installation (add `--name <name>` when there are several), the **Latest** version on npm with the command that upgrades to it (`npx saasmail@<latest> upgrade --name <name>`), and asks the deployed worker's public `/.well-known/saasmail` whether it matches. For an install still in a clone, `npx saasmail status --from <checkout>` reads the checkout's state without moving or writing anything; its upgrade hint adopts from that checkout first.

### Install from a clone

For a fork or modified code, install from a checkout. The flags and prompts are the same; the commands are `yarn saasmail ...`, and the state and generated `wrangler.jsonc` live in the checkout (`.saasmail/`, gitignored).

```bash
git clone https://github.com/choyiny/saasmail.git
cd saasmail
yarn install
yarn wrangler login
yarn saasmail install
```

`upgrade` and `adopt` are npm-only: in a clone they print the `npx` command to run. To hand a clone's install to the package, run `npx saasmail adopt --from <checkout>` (see [Updating](updating.md#adopt-an-existing-install)); the clone then refuses to deploy it. `npx saasmail upgrade` stops on modified code unless you pass `--replace-custom-code`.

### Token permissions

`wrangler login` covers every call the installer makes. DNS records (a custom hostname's existing records, inbound domains' MX records, Email Sending's records) are read from public DNS (Cloudflare's DNS over HTTPS at cloudflare-dns.com), not the zone's records API, because `wrangler login` cannot grant reading DNS records; records added in the last few minutes may not show yet. For `CLOUDFLARE_API_TOKEN` (also useful in CI), create an API token with these permissions, scoped to the account and to the zones involved. The installer reports a 401/403 as "The API token cannot read: …". The list is derived from the REST calls the installer and `wrangler deploy` make; names are the dashboard's permission groups, and those marked (unverified) are the nearest match, so adjust if the dashboard words them differently.

- **Account → Account Settings → Read** (list accounts)
- **Account → Workers Scripts → Edit** (deploy, secrets, worker settings, workers.dev subdomain, Workflows)
- **Account → D1 → Edit**
- **Account → Workers R2 Storage → Edit** (the bucket and the ownership marker object)
- **Account → Queues → Edit**
- **Account → Workflows → Edit** (unverified; Workers Scripts may cover it)
- **Account → Email Sending → Edit** (unverified; only with `--send-domain`)
- **Zone → Zone → Read** (every zone)
- **Zone → DNS → Edit** (Email Routing writes its own records; a custom hostname's DNS record is created at deploy)
- **Zone → Workers Routes → Edit** (only with `--hostname`)
- **Zone → Email Routing Rules → Edit** (unverified; only with `--inbound-domain`)

## Manual setup

`npx saasmail install` replaces this section; use it if you can't run the installer, or to see what it does. A hand-written `wrangler.jsonc` works the same, but the installer will refuse to overwrite it. Email Routing is set up in step 7.

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
- Set `TRUSTED_ORIGINS` to include your deployed URL (and set `VAPID_PUBLIC_KEY`/`VAPID_SUBJECT` if you want push notifications: `yarn vapid:generate`)
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
- `TOKEN_ENCRYPTION_KEY` — only for the [Gmail integration](gmail.md). It encrypts the OAuth client secret and mailbox tokens; the client ID and secret themselves are entered on the Inboxes page after deploying, not here

For production, set these as Cloudflare secrets:

```bash
wrangler secret put BETTER_AUTH_SECRET
wrangler secret put UNSUBSCRIBE_SECRET
wrangler secret put RESEND_API_KEY      # only if using Resend
wrangler secret put BAVIMAIL_API_KEY    # only if using Bavimail
wrangler secret put BAVIMAIL_ALIAS_ID   # only if using Bavimail
wrangler secret put POSTMARK_API_KEY    # only if using Postmark

# only for the Gmail integration — see docs/gmail.md. The OAuth client ID
# and secret are entered on the Inboxes page afterwards.
openssl rand -base64 32 | wrangler secret put TOKEN_ENCRYPTION_KEY
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
