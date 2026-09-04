[saasmail](../README.md) › **Docs**

# saasmail documentation

Everything that used to live in one very long README. Start at
[Setup](setup.md) if you're deploying, or jump to a feature below.

## Deploying and operating

| Page                                  | What's in it                                                                   |
| ------------------------------------- | ------------------------------------------------------------------------------ |
| [Setup](setup.md)                     | Full install — the Claude Code wizard, or the eight manual steps it automates  |
| [Email providers](email-providers.md) | Cloudflare Email Sending, Resend, Bavimail, Postmark — and which one wins      |
| [Configuration](configuration.md)     | Every key in `wrangler.jsonc` and `.dev.vars`, and where secrets go in prod    |
| [Updating](updating.md)               | Rebasing a fork on upstream, by skill or by hand                               |
| [Architecture](architecture.md)       | The stack table, the Mermaid diagram, and what the Durable Object and queue do |
| [Local development](development.md)   | `yarn dev`, seeding, the OpenAPI explorer, and the Playwright E2E suite        |

## Features

| Page                                            | What's in it                                                                 |
| ----------------------------------------------- | ---------------------------------------------------------------------------- |
| [Inboxes and timelines](inboxes.md)             | One timeline per customer, team permissions, thread-vs-chat mode, forwarding |
| [Email templates](templates.md)                 | The `{{variable}}` grammar, sections, escaping, and the send contract        |
| [Sequences](sequences.md)                       | Multi-step drip campaigns and how they're scheduled                          |
| [Newsletters](newsletters.md)                   | Lists, subscribe forms, campaigns, tracking, and retention                   |
| [Suppressions and unsubscribe](suppressions.md) | The suppression list, RFC 8058 one-click, and the `transactional` flag       |
| [Users and API keys](users-and-api-keys.md)     | Invites, roles, passkeys, and `sk_…` keys                                    |
| [MCP server](mcp.md)                            | Remote AI assistant access over OAuth 2.1 — connecting, scopes, revocation   |
| [WebMCP](webmcp.md)                             | In-page agent access, the safety model, and the 20 tools                     |
| [Webhooks](webhooks.md)                         | `message.received`, the payload, and signature verification                  |

## Elsewhere in the repo

| Doc                                             | Use for                                           |
| ----------------------------------------------- | ------------------------------------------------- |
| [README](../README.md)                          | What saasmail is, quickstart, screenshots, cost   |
| [AGENTS.md](../AGENTS.md)                       | CI gates, Prettier, PR labels, migration workflow |
| [CONTRIBUTING.md](../CONTRIBUTING.md)           | Fork/PR process, Apache 2.0, Code of Conduct      |
| [CHANGELOG.md](../CHANGELOG.md)                 | What changed, per release                         |
| [migrations/README.md](../migrations/README.md) | drizzle-kit generate / apply details              |
| [SECURITY.md](../SECURITY.md)                   | Reporting a vulnerability                         |
