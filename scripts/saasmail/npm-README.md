# saasmail

The installer for [saasmail](https://github.com/choyiny/saasmail), the centralized inbox for SaaS teams, on
Cloudflare Workers. This package carries a built saasmail release (worker, web app and database migrations) and
deploys it to your Cloudflare account with its own pinned wrangler. You do not need a clone of the repository.

Requires Node.js 22 or later.

## Install

```bash
npx saasmail install
```

It asks for what it needs, shows the plan, and applies it when you confirm. Sign in first with
`npx wrangler login`, or set `CLOUDFLARE_API_TOKEN`. To review the plan without changing anything:

```bash
npx saasmail install --plan
```

## Upgrade

```bash
npx saasmail@latest upgrade
```

Moves an installation to the package's version: applies new migrations, adds new resources and secrets, and
deploys. It never downgrades.

## Status

```bash
npx saasmail status
```

State lives in `~/.saasmail` (override with `SAASMAIL_HOME`). Run `npx saasmail --help` for every option.

Docs: [setup](https://github.com/choyiny/saasmail/blob/main/docs/setup.md) ·
[updating](https://github.com/choyiny/saasmail/blob/main/docs/updating.md). Licensed under Apache-2.0.
