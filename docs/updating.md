[saasmail](../README.md) › [Docs](README.md) › **Updating**

# Updating saasmail

## Recommended: `npx saasmail@latest upgrade`

If you installed with `npx saasmail install`, upgrade the same way:

```bash
npx saasmail@latest upgrade --plan     # read-only: what would change, and the apply command
npx saasmail@latest upgrade            # apply
```

It moves the installation to the package's version: applies new migrations, adds the bindings and secrets the release needs, and deploys. `npx saasmail status` shows the running version next to **Latest** on npm. Flags: `--name <name>` (when several installs exist), `--plan`, `--expect-plan <digest>`, `--resume`, `--yes`, `--replace-custom-code`.

- **No downgrades.** If the site runs a newer version than the package, it stops and names the version to run instead.
- **Custom code.** If the running version is not a release (a modified fork, a dirty or diverged commit, or one it cannot identify), it stops and changes nothing. `--replace-custom-code` replaces it with the release.
- **Migrations cannot be undone.** If a release is broken, the way back is the next release.
- **A failed upgrade** prints the command to continue; `--resume` picks it up even if the site is down meanwhile.

`/update-saasmail` in Claude Code runs the plan and walks you through it; you run the apply in your own terminal because it prints the setup code.

## A database without d1_migrations

`upgrade` reads the `d1_migrations` table to know which migrations already ran. A database set up some other way (for example SQL files run with `wrangler d1 execute`) has saasmail's tables but no such table, so the plan stops with `D1 <name> has tables but no d1_migrations table` and changes nothing. Running every migration again would fail on the existing tables.

To continue, record the migrations that already ran. Compare the database's tables with the files in the release's `migrations/` folder (the CHANGELOG names the migrations each release adds), then create the table and insert one row per applied file. Use the wrangler version the installer's printed commands name (`npx wrangler@<version>`):

```bash
npx wrangler@<version> d1 execute <database> --remote --config ~/.saasmail/<slug>/wrangler.jsonc --command "
  CREATE TABLE IF NOT EXISTS d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL);
  INSERT INTO d1_migrations (name) VALUES ('0000_init.sql'), ('0001_...sql');"
```

Then run the upgrade again: it applies only the files not listed.

## Forks and modified code

Keep a clone, and sync it with upstream:

```bash
git remote add upstream https://github.com/choyiny/saasmail.git  # first time only
git fetch upstream
git rebase upstream/main -X ours
```

The `-X ours` flag tells rebase to prefer upstream for conflicting hunks (during a rebase, "ours" is the branch being rebased onto). Your local commits are still replayed on top. `/update-saasmail` does this for you.

After every update and deploy, run `yarn doctor --config wrangler.jsonc --url <your URL>`: it shows which commit the deployment runs and finds a migration not applied, a missing secret or binding, or a dev flag left on ([Doctor](doctor.md)).

## Upstream migrations

This fork numbers its D1 migrations on its own, so upstream's
`migrations/*.sql` files reuse numbers the fork already has under other names.
Git adds them without a conflict, and wrangler would run any that survive at
the next `yarn db:migrate:prod`, because it applies every file whose name is
not yet in `d1_migrations`.

When you merge upstream:

1. Delete every upstream `migrations/*.sql` the merge adds, and keep the
   fork's side of `migrations/meta/_journal.json` and of every
   `migrations/meta/*_snapshot.json` exactly.
2. Re-express the schema change with `yarn db:generate --name=<slug>` under
   the fork's next number, check that the new file holds only upstream's
   statements, and update `applyMigrations()` in
   `worker/src/__tests__/helpers.ts` in the same commit.
3. Add a row to the table below.

| Upstream file                              | Fork file                            | Note                                                                                        |
| ------------------------------------------ | ------------------------------------ | ------------------------------------------------------------------------------------------- |
| `0035_overjoyed_rocket_racer.sql`          | `0085_upstream_gmail_accounts.sql`   | same statements                                                                             |
| `0036_futuristic_gunslinger.sql`           | `0086_upstream_gmail_outlook.sql`    | same statements                                                                             |
| `0037_careful_gwen_stacy.sql`              | `0086_upstream_gmail_outlook.sql`    | same statements                                                                             |
| `0038_thick_blonde_phantom.sql`            | `0086_upstream_gmail_outlook.sql`    | dropped: index already in fork 0067                                                         |
| `0039_amazing_moondragon.sql`              | `0086_upstream_gmail_outlook.sql`    | same statements                                                                             |
| `0040_needy_nocturne.sql`                  | `0086_upstream_gmail_outlook.sql`    | dropped: index replaced by 0041                                                             |
| `0041_old_nighthawk.sql`                   | `0086_upstream_gmail_outlook.sql`    | unique index only                                                                           |
| `0042_gmail_backfill.sql`                  | `0086_upstream_gmail_outlook.sql`    | same statements                                                                             |
| `0043_gmail_backfill_one_year.sql`         | `0086_upstream_gmail_outlook.sql`    | column only; dropped: data step on an empty table                                           |
| `0044_gmail_backfill_job.sql`              | `0086_upstream_gmail_outlook.sql`    | same statements                                                                             |
| `0045_gmail_backfill_progress.sql`         | `0086_upstream_gmail_outlook.sql`    | same statements                                                                             |
| `0046_careless_silhouette.sql`             | `0086_upstream_gmail_outlook.sql`    | same statements                                                                             |
| `0047_outlook_mailboxes.sql`               | `0086_upstream_gmail_outlook.sql`    | same statements                                                                             |
| `0048_user_prefs_mail_states.sql`          | `0087_upstream_user_preferences.sql` | `user_preferences` only; dropped: `mail_item_states` (the fork keeps its own state model)   |
| `0049_user_prefs_palette.sql`              | `0087_upstream_user_preferences.sql` | column in the `CREATE TABLE`                                                                |
| `0050_trash_overrides_layout_settings.sql` | `0087_upstream_user_preferences.sql` | `category_overrides`, columns in the `CREATE TABLE`; dropped: `mail_item_states.trashed_at` |
| `0051_better_auth_1_7.sql`                 | `0088_upstream_better_auth_1_7.sql`  | same statements                                                                             |

Upstream's `mail_item_states` table is never created here. The inbox list's
star, archive, snooze and Trash live in the fork's per-message state, and pins
in `user_row_pins` (fork migration `0089`), as
[Mailbox state](mailbox-state.md#rows-in-the-inbox-list) describes. An upstream
migration that touches `mail_item_states` is dropped when it is ported.

Keep the fork's hourly cron (`0 * * * *` in `wrangler.jsonc.example` and
`wrangler.jsonc.ci`) and `MAX_OUTBOX_ATTEMPTS` (24) when upstream changes
them: upstream polls every 15 minutes. Gmail and Outlook mail therefore syncs
hourly here ([Configuration](configuration.md)).

`yarn typecheck` runs `scripts/check-migrations.mjs`, which fails while two
migration files share a number, so an upstream file that survives a merge
fails CI.

## Temporary AI SDK approval-continuation patch

This release carries `scripts/patch-ai-resume.mjs`, run by `postinstall`. AI SDK
7.0.61 changed `resumeStream()` so it starts from an empty assistant message
([vercel/ai#18462](https://github.com/vercel/ai/pull/18462)), while released
`agents@0.24.0` / `@cloudflare/ai-chat@0.12.0` still use that API for tool
approval continuations and strip the continuation start chunk's `messageId`.

The install-time script patches two files:

- `node_modules/ai/dist/index.js` (pinned `ai@7.0.109`): restores the
  previous-message seed only while Cloudflare's `WebSocketChatTransport` has
  marked a tool continuation.
- `node_modules/@ai-sdk/react/dist/index.js` (pinned `@ai-sdk/react@4.0.112`):
  `useChat` wraps the transport in a proxy, so the proxy forwards the
  `_expectToolContinuation` flag. Without this, the seed check never sees it.

Ordinary page-load resume keeps AI SDK 7.0.109 behavior. The script is
idempotent, clears Vite's `node_modules/.vite` pre-bundle cache when it changes
a file, and fails installation if either version or any exact patch anchor
changes. Do not bump `ai` or `@ai-sdk/react` until this section and the
compatibility patch have been re-validated;
`src/agent/useAgentChat.approval-continuation.test.tsx` must fail without the
patch and pass with it.

Remove the script and `postinstall` hook once a released Cloudflare Agents /
AI Chat pair explicitly supports AI SDK >= 7.0.61 approval continuations
without this compatibility shim. The server-side approval ledger
(`agent_approval_ledger`, see [Native mail agent](agent.md)) remains necessary: the released Cloudflare message builder still does not
retain the tool-approval `signature` field when rebuilding the persisted tool
part.

## Check your `wrangler.jsonc`

After every update, compare your gitignored local configuration with the tracked example:

```bash
diff -u wrangler.jsonc.example wrangler.jsonc
```

Review the diff and add any new bindings, migrations, or variables that apply to your deployment. In particular, the mailbox/agent/JMAP release adds:

- the `enable_request_signal` compatibility flag, which [JMAP](jmap.md) push
  streams need to notice a disconnected client;
- the Workers AI binding: `"ai": { "binding": "AI" }`;
- the `MAIL_AGENT` Durable Object binding for class `MailAgent`;
- the Durable Object migration `{ "tag": "v2", "new_sqlite_classes": ["MailAgent"] }`;
- the optional `AGENT_APPROVAL_SECRET` secret, and the optional
  `DB_LOG_QUERIES`, `MCP_SEND_ENABLED` and `PROVIDER_DAILY_SEND_LIMIT` variables;
- an optional `BACKUPS` R2 bucket for [database backups](data.md#backups)
  (without it they go to the attachments bucket under `backups/`), and the
  optional `BACKUP_ENCRYPTION_KEY` secret. Scheduled backups stay off until an
  admin turns them on.

Also check that `UNSUBSCRIBE_SECRET` is set (`wrangler secret list`): newsletter campaigns refuse to start without it.

The worker fails at runtime without the `MailAgent` binding and its `v2` Durable Object migration. Do not replace a customized `wrangler.jsonc` wholesale; merge the missing entries intentionally.

> **Workers AI billing:** enabling the `AI` binding turns on paid Workers AI usage as the native agent's fallback provider when neither `ANTHROPIC_API_KEY` nor `OPENAI_API_KEY` is configured.

After checking `wrangler.jsonc`, apply any new migrations:

```bash
yarn db:migrate:prod
```

If `yarn saasmail install` generated your `wrangler.jsonc` (its first line says so), don't hand-edit its top level: the installer owns it and records a hash of what it deployed, and `yarn saasmail install --resume` refuses to deploy when the config it would generate from this checkout differs (an upgrade). It never upgrades a deployed instance, so updates still go through the path above. Your `wrangler.jsonc` is yours and is never touched by the rebase, so compare it with `wrangler.jsonc.example` for new bindings — the [CHANGELOG](../CHANGELOG.md) names each one. A missing binding usually means a feature falls back or stays off rather than failing; the Gmail import job (`workflows`) is one.

If `yarn saasmail install --resume` tells you to check out the deployed commit (adding credentials or a setup code to an instance that this checkout would upgrade), do that only if you have never updated with `yarn deploy` since installing. Otherwise deploying the older commit would roll back code and schema: follow the update path above instead, and add the credential with `yarn wrangler secret put`.

---

**See also:** [Setup](setup.md) · [Local development](development.md) · [CHANGELOG](../CHANGELOG.md)
