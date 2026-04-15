# Open Source Readiness Design

## Summary

Make cmail a legit open source project with proper documentation, licensing, contribution guidelines, and an interactive onboarding skill for new users setting up their own instance.

## What cmail Is

An open-source email server built on Cloudflare Workers. Receives email via Cloudflare Email Workers, sends via Resend. Features a consolidated inbox UI, MCP server for AI integrations, HTML email templates with variable interpolation, and email sequencing (drip campaigns).

## Components

### 1. README.md

Sections in order:

- **Header:** Project name, one-liner ("Self-hosted email server on Cloudflare Workers"), tech stack badges (Cloudflare Workers, Hono, Drizzle, React, TypeScript)
- **Features:**
  - Consolidated inbox — all incoming email in one dark-themed UI with sender grouping and thread sidebar
  - MCP server — JSON-RPC 2.0 MCP server with OAuth for AI tool integrations (list senders, read/send/reply, manage templates)
  - Email templates — HTML editor with `{{variable}}` interpolation, send templates via API
  - Email sequencing — multi-step drip campaigns with enrollment, step skipping, delay overrides, automatic cancellation on reply
- **Architecture:**
  - Receive emails from: Cloudflare Email Workers
  - Send emails from: Resend (`RESEND_API_KEY`)
  - Database: Cloudflare D1 (SQLite)
  - File storage: Cloudflare R2 (attachments)
  - Queue: Cloudflare Queues (sequence email processing)
  - Auth: BetterAuth with passkey support
- **Quick Start:** Step-by-step manual setup (prerequisites, clone, install, create resources, configure, migrate, deploy). Mention the `/cmail-onboarding` Claude Code skill as an alternative.
- **Local Development:** `yarn dev`, migration commands, test commands
- **Configuration:** Explain `wrangler.jsonc` (from example) and `.dev.vars` (secrets)
- **Roadmap:** Agentic email steering — AI-driven conversation flows that gather information from contacts
- **License:** Apache 2.0

### 2. LICENSE

Apache License 2.0 full text with copyright year 2025 and copyright holder "cmail contributors".

### 3. CONTRIBUTING.md

Short and practical:

- Fork and branch workflow
- Local development setup (reference README)
- PR expectations: describe what and why, keep PRs focused
- Code style: follow existing patterns, TypeScript strict, Tailwind for styling

### 4. wrangler.jsonc.example (updated)

Add the missing sections from the real config with placeholders:

- `queues` (producers + consumers)
- `triggers` (crons)
- `vars` (BASE_URL, TRUSTED_ORIGINS with placeholder values)
- `account_id` placeholder
- `routes` placeholder (commented out, optional)

### 5. /cmail-onboarding skill

Created via `/skill-creator`. The skill walks the user through:

1. **Prerequisites check:** Verify Node.js, yarn, wrangler are installed. Offer to install wrangler if missing.
2. **Wrangler login:** Run `wrangler login` if not authenticated.
3. **Install dependencies:** Run `yarn install`.
4. **Create Cloudflare resources:**
   - D1 database (`wrangler d1 create cmail-db`)
   - R2 bucket (`wrangler r2 bucket create cmail-attachments`)
   - Queue (`wrangler queues create cmail-sequence-emails`)
5. **Configure wrangler.jsonc:** Copy example, fill in the D1 database ID from creation output, set account_id, BASE_URL, TRUSTED_ORIGINS.
6. **Configure .dev.vars:** Copy example, prompt user for RESEND_API_KEY and BETTER_AUTH_SECRET.
7. **Run migrations:** `yarn db:migrate:dev` for local, `yarn db:migrate:prod` for remote.
8. **Cloudflare Email Routing:** Instruct user to configure email routing in Cloudflare dashboard to point to this worker.
9. **Deploy:** `yarn deploy`.
10. **Verify:** Open the deployed URL, create first user account.

The skill should be conversational — explain each step, run commands, report results, and pause for user input when needed (like API keys).
