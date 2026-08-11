# Agent / contributor notes

Conventions for humans and coding agents working in this repo. Product docs stay in `README.md`; Claude Code skills stay in `CLAUDE.md`.

## Tooling

- Use **yarn**, not npm.
- **Format:** `yarn format` before push; CI runs `yarn format:check` (Prettier) on every PR.
- **Typecheck:** `yarn tsc --noEmit`
- **Tests:** `yarn test` (uses `vitest.config.test.ts` — not bare `vitest run`)

## Migrations (D1 / drizzle-kit)

Do **not** hand-author `migrations/*.sql` or edit `migrations/meta/_journal.json` / snapshots by hand — that desyncs the drizzle-kit journal.

| Change type                                  | Command                                                                         |
| -------------------------------------------- | ------------------------------------------------------------------------------- |
| Schema change in `worker/src/db/*.schema.ts` | `yarn db:generate`                                                              |
| Data-only backfill (no schema change)        | `yarn db:generate -- --custom --name=<slug>` then paste SQL into the empty file |

Plain `yarn db:generate` emits nothing for data-only work ("No schema changes, nothing to migrate"). `--custom` creates a journaled empty migration **and** the matching `meta/NNNN_snapshot.json`; paste `UPDATE`/`INSERT` SQL into the generated `.sql`.

Details: [`migrations/README.md`](./migrations/README.md). Apply with `yarn db:migrate:dev` / `yarn db:migrate:prod`.
