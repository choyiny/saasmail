[saasmail](../README.md) › [Docs](README.md) › **Local development**

# Local development

```bash
# Start dev server (frontend + worker)
yarn dev

# Run tests
yarn test

# Type-check
yarn typecheck

# Generate a migration after schema changes
yarn db:generate

# Apply migrations locally
yarn db:migrate:dev

# Seed the local database with mock inboxes, people, and email threads
yarn db:seed:dev

# Open Drizzle Studio (local)
yarn db:studio:dev
```

Since Cloudflare Email Routing can't deliver to `wrangler dev`, the seed script populates `seeds/demo.sql` so you can exercise the inbox UI without real inbound email.

## Type checking

Use Node 22, matching CI and the repository's `.nvmrc`, then run:

```bash
yarn typecheck
```

The frontend check (`tsc -p tsconfig.app.json --noEmit`) is a zero-error gate. The worker still carries older TypeScript debt, so `scripts/check-worker-types.mjs` compares `tsc -p worker/tsconfig.json --noEmit --pretty false` against the committed per-file counts in `scripts/worker-tsc-baseline.json`. A file that exceeds its count, or a file absent from the baseline that gains an error, fails the check. Files that improve are printed but do not fail, so the baseline only moves downward during normal development.

Only when intentionally accepting a new snapshot of existing worker debt, regenerate the file with:

```bash
yarn typecheck:update-baseline
```

Review that diff carefully; newly added worker files should be error-free rather than added to the baseline.

Web tests use jsdom for `localStorage` and `sessionStorage`. Node 25 and newer also provide experimental built-in web storage, which can shadow jsdom's globals, so `vitest.config.web.ts` passes `--no-experimental-webstorage` to its test workers. Node 22 accepts the same negated flag, keeping local and CI behavior aligned.

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

**See also:** [AGENTS.md](../AGENTS.md) for CI gates, Prettier, and the migration workflow · [CONTRIBUTING.md](../CONTRIBUTING.md) · [Architecture](architecture.md)
