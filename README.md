<p align="center">
  <img src="public/saasmail-logo.png" alt="saasmail" width="480" />
</p>

<p align="center">
  <a href="https://github.com/choyiny/saasmail/actions/workflows/test.yml"><img alt="Tests" src="https://github.com/choyiny/saasmail/actions/workflows/test.yml/badge.svg" /></a>
  <a href="https://github.com/choyiny/saasmail/actions/workflows/e2e.yml"><img alt="E2E" src="https://github.com/choyiny/saasmail/actions/workflows/e2e.yml/badge.svg" /></a>
  <a href="https://github.com/choyiny/saasmail/actions/workflows/codeql.yml"><img alt="CodeQL" src="https://github.com/choyiny/saasmail/actions/workflows/codeql.yml/badge.svg" /></a>
  <a href="https://github.com/choyiny/saasmail/releases/latest"><img alt="Latest release" src="https://img.shields.io/github/v/release/choyiny/saasmail?sort=semver" /></a>
  <a href="LICENSE"><img alt="License: Apache 2.0" src="https://img.shields.io/badge/license-Apache%202.0-blue.svg" /></a>
  <a href="https://workers.cloudflare.com/"><img alt="Cloudflare Workers" src="https://img.shields.io/badge/runs%20on-Cloudflare%20Workers-F38020?logo=cloudflare&logoColor=white" /></a>
</p>

**The centralized inbox for SaaS teams.** One unified timeline per customer — marketing, notifications, and support emails collapsed into a single view, per person.

Every interaction with a customer matters, and context compounds. saasmail pulls the promo blast, the billing receipt, and the support thread into the same conversation, so anyone on your team can respond with the full history already in hand.

Self-hosted on Cloudflare Workers. Receive with **Cloudflare Email Workers**. Send with **Cloudflare Email Sending**, **Resend**, **Bavimail**, or **Postmark**.

<img width="5088" height="3106" alt="saasmail-new" src="https://github.com/user-attachments/assets/407a8b4e-3ba0-4ed9-ae8a-f39dee861e56" />

## Who this is for

SaaS teams that want a self-hosted email stack on Cloudflare Workers — one shared, per-customer inbox for marketing, transactional, and support mail — without renting a VM or operating a traditional mail server. If you have a domain, a Cloudflare account, and want to own your customer email data for [~$5/month](#how-much-does-it-cost), this is for you.

## Quickstart

**Prerequisites:** a domain on Cloudflare with Email Routing available, the Workers Paid plan, and [Node.js](https://nodejs.org/) v18+.

The fastest path is the Claude Code onboarding skill — it provisions every Cloudflare resource, fills out your config, runs migrations, and deploys for you:

```bash
git clone https://github.com/choyiny/saasmail.git
cd saasmail
claude   # then run /saasmail-onboarding
```

**First successful result:** your worker is live at your domain, and visiting it prompts you to create the first admin account. Name an inbox, send yourself a test email, and watch it land on a customer timeline.

Prefer to wire it up by hand? See [Setup](docs/setup.md) (~8 steps).

## Documentation

<a id="full-setup"></a><a id="recommended-install-with-claude-code"></a><a id="manual-setup"></a><a id="prerequisites"></a><a id="1-clone-and-install"></a><a id="2-authenticate-with-cloudflare"></a><a id="3-create-cloudflare-resources"></a><a id="4-configure-wrangler"></a><a id="5-configure-secrets"></a><a id="6-run-migrations"></a><a id="7-configure-email-routing"></a><a id="8-deploy"></a><a id="configuration"></a><a id="wranglerjsonc"></a><a id="devvars"></a><a id="updating-saasmail"></a><a id="recommended-update-saasmail"></a><a id="manual"></a><a id="local-development"></a><a id="end-to-end-tests"></a><a id="architecture"></a><a id="architecture-diagram"></a>

Full docs live in **[docs/](docs/README.md)**.

**Deploy and operate:** [Setup](docs/setup.md) · [Email providers](docs/email-providers.md) · [Configuration](docs/configuration.md) · [Updating](docs/updating.md) · [Architecture](docs/architecture.md) · [Local development](docs/development.md)

**Features:** [Inboxes and timelines](docs/inboxes.md) · [Email templates](docs/templates.md) · [Sequences](docs/sequences.md) · [Suppressions and unsubscribe](docs/suppressions.md) · [Users and API keys](docs/users-and-api-keys.md) · [MCP server](docs/mcp.md) · [WebMCP](docs/webmcp.md) · [Webhooks](docs/webhooks.md)

## Architecture at a glance

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/diagrams/saasmail-architecture-dark.png">
  <img alt="Inbound customer email arrives through Cloudflare Email Routing into a single saasmail Worker, which keeps mail and contacts in D1, attachments in R2, and scheduled sequence steps in a Queue; replies leave through one outbound provider - Cloudflare Email Sending, Resend, Bavimail, or Postmark - and land back with the customer." src="docs/diagrams/saasmail-architecture.png">
</picture>

Everything runs inside a single Cloudflare Worker — no separate mail server to operate. See [Architecture](docs/architecture.md) for the full diagram and the component-by-component breakdown.

## Sponsors

<a href="https://givefeedback.dev/saas"><img width="200" height="44" alt="givefeedback.dev" src="https://github.com/user-attachments/assets/7da9ef06-cc47-4aa5-94b1-2108a302439c" /></a>
GiveFeedback.dev uses AI to turn client screen recordings into actionable tasks and prevent scope creep.

## Demo Video

One person's mail across four inboxes, collapsed into a single timeline — filter by inbox and reply inline.

https://github.com/user-attachments/assets/870186a2-840f-4b95-b859-4acd44863263

## Screenshots

**One timeline per customer** — every inbox a person has emailed collapses into a single conversation, with per-inbox tabs and a chat-style composer.

![Unified customer timeline](docs/screenshots/inbox-timeline.jpg)

**Agent Plan (WebMCP)** — connect a browser AI agent and watch it work the inbox: it reads a playbook, lays out a live plan, and ticks steps off while a bottom-right feed groups each tool call as it runs.

![Agent Plan with live plan and activity feed](docs/screenshots/agent-plan.jpg)

**Table overview** — stat tiles plus a sortable people table spanning every inbox, with unread and attachment indicators.

![Table overview](docs/screenshots/table-view.jpg)

**Templates & sequences** — reusable `{{variable}}` email templates and multi-step drip campaigns you enroll contacts into.

![Email templates](docs/screenshots/templates.jpg)

![Drip sequences](docs/screenshots/sequences.jpg)

## Features

- <a id="one-timeline-per-customer"></a>**[One timeline per customer](docs/inboxes.md#one-timeline-per-customer)** — marketing, transactional, and support mail from a person, collapsed into one conversation.
- <a id="multi-inbox-with-team-permissions"></a>**[Multi-inbox with team permissions](docs/inboxes.md#multi-inbox-with-team-permissions)** — many inbound addresses on one deployment; members see only the inboxes they're assigned.
- <a id="thread-or-chat-per-inbox"></a>**[Thread or chat, per inbox](docs/inboxes.md#thread-or-chat-per-inbox)** — formal threading for `marketing@`, iMessage-style bubbles for `support@`.
- <a id="per-inbox-forwarding"></a>**[Per-inbox forwarding](docs/inboxes.md#per-inbox-forwarding)** — re-send inbound mail to any address through your own provider, sidestepping the IP blocks that break Email Routing forwards.
- <a id="email-templates"></a><a id="template-syntax"></a><a id="upgrading-escaping-is-now-the-default"></a>**[Email templates](docs/templates.md)** — reusable HTML with `{{variable}}` interpolation, sections, and a validated send contract.
- <a id="email-sequencing"></a>**[Sequences](docs/sequences.md)** — multi-step drip campaigns with delay overrides and auto-cancel on reply.
- <a id="suppressions-and-unsubscribe"></a>**[Suppressions and unsubscribe](docs/suppressions.md)** — RFC 8058 one-click unsubscribe, a suppression list enforced on every send path, and a `transactional` bypass.
- <a id="user-management"></a><a id="api-keys"></a>**[Users and API keys](docs/users-and-api-keys.md)** — invite-only onboarding, passkeys, and scoped `sk_…` keys.
- <a id="mcp-server-ai-assistant-access"></a><a id="connecting-a-client"></a><a id="naming-the-connection"></a><a id="scopes"></a>**[MCP server](docs/mcp.md)** — connect Claude or any MCP client to your inbox over OAuth 2.1, scoped to that user's inboxes.
- <a id="webmcp-support-in-page-ai-agent-access"></a>**[WebMCP](docs/webmcp.md)** — 20 in-page tools so a browser AI agent can work the inbox as the signed-in user. Reads and drafts; never sends or deletes.
- <a id="webhooks"></a>**[Webhooks](docs/webhooks.md)** — HMAC-signed `message.received` callbacks for help-desk automation.

## Provider Matrix

|               | Cloudflare | Resend | Bavimail | Postmark |
| ------------- | ---------- | ------ | -------- | -------- |
| **Sending**   | ✅         | ✅     | ✅       | ✅       |
| **Receiving** | ✅         | ❌     | ❌       | ❌       |

Pick one outbound provider at deploy time — see [Email providers](docs/email-providers.md) for the per-provider config and the runtime selection order.

## How much does it cost?

**$5/month** for the Cloudflare Workers Paid plan, which includes **3,000 emails per month** of Cloudflare Email Sending at no extra cost. That's it.

No VM to rent. No sprawling cloud console to learn. Just a domain, a Cloudflare account, and the Workers Paid plan.

## Roadmap

- **Agentic email steering** — AI-driven conversation flows that intelligently gather information from contacts through multi-turn email exchanges

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). All participants are expected to follow the [Code of Conduct](CODE_OF_CONDUCT.md). Security issues: see [SECURITY.md](SECURITY.md).

This repo ships a `CLAUDE.md` at the project root with a few notes the maintainer uses when pairing with [Claude Code](https://claude.ai/claude-code). It's harmless to ignore if you're not using Claude Code.

## License

[Apache License 2.0](LICENSE)

The name "saasmail" and the saasmail logo are used by the original project to identify it. You are free to fork and redistribute the source under the Apache 2.0 license, but please rename your fork (and replace `public/saasmail-logo.png`) if you run it as a branded product, so users aren't confused about which project they're installing.
