# Agent / contributor notes

Conventions for coding agents (and humans) working in this repo. Product docs live in [`README.md`](./README.md); licensing and human contribution flow in [`CONTRIBUTING.md`](./CONTRIBUTING.md); Claude Code skills in [`CLAUDE.md`](./CLAUDE.md).

## Doc map

| Doc                                                                      | Use for                                |
| ------------------------------------------------------------------------ | -------------------------------------- |
| [`README.md`](./README.md)                                               | Setup, deploy, local dev, API overview |
| [`CONTRIBUTING.md`](./CONTRIBUTING.md)                                   | Fork/PR process, Apache 2.0, CoC       |
| [`migrations/README.md`](./migrations/README.md)                         | drizzle-kit generate / apply details   |
| [`.github/pull_request_template.md`](./.github/pull_request_template.md) | PR checklist CI reviewers expect       |

## Tooling

- Use **yarn**, not npm (`yarn install --frozen-lockfile` in CI).
- **Format:** `yarn format` before push. Husky runs `lint-staged` → Prettier on commit; CI runs `yarn format:check`.
- **Typecheck:** `yarn tsc --noEmit`
- **Unit tests:** `yarn test` (always with `vitest.config.test.ts` — bare `vitest run` breaks in this pool).
- **E2E:** `yarn test:e2e` (Playwright; **wipes local D1** — re-seed with `yarn db:seed:dev` afterward). Needs `DEMO_MODE=1` + `DISABLE_PASSKEY_GATE=true` in `.dev.vars` (see `.dev.vars.example`).

### Local `yarn test` prerequisites

Vitest uses `@cloudflare/vitest-pool-workers`, which requires a present `wrangler.jsonc` (gitignored) and `dist/client/`. CI does:

```bash
cp wrangler.jsonc.ci wrangler.jsonc
mkdir -p dist/client
yarn tsc --noEmit
yarn test
```

Fresh clones can also start from `wrangler.jsonc.example`.

## CI gates on every PR

| Workflow        | What fails the PR                                      |
| --------------- | ------------------------------------------------------ |
| Format          | `yarn format:check`                                    |
| Test            | `yarn tsc --noEmit` + `yarn test`                      |
| e2e             | `yarn test:e2e`                                        |
| Check PR labels | Missing **exactly one** of `major` / `minor` / `patch` |
| CodeQL          | Security/quality findings (advisory)                   |

Semver labels drive [release-drafter](./.github/release-drafter.yml). Dependabot PRs already get `patch`. For human PRs, apply one of `major`/`minor`/`patch` (docs-only → `patch`). The `hold` label is invalid for merge via that check.

## Pull requests

From [`CONTRIBUTING.md`](./CONTRIBUTING.md) + the PR template:

1. Focused change; branch off `main`.
2. `yarn format` / `yarn tsc --noEmit` / `yarn test` (and `yarn test:e2e` if UI or HTTP surface changed).
3. User-visible change → entry under `## [Unreleased]` in `CHANGELOG.md`.
4. Schema or data migration → see below; include the generated files.
5. Behavior/setup change → update `README.md` (or other docs) when relevant.

A maintainer will add the required `major` / `minor` / `patch` label for release-drafter (fork openers cannot set labels on this repo).

## Migrations (D1 / drizzle-kit)

Do **not** hand-author `migrations/*.sql` or edit `migrations/meta/_journal.json` / snapshots by hand — that desyncs the drizzle-kit journal.

| Change type                           | Command                                                                         |
| ------------------------------------- | ------------------------------------------------------------------------------- |
| Schema in `worker/src/db/*.schema.ts` | `yarn db:generate`                                                              |
| Auth tables (better-auth)             | change config → `yarn auth:generate` → then `yarn db:generate`                  |
| Data-only backfill (no schema change) | `yarn db:generate -- --custom --name=<slug>` then paste SQL into the empty file |

Plain `yarn db:generate` emits nothing for data-only work ("No schema changes, nothing to migrate"). `--custom` creates a journaled empty migration **and** the matching `meta/NNNN_snapshot.json`; paste `UPDATE`/`INSERT` SQL into the generated `.sql`.

`yarn db:generate` needs a local D1 under `.wrangler/` (run `yarn dev` once, or e2e setup, if it says `D1 directory not found`).

Details: [`migrations/README.md`](./migrations/README.md). Apply with `yarn db:migrate:dev` / `yarn db:migrate:prod`.

## API surface

Backend routes are Hono + Zod OpenAPI under `worker/src/routers/`. Spec is served at `/doc` (JSON) and `/swagger-ui` (not `/openapi.json` / `/api/doc`). When changing request/response shapes, update the zod-openapi schemas so `/doc` stays accurate.
