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

## Check your `wrangler.jsonc`

After every update, compare your gitignored local configuration with the tracked example:

```bash
diff -u wrangler.jsonc.example wrangler.jsonc
```

Review the diff and add any new bindings, migrations, or variables that apply to your deployment. In particular, the mailbox/agent/JMAP release adds:

- the Workers AI binding: `"ai": { "binding": "AI" }`;
- the `MAIL_AGENT` Durable Object binding for class `MailAgent`;
- the Durable Object migration `{ "tag": "v2", "new_sqlite_classes": ["MailAgent"] }`;
- optional `AGENT_APPROVAL_SECRET` and `DB_LOG_QUERIES` variables.

The worker fails at runtime without the `MailAgent` binding and its `v2` Durable Object migration. Do not replace a customized `wrangler.jsonc` wholesale; merge the missing entries intentionally.

> **Workers AI billing:** enabling the `AI` binding turns on paid Workers AI usage as the native agent's fallback provider when neither `ANTHROPIC_API_KEY` nor `OPENAI_API_KEY` is configured.

After checking `wrangler.jsonc`, apply any new migrations:

```bash
yarn db:migrate:prod
```

---

**See also:** [Setup](setup.md) · [Local development](development.md) · [CHANGELOG](../CHANGELOG.md)
