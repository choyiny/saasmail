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

## Temporary AI SDK approval-continuation patch

This release carries `scripts/patch-ai-resume.mjs`, run by `postinstall`. AI SDK
7.0.61 changed `resumeStream()` so it starts from an empty assistant message
([vercel/ai#18462](https://github.com/vercel/ai/pull/18462)), while released
`agents@0.24.0` / `@cloudflare/ai-chat@0.12.0` still use that API for tool
approval continuations and strip the continuation start chunk's `messageId`.

The install-time script patches only `node_modules/ai/dist/index.js` for the
pinned `ai@7.0.109`, restoring the previous-message seed only while
Cloudflare's `WebSocketChatTransport` has marked a tool continuation. Ordinary
page-load resume keeps AI SDK 7.0.109 behavior. The script is idempotent and
fails installation if the AI version or either exact patch anchor changes; do
not bump `ai` until this section and the compatibility patch have been
re-validated.

Remove the script and `postinstall` hook once a released Cloudflare Agents /
AI Chat pair explicitly supports AI SDK >= 7.0.61 approval continuations
without this compatibility shim. The server-side approval ledger added in #31
remains necessary: the released Cloudflare message builder still does not
retain the tool-approval `signature` field when rebuilding the persisted tool
part.

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
