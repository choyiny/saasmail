# Agent / contributor notes

Conventions for coding agents (and humans) working in this repo. Product docs live in [`README.md`](./README.md); licensing and human contribution flow in [`CONTRIBUTING.md`](./CONTRIBUTING.md); Claude Code skills in [`CLAUDE.md`](./CLAUDE.md).

## Doc map

| Doc                                                                      | Use for                                             |
| ------------------------------------------------------------------------ | --------------------------------------------------- |
| [`README.md`](./README.md)                                               | Setup, deploy, local dev, API overview              |
| [`CONTRIBUTING.md`](./CONTRIBUTING.md)                                   | Fork/PR process, Apache 2.0, CoC                    |
| [`migrations/README.md`](./migrations/README.md)                         | drizzle-kit generate / apply details                |
| [`.github/pull_request_template.md`](./.github/pull_request_template.md) | PR checklist maintainers expect (not a CI enforcer) |

## Tooling

- Use **yarn**, not npm (`yarn install --frozen-lockfile` in CI).
- **Format:** `yarn format` before push. Husky runs `lint-staged` → Prettier on staged `*.{js,jsx,ts,tsx,json,css,md,html}` at commit; CI runs full-tree `yarn format:check` (so husky alone is not enough if you skip staging a dirty file).
- **Typecheck:** `yarn tsc --noEmit`
- **Unit tests:** `yarn test` (invokes `vitest run --config vitest.config.test.ts` — bare `vitest run` hits the wrong pool config and fails to start).
- **E2E:** `yarn test:e2e` (Playwright; **wipes local D1** — re-seed with `yarn db:seed:dev` afterward). Needs `DEMO_MODE=1` + `DISABLE_PASSKEY_GATE=true` in `.dev.vars`, and `http://localhost:8788` in `TRUSTED_ORIGINS` in `wrangler.jsonc` (see `.dev.vars.example` / `wrangler.jsonc.example` and README “End-to-end tests”).

### Local `yarn test` prerequisites

Vitest uses `@cloudflare/vitest-pool-workers`, which requires a present `wrangler.jsonc` (gitignored) and `dist/client/`. Match CI:

```bash
cp wrangler.jsonc.ci wrangler.jsonc
mkdir -p dist/client
yarn tsc --noEmit
yarn test
```

Prefer `wrangler.jsonc.ci` for unit tests (placeholders tuned for the pool). Use `wrangler.jsonc.example` when setting up local `yarn dev` / deploy, not as a guaranteed drop-in for vitest.

## CI on every PR

| Workflow / check name                               | Merge impact                                                                                                                                                                                                                                           |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Format → `prettier`                                 | Fails if `yarn format:check` fails                                                                                                                                                                                                                     |
| Test → `vitest` (+ typecheck step in that workflow) | Fails on `yarn tsc --noEmit` or `yarn test`                                                                                                                                                                                                            |
| e2e → `playwright`                                  | Fails on `yarn test:e2e`                                                                                                                                                                                                                               |
| Check PR labels → job named `test`                  | Fails unless the PR has **at least one** of `major` / `minor` / `patch`; also fails if `hold` is present (`disable-reviews: true`, so this is a failing check — not a review). Note the job is named `test`, distinct from the Test/`vitest` workflow. |
| CodeQL → `Analyze (javascript-typescript)`          | Runs on PRs to `main`; findings are uploaded via codeql-action (do not treat SARIF alerts as an automatic red X unless the Analyze job itself fails)                                                                                                   |
| Release Drafter → `update_release_draft`            | Updates draft release notes; not a content gate                                                                                                                                                                                                        |

Semver labels drive [release-drafter](./.github/release-drafter.yml). Dependabot PRs already get `patch`. **Maintainers** apply `major` / `minor` / `patch` on human PRs — external fork openers generally cannot set labels on `choyiny/saasmail`. Docs-only → `patch`.

## Pull requests

From [`CONTRIBUTING.md`](./CONTRIBUTING.md) + the PR template:

1. Focused change; branch off `main`.
2. `yarn format` / `yarn tsc --noEmit` / `yarn test` (and `yarn test:e2e` if UI or HTTP surface changed).
3. User-visible change → entry under `## [Unreleased]` in `CHANGELOG.md`.
4. Schema or data migration → see below; include the generated files.
5. Behavior/setup change → update `README.md` (or other docs) when relevant.

A maintainer will add the required semver label so the Check PR labels check goes green.

## Migrations (D1 / drizzle-kit)

Do **not** hand-author `migrations/*.sql` or edit `migrations/meta/_journal.json` / snapshots by hand — that desyncs the drizzle-kit journal.

| Change type                           | Command                                                                      |
| ------------------------------------- | ---------------------------------------------------------------------------- |
| Schema in `worker/src/db/*.schema.ts` | `yarn db:generate`                                                           |
| Auth tables (better-auth)             | change config → `yarn auth:generate` → then `yarn db:generate`               |
| Data-only backfill (no schema change) | `yarn db:generate --custom --name=<slug>` then paste SQL into the empty file |

(`yarn db:generate` is `drizzle-kit generate`; `--custom` / `--name` are drizzle-kit flags. Plain generate emits nothing for data-only work: "No schema changes, nothing to migrate". `--custom` creates a journaled empty migration **and** the matching `meta/NNNN_snapshot.json`.)

`yarn db:generate` needs a local D1 under `.wrangler/` (run `yarn dev` once, or e2e setup, if it says `D1 directory not found`).

Details: [`migrations/README.md`](./migrations/README.md). Apply with `yarn db:migrate:dev` / `yarn db:migrate:prod`.

## API surface

Backend routes are Hono + Zod OpenAPI under `worker/src/routers/`. Spec is served at `/doc` (JSON) and `/swagger-ui` (not `/openapi.json` / `/api/doc`). When changing request/response shapes, update the zod-openapi schemas so `/doc` stays accurate.
