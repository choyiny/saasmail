[saasmail](../README.md) › [Docs](README.md) › **Updating**

# Updating saasmail

## Recommended: `/update-saasmail`

From inside Claude Code, run **`/update-saasmail`**. It links the `upstream` remote to `https://github.com/choyiny/saasmail`, fetches the latest, and rebases your local commits on top. Any unresolvable conflicts are auto-resolved in favor of upstream so the sync never gets stuck.

## Manual

```bash
git remote add upstream https://github.com/choyiny/saasmail.git  # first time only
git fetch upstream
git rebase upstream/main -X ours
```

The `-X ours` flag tells rebase to prefer upstream for conflicting hunks (during a rebase, "ours" is the branch being rebased onto). Your local commits are still replayed on top.

After rebasing, apply any new migrations:

```bash
yarn db:migrate:prod
```

If `yarn saasmail install` generated your `wrangler.jsonc` (its first line says so), don't hand-edit its top level: the installer owns it and records a hash of what it deployed, and `yarn saasmail install --resume` refuses to deploy when the config it would generate from this checkout differs (an upgrade). It never upgrades a deployed instance, so updates still go through the path above. Your `wrangler.jsonc` is yours and is never touched by the rebase, so compare it with `wrangler.jsonc.example` for new bindings — the [CHANGELOG](../CHANGELOG.md) names each one. A missing binding usually means a feature falls back or stays off rather than failing; the Gmail import job (`workflows`) is one.

---

**See also:** [Setup](setup.md) · [Local development](development.md) · [CHANGELOG](../CHANGELOG.md)
