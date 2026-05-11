# D1 migrations

This directory holds the D1 (SQLite) migration history. Each
`NNNN_*.sql` file is the actual DDL applied to the database; the
`meta/_journal.json` index tells `wrangler d1 migrations apply`
which files to run in what order.

## Apply path

```
yarn db:migrate:dev      # local D1 (.wrangler/state/v3/d1)
yarn db:migrate:prod     # remote D1 — needs a wrangler login
```

Both call `wrangler d1 migrations apply saasmail-db` under the hood.
Migrations execute in `idx` order from `_journal.json`.

## Why `yarn db:generate` (drizzle-kit) currently errors

`drizzle-kit generate` is broken on this repo with:

```
Error: [migrations/meta/0019_snapshot.json,
        migrations/meta/0020_snapshot.json] are pointing to a parent
snapshot: …/0019_snapshot.json/snapshot.json which is a collision.
```

Both `0019_snapshot.json` and `0020_snapshot.json` have an identical
`prevId` *and* `id`, which drizzle-kit refuses to walk. This
predates the v0.5.0 cut — it ships from upstream `choyiny/saasmail`'s
`dev` and isn't something this PR introduced.

Until that collision is repaired upstream, drizzle-kit's generator
isn't part of the workflow on this repo. Migrations from `0021_*`
onward have therefore been **authored manually**:

- The `.sql` file is hand-written and lives alongside the
  drizzle-generated siblings.
- A new entry is appended to `_journal.json` (`idx`, `version: "6"`,
  `when` = the commit's `Date.now()`-style ms timestamp, `tag` =
  the bare filename without extension, `breakpoints: true`).
- No `NNNN_snapshot.json` is added — the generator that produces
  those is the same one that fails on the prevId collision.

The wrangler-applied path (which is what CI and prod actually use)
is unaffected — it reads the `.sql` + `_journal.json` directly.

## If you need `drizzle-kit generate` to work again

Fix the `0019` / `0020` snapshot collision upstream and regenerate
the schema diff from `0020` forward. That's a one-time cleanup;
once `drizzle-kit generate` produces a clean snapshot for `0020`,
new schema changes can go back through the normal generator
workflow.
