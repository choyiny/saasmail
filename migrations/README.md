# D1 migrations

This directory holds the D1 (SQLite) migration history. Each
`NNNN_*.sql` file is the actual DDL applied to the database; the
`meta/_journal.json` index tells `wrangler d1 migrations apply`
which files to run in what order, and `meta/NNNN_snapshot.json` is
drizzle-kit's snapshot of the schema at that point (used to diff the
next change).

## Generating a migration

The normal drizzle-kit workflow. **Do not hand-write migration SQL or
journal/snapshot entries** — let the generator produce the files so the
snapshot chain stays consistent.

### Schema changes

```
# 1. edit the schema in worker/src/db/*.schema.ts
#    (for auth tables: change better-auth config + yarn auth:generate)
yarn db:generate         # diffs schema against the latest snapshot ->
                         # migrations/NNNN_*.sql + NNNN_snapshot.json + journal entry
# 2. review the generated .sql (watch for unintended DROP / rename-as-drop)
yarn db:migrate:dev      # apply to local D1
```

`yarn db:generate` reads its config from `drizzle.config.ts`, whose
dev branch resolves the local D1 file under `.wrangler/`. If you
haven't started the dev server yet it errors with
`D1 directory not found … Run 'wrangler dev' first` — run the dev
server once (or the e2e setup) so the local D1 exists, then generate.

### Data-only migrations (no schema change)

Plain `yarn db:generate` diffs the schema and emits nothing when only
data needs updating ("No schema changes, nothing to migrate"). For a
one-shot backfill / `UPDATE` migration, generate a custom empty file
through the CLI, then paste the SQL:

```
yarn db:generate --custom --name=mark_blocked_senders_read
# -> migrations/NNNN_mark_blocked_senders_read.sql (empty)
# -> migrations/meta/NNNN_snapshot.json + journal entry
# edit the .sql with your UPDATE/INSERT statements
yarn db:migrate:dev
```

Do not invent `NNNN_*.sql` + a `_journal.json` row by hand — that
skips the snapshot and breaks later `drizzle-kit generate` runs.

## Apply path

```
yarn db:migrate:dev      # local D1 (.wrangler/state/v3/d1)
yarn db:migrate:prod     # remote D1 — needs a wrangler login
```

Both call `wrangler d1 migrations apply saasmail-db` under the hood.
Migrations execute in `idx` order from `_journal.json`.

## History: the snapshot collision (resolved)

`drizzle-kit generate` used to error on this repo because
`0019_snapshot.json` and `0020_snapshot.json` shared an identical
`id`, which the generator refuses to walk. During that window
migrations `0021`–`0024` were hand-authored without snapshots.

Both problems were repaired in `42c8072` ("reconcile drizzle meta
snapshots with migrations 0021–0024"): the `0020` snapshot id was
made distinct and snapshots were backfilled for the hand-authored
migrations. **The generator has worked since** — the normal
`yarn db:generate` workflow above is the one to use. (`0030` is the
only migration still missing a snapshot; it sits behind the latest
snapshot `0031`, so it doesn't affect forward generation. If you want
it fully clean, regenerate that one snapshot — it's not required for
day-to-day work.)
