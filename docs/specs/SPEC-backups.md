# SPEC: Scheduled database backups to R2, and a restore script

Stage 11 (data ownership), slice 3 of 3. Depends on `docs/archive/SPEC-audit-log.md` and shares the Data UI with
`SPEC-mail-export.md`. Label `minor`.

## Why

D1 is the system of record and lives in one Cloudflare account. D1 Time Travel restores the database to
any point in the last 30 days (`wrangler d1 time-travel`), which covers "we deleted the wrong inbox",
but not a lost or suspended account, a region incident, or moving to another account or (Stage 8,
one day) another runtime. Mailflare ships scheduled backups with restore. A daily logical dump of every
table into a bucket we choose, plus a script that loads it into a fresh instance, is what makes the data
ours.

Facts to build on: `scheduled()` runs hourly and every job runs on every tick (adding a cron schedule
reruns everything); R2 multipart uploads need ≥ 5 MiB parts except the last; every table is a rowid
table (drizzle never emits `WITHOUT ROWID`), so `rowid` paging works everywhere; attachments, raw
messages, exports and import sources are already R2 objects.

## Decisions (proposed 2026-10-03)

1. **What:** a logical dump of D1, one gzip-compressed NDJSON file per table plus `manifest.json`
   (started/finished, `package.json` version, the last applied migration from `d1_migrations`, per-table
   row count and SHA-256, whether encrypted). Not dumped: `sessions`, `verifications`,
   `oauth_access_tokens`, `oauth_refresh_tokens`, `jwkss` (regenerated on first use), `auth_rate_limits`,
   `jmap_changes`, `send_idempotency`, `send_counters`, `subscribe_attempts`. Dumped: everything else,
   including `accounts` (password hashes), `api_keys` (hashes), `passkeys` (public keys), `spam_*`.
2. **Where:** the optional `BACKUPS` R2 binding (a dedicated bucket, ideally with a retention lock or
   replicated elsewhere by the operator), else the existing `R2` bucket under `backups/`. R2 objects —
   attachments, raw messages — are _not_ copied: they are already in R2, and the manifest records their
   prefixes; moving accounts means copying the bucket with `rclone`/the S3 API (documented).
3. **Encryption:** optional `BACKUP_ENCRYPTION_KEY` (64 hex chars). When set, each file is AES-256-GCM
   encrypted (random 12-byte IV prefixed, WebCrypto) and the manifest says so; the restore script needs
   the key. Default: plaintext in the operator's own bucket.
4. **When:** daily, at the first hourly tick at or after `backup_hour_utc` (setting, default 3), guarded
   by `app_settings.backup_last_started`; "Back up now" from the admin UI; retention `backup_keep_days`
   (default 14) prunes older prefixes.
5. **How:** a `backup_runs` row drives a resumable run that re-enqueues itself on `EMAIL_QUEUE`
   (`backup_step`) until done, so a 2 GB database finishes in minutes of wall time without any single
   invocation nearing the limits. The hourly tick only starts a run or resumes a stuck one.
6. **Restore is a CLI script, never a button.** Loading a dump over a live database is destructive;
   `scripts/restore-backup.mjs` runs on the operator's machine against a target that has already run
   `yarn db:migrate:prod`, and refuses a target older than the backup's migration.

## 1. Schema and settings

**Files:** `worker/src/db/backup-runs.schema.ts`, `schema.ts`, migration, `helpers.ts`,
`worker/src/routers/admin-router.ts` (`/settings`), `worker-configuration.d.ts`,
`wrangler.jsonc.example` (commented `BACKUPS` binding), `.dev.vars.example`.

```
backup_runs (id TEXT PRIMARY KEY, started_at INTEGER NOT NULL, finished_at INTEGER NULL,
             status TEXT NOT NULL /* running | completed | failed */, prefix TEXT NOT NULL,
             progress TEXT NOT NULL /* JSON: { tables: { <name>: { rowid, rows, bytes, uploadId, parts[] } }, done: [] } */,
             bytes INTEGER NOT NULL DEFAULT 0, error TEXT NULL, requested_by TEXT NULL)
```

Settings keys: `backup_enabled` (default `"false"` until an admin turns it on, so an upgraded instance
doesn't silently start writing to its attachments bucket), `backup_hour_utc`, `backup_keep_days`,
`backup_last_started`.

## 2. The run

**Files:** new `worker/src/lib/backup/tables.ts` (the ordered table list and the exclusions, asserted
against `worker/src/db/schema.ts` by a test so a new table can't be forgotten), `dump.ts`,
`crypto.ts`, `run.ts`; `worker/src/lib/queue-router.ts` (`backup_step`); `worker/src/index.ts` (hourly
chain: `maybeStartBackup`, `resumeStuckBackup`, `pruneBackups`).

- `maybeStartBackup`: enabled, no running run, and `now ≥ next due (last_started's day at
backup_hour_utc, + 1 day)` → insert the run (`prefix = backups/<YYYY-MM-DD>T<HHMM>Z-<id>/`), set
  `backup_last_started`, enqueue `backup_step`, emit `backup.started`.
- `backup_step` slice: for the current table, `SELECT rowid, * FROM <table> WHERE rowid > ? ORDER BY
rowid LIMIT 1000` repeatedly; each row → one JSON line (column names as in SQLite; integers, text,
  NULL; blobs base64 with a `$blob` marker); through `CompressionStream("gzip")` (and the cipher when
  configured) into a buffer; at ≥ 5 MiB → `uploadPart`; a table's last part completes its multipart
  upload (`<prefix><table>.ndjson.gz[.enc]`); the slice stops at 20 s or 50,000 rows and re-enqueues
  itself with the progress saved. After the last table: write `manifest.json` (and `manifest.sha256`),
  `status: completed`, `bytes`, `backup.completed` with totals; prune runs whose prefix is older than
  `backup_keep_days` (list by prefix, delete objects in batches, keep `backup_runs` rows for the UI).
- Empty tables still produce a file (zero lines), so a restore truncates them correctly.
- Failure: a slice throw retries through the queue; after `max_retries` the run is `failed` with
  `error`, uploads aborted, `backup.failed`. `resumeStuckBackup`: a running run untouched for 2 h is
  re-enqueued once; untouched for 24 h → failed.
- `POST /api/admin/backups/run` (admin): starts a run now (409 if one is running). `GET /api/admin/backups`
  lists runs with manifest summaries. `GET /api/admin/backups/{id}/manifest`. No download of the dump
  through the Worker (operators fetch from the bucket).

## 3. Restore script

**Files:** `scripts/restore-backup.mjs`, `scripts/restore-backup.test.mjs`, `docs/data.md`.

- `node scripts/restore-backup.mjs --from <local dir or s3://bucket/prefix> --database <d1 name>
[--key <hex>] [--tables a,b] [--dry-run] [--yes]`.
  1. Reads the manifest; verifies every file's SHA-256; decrypts when `--key` is given (refuses an
     encrypted backup without it).
  2. Checks the target's last applied migration (`wrangler d1 execute --remote --command "SELECT name
FROM d1_migrations ORDER BY id DESC LIMIT 1" --json`) is ≥ the manifest's; refuses otherwise with
     the instruction to run `yarn db:migrate:prod` first. Newer targets are allowed: columns added since
     the backup receive their defaults (`INSERT` names the backed-up columns only); the script warns
     about columns the target no longer has and skips them.
  3. Prints the plan (tables, row counts, target) and requires `--yes` (or an interactive `yes`).
  4. For each table in the manifest order: `DELETE FROM <table>;` then `INSERT OR REPLACE` in batches of
     500 rows written to temporary `.sql` files applied with `wrangler d1 execute --remote --file`,
     wrapped so foreign keys don't fire mid-load (`PRAGMA defer_foreign_keys = ON` per batch). Tables
     not in the backup (the excluded ones) are left untouched.
  5. Prints a summary and the reminder that R2 objects were not restored by this script.
- Fetching from S3 uses the AWS SDK only if `s3://` is given; a local directory (from `wrangler r2
object get` or `rclone`) needs no dependency. Pin any new dependency exactly and run `yarn install
--update-checksums`.

## 4. UI

**Files:** Settings → **Data** → Backups card.

- Enable toggle, hour (UTC) and keep-days fields, destination (binding or `R2` bucket prefix, read-only
  from the server), encryption status ("configured" / "not configured — see docs"), last run (status,
  size, duration), "Back up now", the list of runs with their manifests; a note that D1 Time Travel is
  the quick undo and this is the portable copy.

## Tests

- `tables.ts` covers every exported table in `schema.ts` exactly once (included or excluded).
- Dump: a fixture database → one object per table with the right line count, gzip round-trip, blob
  marker, sha in the manifest; a 3-slice run via the queue mock; resume after a thrown slice continues
  from the saved rowid without duplicating lines; encrypted round-trip with `crypto.ts`.
- Scheduling: due/not-due by `backup_hour_utc`; disabled → nothing; retention deletes the oldest prefix
  only; stuck handling.
- Restore script (Node test with a stubbed `wrangler`): verifies hashes, refuses an older target, builds
  the expected SQL batches, honours `--tables` and `--dry-run`.

## Docs and CHANGELOG

- `docs/data.md` (Backups: what is in a backup and what isn't, the bucket choice, encryption, the
  schedule, restore step by step, the R2 copy note, Time Travel), `docs/configuration.md`
  (`BACKUPS` binding, `BACKUP_ENCRYPTION_KEY`), `docs/setup.md` (optional step), `docs/updating.md`.
- CHANGELOG `### Added`: **Scheduled backups to R2 and a restore script.** …
