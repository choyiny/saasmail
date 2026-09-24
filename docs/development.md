[saasmail](../README.md) › [Docs](README.md) › **Local development**

# Local development

```bash
# Start dev server (frontend + worker)
yarn dev

# Run tests
yarn test

# Type-check (project references — `--noEmit` checks nothing and exits 0)
yarn tsc -b

# Generate a migration after schema changes
yarn db:generate

# Apply migrations locally
yarn db:migrate:dev

# Seed the local database with mock inboxes, people, and email threads
yarn db:seed:dev

# Open Drizzle Studio (local)
yarn db:studio:dev
```

`yarn dev` serves both the SPA and the worker on **`http://localhost:8080`**.

Since Cloudflare Email Routing can't deliver to `wrangler dev`, the seed script populates `seeds/demo.sql` so you can exercise the inbox UI without real inbound email. The one exception is a [Gmail-mapped inbox](gmail.md): mail is pulled from the Gmail API rather than pushed to the worker, so it is the only way to watch real inbound mail land on a local instance. Setting that up is [Gmail on a local instance](gmail-local-setup.md).

## Firing the cron by hand

The worker's `scheduled` handler runs every 15 minutes in production. It dispatches due sequence emails, processes the retry outbox, and syncs every connected Gmail mailbox — and it is the only caller of the Gmail sync, so there is no route, button or script that syncs one mailbox on demand.

The Vite dev server forwards Miniflare's trigger endpoint, so this runs the whole handler immediately against a running `yarn dev`:

```bash
curl "http://localhost:8080/cdn-cgi/mf/scheduled"
```

**Verified from the Vite plugin and Miniflare sources, not executed** — confirm it on first use. A successful trigger answers `200` with the body `ok` and the `yarn dev` terminal prints the handler's own log lines; HTML or a `404` coming back means the request never reached the handler. The endpoint also accepts `?cron=…`, `?time=<unix-ms>` and `?format=json`.

## API explorer

The API is generated from Zod schemas in `worker/src/routers/`. Each running worker exposes an OpenAPI 3.0 spec at `/doc` (JSON) and an interactive explorer at `/swagger-ui`. Both are public — no auth required to read the spec.

## End-to-end tests

Playwright drives the UI against a local `vite dev` running in demo mode (port 8788).

```bash
# Install Playwright browsers (first run only)
yarn playwright install chromium

# Run the full E2E suite (wipes and re-seeds the local D1 first)
yarn test:e2e

# Interactive runner
yarn test:e2e:ui

# Debug a single spec
yarn test:e2e e2e/specs/compose.spec.ts
```

The E2E suite **wipes and re-seeds the local D1 database** (`.wrangler/state/v3/d1/`) every time it runs. If you have hand-seeded dev data you want to keep, re-run `yarn db:seed:dev` after the E2E suite finishes.

Requirements in `.dev.vars`: `DEMO_MODE=1` and `DISABLE_PASSKEY_GATE=true` — both are in `.dev.vars.example`. The suite also expects `http://localhost:8788` in `TRUSTED_ORIGINS` in `wrangler.jsonc`.

---

**See also:** [AGENTS.md](../AGENTS.md) for CI gates, Prettier, and the migration workflow · [CONTRIBUTING.md](../CONTRIBUTING.md) · [Architecture](architecture.md) · [Gmail on a local instance](gmail-local-setup.md)
