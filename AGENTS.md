# Agent / contributor notes

Conventions for coding agents (and humans) working in this repo. Product docs live in [`docs/`](./docs/README.md); licensing and human contribution flow in [`CONTRIBUTING.md`](./CONTRIBUTING.md); Claude Code skills in [`CLAUDE.md`](./CLAUDE.md).

## Doc map

| Doc                                                                      | Use for                                              |
| ------------------------------------------------------------------------ | ---------------------------------------------------- |
| [`README.md`](./README.md)                                               | Project overview, quickstart, feature index          |
| [`docs/`](./docs/README.md)                                              | Setup, configuration, architecture, per-feature docs |
| [`docs/development.md`](./docs/development.md)                           | Local dev commands, seeding, OpenAPI, E2E            |
| [`CONTRIBUTING.md`](./CONTRIBUTING.md)                                   | Fork/PR process, Apache 2.0, CoC                     |
| [`migrations/README.md`](./migrations/README.md)                         | drizzle-kit generate / apply details                 |
| [`.github/pull_request_template.md`](./.github/pull_request_template.md) | PR checklist maintainers expect (not a CI enforcer)  |

Docs pages are cross-linked and each carries a breadcrumb back to
[`docs/README.md`](./docs/README.md) — add new product documentation as a page
there and link it from the index rather than growing `README.md`.

## Tooling

- Use **yarn**, not npm (`yarn install --frozen-lockfile` in CI).
- **Lockfile integrity:** after dependency changes, run `yarn install --update-checksums`; CI rejects any `yarn.lock` resolved entry without an integrity hash.
- **Format:** `yarn format` before push. Husky runs `lint-staged` → Prettier on staged `*.{js,jsx,ts,tsx,json,css,md,html}` at commit; CI runs full-tree `yarn format:check` (so husky alone is not enough if you skip staging a dirty file).
- **Typecheck:** `yarn typecheck` — the frontend must have zero TypeScript errors; the worker uses the committed per-file ratchet documented in [`docs/development.md`](./docs/development.md#type-checking).
- **Unit tests:** `yarn test` (invokes `vitest run --config vitest.config.test.ts` — bare `vitest run` hits the wrong pool config and fails to start).
- **E2E:** `yarn test:e2e` (Playwright; **wipes local D1** — re-seed with `yarn db:seed:dev` afterward). Needs `DEMO_MODE=1` + `DISABLE_PASSKEY_GATE=true` in `.dev.vars`, and `http://localhost:8788` in `TRUSTED_ORIGINS` in `wrangler.jsonc` (see `.dev.vars.example` / `wrangler.jsonc.example` and [`docs/development.md`](./docs/development.md#end-to-end-tests)).

### Local `yarn test` prerequisites

Vitest uses `@cloudflare/vitest-pool-workers`, which requires a present `wrangler.jsonc` (gitignored) and `dist/client/`. Match CI:

```bash
cp wrangler.jsonc.ci wrangler.jsonc
mkdir -p dist/client
yarn typecheck
yarn test
```

Prefer `wrangler.jsonc.ci` for unit tests (placeholders tuned for the pool). Use `wrangler.jsonc.example` when setting up local `yarn dev` / deploy, not as a guaranteed drop-in for vitest.

## CI on every PR

| Workflow / check name                               | Merge impact                                                                                                                                                                                                                                           |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Format → `prettier`                                 | Fails if `yarn format:check` fails                                                                                                                                                                                                                     |
| Test → `vitest` (+ typecheck step in that workflow) | Fails on `yarn typecheck` (frontend zero-error gate + worker per-file ratchet) or `yarn test`                                                                                                                                                          |
| e2e → `playwright`                                  | Fails on `yarn test:e2e`                                                                                                                                                                                                                               |
| Check PR labels → job named `test`                  | Fails unless the PR has **at least one** of `major` / `minor` / `patch`; also fails if `hold` is present (`disable-reviews: true`, so this is a failing check — not a review). Note the job is named `test`, distinct from the Test/`vitest` workflow. |
| CodeQL → `Analyze (javascript-typescript)`          | Runs on PRs to `main`; findings are uploaded via codeql-action (do not treat SARIF alerts as an automatic red X unless the Analyze job itself fails)                                                                                                   |
| Release Drafter → `update_release_draft`            | Updates draft release notes; not a content gate                                                                                                                                                                                                        |

Semver labels drive [release-drafter](./.github/release-drafter.yml). Dependabot PRs already get `patch`. **Maintainers** apply `major` / `minor` / `patch` on human PRs — external fork openers generally cannot set labels on `choyiny/saasmail`. Docs-only → `patch`.

## Pull requests

From [`CONTRIBUTING.md`](./CONTRIBUTING.md) + the PR template:

1. Focused change; branch off `main`.
2. `yarn format` / `yarn typecheck` / `yarn test` (and `yarn test:e2e` if UI or HTTP surface changed).
3. User-visible change → entry under `## [Unreleased]` in `CHANGELOG.md`.
4. Schema or data migration → see below; include the generated files.
5. Behavior/setup change → update the relevant page under [`docs/`](./docs/README.md) (and `README.md` if the overview or feature index changes).

A maintainer will add the required semver label so the Check PR labels check goes green.

## Migrations (D1 / drizzle-kit)

Do **not** hand-author `migrations/*.sql` or edit `migrations/meta/_journal.json` / snapshots by hand — that desyncs the drizzle-kit journal.

| Change type                           | Command                                                                      |
| ------------------------------------- | ---------------------------------------------------------------------------- |
| Schema in `worker/src/db/*.schema.ts` | `yarn db:generate`                                                           |
| Auth tables (better-auth)             | change config → `yarn auth:generate` → then `yarn db:generate`               |
| Data-only backfill (no schema change) | `yarn db:generate --custom --name=<slug>` then paste SQL into the empty file |

(`yarn db:generate` is `drizzle-kit generate`; `--custom` / `--name` are drizzle-kit flags. Plain generate emits nothing for data-only work: "No schema changes, nothing to migrate". In this repo, `drizzle-kit --custom` emits the SQL file and journal entry but not a usable chained snapshot, so add the matching `meta/NNNN_snapshot.json` explicitly with its `prevId` chained to the prior snapshot.)

`yarn db:generate` needs a local D1 under `.wrangler/` (run `yarn dev` once, or e2e setup, if it says `D1 directory not found`).

The test database schema in `worker/src/__tests__/helpers.ts` is hand-maintained. Every schema migration must update `applyMigrations()` there in the same change.

Details: [`migrations/README.md`](./migrations/README.md). Apply with `yarn db:migrate:dev` / `yarn db:migrate:prod`.

## API surface

Backend routes are Hono + Zod OpenAPI under `worker/src/routers/`. Spec is served at `/doc` (JSON) and `/swagger-ui` (not `/openapi.json` / `/api/doc`). When changing request/response shapes, update the zod-openapi schemas so `/doc` stays accurate.

### Message reads

Use `worker/src/lib/messages/query.ts` / `queryMessages()` for any
cross-direction mail list, search, timeline, or agent read. Do not add another
direct `emails ∪ sent_emails` merge in a router or tool.

Message state mutations go through `worker/src/lib/messages/state.ts`. Every
hard-delete path for received or sent messages must call `deleteMessageState()`
before deleting the message rows so personal state, shared state, and folder
memberships cannot become orphans.

## Native agent runtime dependencies

The native agent stack is intentionally **exact-pinned** in `package.json`:
`agents`, `@cloudflare/ai-chat`, AI SDK/provider packages, and the MCP peer
packages required by the Agents SDK. These APIs are pre-1.0 or otherwise
fast-moving. Do not loosen those pins or upgrade them opportunistically while
working on another feature. Upgrade the agent dependency set together in a
dedicated PR, regenerate `yarn.lock`, and rerun the full worker/web/e2e suite.

## WebMCP tools

WebMCP tools live in `src/webmcp/` (runtime + hook + `tools/`), registered in `DashboardLayout` via `WebMcpTools`. Read tools call `src/lib/api.ts`; action tools drive the UI through the bridge (`src/webmcp/bridge.tsx`). Add a tool by extending `createReadTools`/`createActionTools` in `src/webmcp/tools/`.
