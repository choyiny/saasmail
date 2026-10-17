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

## Adopt an existing install

Installs made another way move under the package once, then upgrade as above.

From a clone that ran `yarn saasmail install`:

```bash
npx saasmail adopt --from <checkout>
```

This copies the install's state and `wrangler.jsonc` to `~/.saasmail/<slug>/`; nothing on Cloudflare changes. The clone keeps a marker and refuses to install or resume it afterwards.

From a worker deployed by hand or by the old onboarding skill:

```bash
npx saasmail adopt --worker <name> [--account <id|name>] [--inbound-domain <domain>] [--send-domain <domain>] --plan
```

It reads the worker's bindings from Cloudflare and deploys nothing. If the running version is unknown, the first upgrade needs `--replace-custom-code`. Zone routes other than custom domains are not supported.

The first upgrade deploys saasmail's generated config, which replaces the worker's vars. So adopt stops, writing nothing, when a var would be lost or changed: a var the generated config does not set, one it sets to a different value (for example a `TRUSTED_ORIGINS` list edited by hand; it becomes the site URL), or a plain var named like a secret saasmail generates (`BETTER_AUTH_SECRET`, `UNSUBSCRIBE_SECRET`, `TOKEN_ENCRYPTION_KEY`, `VAPID_PRIVATE_KEY`, `SETUP_CODE_HASH`). It lists each var with its current and new value (a secret-named var's value is not shown). Change or remove them on the worker, then run adopt again. For a secret-named var, keep its value: change its type to Secret in the dashboard (Worker → Settings → Variables and Secrets), so data it protects stays readable. `SAASMAIL_VERSION` is expected to change and does not stop it.

### A database without d1_migrations

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

After rebasing, apply any new migrations:

```bash
yarn db:migrate:prod
```

If `yarn saasmail install` generated your `wrangler.jsonc` (its first line says so), don't hand-edit its top level: the installer owns it and records a hash of what it deployed, and `yarn saasmail install --resume` refuses to deploy when the config it would generate from this checkout differs (an upgrade). It never upgrades a deployed instance, so updates still go through the path above. Your `wrangler.jsonc` is yours and is never touched by the rebase, so compare it with `wrangler.jsonc.example` for new bindings — the [CHANGELOG](../CHANGELOG.md) names each one. A missing binding usually means a feature falls back or stays off rather than failing; the Gmail import job (`workflows`) is one.

If `yarn saasmail install --resume` tells you to check out the deployed commit (adding credentials or a setup code to an instance that this checkout would upgrade), do that only if you have never updated with `yarn deploy` since installing. Otherwise deploying the older commit would roll back code and schema: follow the update path above instead, and add the credential with `yarn wrangler secret put`.

---

**See also:** [Setup](setup.md) · [Local development](development.md) · [CHANGELOG](../CHANGELOG.md)
