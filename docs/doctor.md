[saasmail](../README.md) › [Docs](README.md) › **Doctor**

# Doctor: the build stamp and deployment checks

A deploy can skip a step quietly: a D1 migration not applied, a secret not set, a binding missing, a dev flag left on, Email Routing not pointing at the Worker. The doctor finds these. It has two parts:

- **In the Worker**, `GET /api/admin/doctor` (admins only) returns the build stamp and the runtime checks. **Settings → System** shows the same thing.
- **On your machine**, `yarn doctor` adds what only Wrangler and the Cloudflare API can see, and merges both reports.

How it differs from `yarn saasmail status`: `status` reads the installer's state in `.saasmail/` and compares the installation id and version with the public `/.well-known/saasmail`. The doctor needs no installer state, signs in with an admin API key, and checks the running deployment.

## The build stamp

`yarn build` stamps the Worker with the version from `package.json`, the commit (`git rev-parse HEAD`), its time, whether the tree had uncommitted changes (and the first 10 changed paths), the build time and the list of migration files. A build from a source copy without `.git` reports `commit: "unknown"`.

The stamp is in the Worker bundle only, never in the web app's JavaScript: those files are served without sign-in, and a public commit tells an attacker which fixes a deployment lacks. `GET /api/health` and `/.well-known/saasmail` do not carry it.

## Settings → System

Admins see the version, the short commit (plain text, to copy), the build time and the working-tree state with the changed paths. **Run checks** lists the runtime checks grouped, failures first, each with a one-line hint. Members don't see the section.

## Runtime checks

Each check reports `pass`, `warn`, `fail` or `info`. A check that cannot run reports `fail` when it is mandatory (migrations, `BETTER_AUTH_SECRET` and dev flags, bindings and provider), otherwise `warn`, with the error. Secrets are reported as set or not set, never their values.

| Check                      | Fails or warns when                                                                                                                                                                                                          | Fix                                                                 |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `migrations.pending`       | **fail**: a migration file in this build is not in `d1_migrations`                                                                                                                                                           | `npx wrangler d1 migrations apply DB --remote`                      |
| `migrations.unknown`       | **warn**: the database has a migration this build does not know (an older build was deployed)                                                                                                                                | Deploy the commit that added it, or a later one                     |
| `secrets.better_auth`      | **fail**: `BETTER_AUTH_SECRET` is not set (sessions would use the library's public default)                                                                                                                                  | `npx wrangler secret put BETTER_AUTH_SECRET`                        |
| `secrets.unsubscribe`      | `UNSUBSCRIBE_SECRET` not set: **fail** when a list or campaign exists, else **warn**                                                                                                                                         | `npx wrangler secret put UNSUBSCRIBE_SECRET`                        |
| `secrets.vapid`            | **warn**: one VAPID key without the other. Both empty: **info** (push is off)                                                                                                                                                | `yarn vapid:generate`, then set both                                |
| `secrets.optional`         | **info**: whether `BACKUP_ENCRYPTION_KEY` and `AGENT_APPROVAL_SECRET` are set                                                                                                                                                | Optional                                                            |
| `secrets.token_encryption` | **fail**: `TOKEN_ENCRYPTION_KEY` not set while a Gmail or Outlook account, or a Google or Microsoft OAuth app (including Google's `GOOGLE_OAUTH_CLIENT_ID` and `GOOGLE_OAUTH_CLIENT_SECRET` vars), exists. Neither: **info** | `npx wrangler secret put TOKEN_ENCRYPTION_KEY`                      |
| `secrets.dev_flags`        | **fail**: `DISABLE_PASSKEY_GATE=true` or `DEMO_MODE=1` while `BASE_URL` is not a localhost address: the passkey gate is off in production                                                                                    | Remove the var and deploy                                           |
| `bindings.required`        | **fail**: `DB`, `R2`, `EMAIL_QUEUE`, `NOTIFICATIONS_HUB` or `MAIL_AGENT` is missing                                                                                                                                          | Add it from `wrangler.jsonc.example`                                |
| `bindings.ai`              | **warn**: no `AI` binding (the agent and AI filing then need `ANTHROPIC_API_KEY` or `OPENAI_API_KEY`)                                                                                                                        | Add the binding or a key                                            |
| `bindings.backups`         | **info**: no `BACKUPS` bucket (backups go to the attachments bucket under `backups/`)                                                                                                                                        | Optional, see [backups](data.md#backups)                            |
| `bindings.gmail_backfill`  | **info**: no `GMAIL_BACKFILL` workflow (a Gmail import then runs inside the cron sync, more slowly)                                                                                                                          | Optional, see [Gmail](gmail.md)                                     |
| `provider.outbound`        | Names the provider. **fail**: no provider, or demo mode on a public address. No provider but an inbox mapped to Gmail or Outlook: **warn** (only replies from mapped inboxes can send)                                       | Set a provider, see [Email providers](email-providers.md)           |
| `provider.mailbox_errors`  | **warn**: Gmail or Outlook accounts with a sync error, counted per provider                                                                                                                                                  | Reconnect them on the Inboxes page                                  |
| `provider.paused`          | **warn**: outbound sending is paused                                                                                                                                                                                         | Resume it in [Sending controls](sending.md)                         |
| `cron.last_tick`           | **fail**: the hourly cron chain has not finished in the last 2 hours, or never                                                                                                                                               | Check the cron trigger in the Wrangler config and the Worker's logs |
| `outbox.stuck`             | **warn**: pending sends over an hour past their retry time, sends failed in the last 7 days, or sends accepted by the provider but not recorded for over an hour                                                             | The Outbox tab: retry or delete                                     |
| `backups.recent`           | Backups off: **info**. On: **warn** when no completed, unpruned backup started in the last 26 hours, one has run for over 6 hours, or the last one failed (with its error)                                                   | **Settings → Data → Backups**                                       |
| `inbound.recent`           | **info**: no mail received in 30 days while inboxes exist. A quiet inbox looks the same as broken routing; `yarn doctor` with a token checks the routing rules                                                               | See below                                                           |

The cron check reads `app_settings.last_cron_at`, written as the last step of each tick's chain. It records that the chain ran, not that the Gmail and Outlook sync after it finished. **After the first deploy it reads `fail` for up to an hour**, until the first tick.

## `yarn doctor`

```bash
export SAASMAIL_ADMIN_KEY=sk_…            # an API key of an admin user
export CLOUDFLARE_API_TOKEN=…             # optional, for the Cloudflare checks
yarn doctor --config wrangler.jsonc --url https://mail.example.com
```

Options: `--strict` (exit 1 on a warning too), `--allow-dirty <path>…` (paths a deploy overlays on purpose, such as a logo; a directory covers what is under it), `--local` (against `yarn dev`: lists migrations with `--local` and skips the secret list). `--url` must be `https://` except for `localhost`, `127.0.0.1` and `[::1]`, so the admin key never travels in clear text. Keep the admin key outside the repository, for example in `~/.config/saasmail-doctor.env`. The script never prints the key or the token.

It runs, in order, one line per result (`✓` pass, `!` warning, `✗` failure, `i` note), then a summary:

1. **Config**: parses the Wrangler file (JSONC) and names the Worker, the D1 database and which bindings it declares.
2. **Pending migrations**: `npx wrangler d1 migrations list <db> --remote`. Any pending, a failing or timed-out command, or output that is neither "No migrations to apply" nor a list of names: **fail**.
3. **Secrets**: `npx wrangler secret list` (names only). Fails only when `BETTER_AUTH_SECRET` or `UNSUBSCRIBE_SECRET` is neither a secret nor a var in the config; the runtime checks are authoritative for the rest. A failing command: **warn**.
4. **Deployed commit**: compares the stamp's commit with local `HEAD` and `origin/main` (**warn** when different); outside a git checkout it says it could not compare (`i`), and **warns** about uncommitted changes in the build that `--allow-dirty` does not cover. An endpoint that is unreachable, answers 401, 403 or 5xx, times out, or returns a report without `build`, with a malformed check (an unknown status), or without the mandatory checks (`migrations.pending`, `secrets.better_auth`, `secrets.dev_flags`, `bindings.required`, `provider.outbound`): **fail**.
5. **Runtime checks**: the endpoint's checks as they are.
6. **Cloudflare API** (with `CLOUDFLARE_API_TOKEN`; otherwise one `i` line):
   - For each inbox whose source is Cloudflare: its address has an enabled Email Routing rule whose action is this Worker, or, for an address on the zone's apex domain only, the catch-all does, else **fail**. An address on a subdomain needs its own rule. Gmail- and Outlook-sourced inboxes are not applicable.
   - When the outbound provider is Cloudflare Email Sending: sending is enabled for each inbox domain, else **fail**. With Resend, Postmark or Bavimail the line says not applicable.
   - A failing API call: **warn**.

Wrangler calls time out after 60 seconds, HTTP calls after 15. The exit code is 1 on any failure, and on any warning with `--strict`.

### Token scopes

The Cloudflare token needs read access only: **Zone Read**, **Email Routing Rules Read**, **Email Sending Read** and **Queues Read**.

---

**Next:** [Updating](updating.md) · [Configuration](configuration.md) · [Setup](setup.md)
