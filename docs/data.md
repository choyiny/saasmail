[saasmail](../README.md) › [Docs](README.md) › **Export, import and backups**

# Export, import and backups

Your mail is yours to take elsewhere, and to bring with you. saasmail exports
an inbox as one mbox file, the format Thunderbird, Apple Mail, Gmail and most
mail servers import, and any single message as an `.eml` file; admins can
[import](#import-mail) an mbox or `.eml` file into an inbox, and keep daily
[backups](#backups) of the whole database that a script restores.

## Export a mailbox

**Settings → Data → Export mailbox.** Pick an inbox you can read, optionally a
date range, and whether to include Trash and campaign sends, then **Export**.
Admins also find an **Export** button (the download icon) on each row of the
Inboxes page, which opens the same form with that inbox chosen.

- **What's in it:** the inbox's received and sent mail, oldest first, in every
  folder (Inbox, Archive, Junk, custom folders). Trash and campaign sends are
  left out unless you tick them: a newsletter to 10,000 people would be 10,000
  near-identical messages. Snoozed mail is included.
- **How each message is written:** exactly as it arrived or was sent when
  saasmail kept the original (received mail since migration 0068, and mail
  sent from a JMAP client). Older received mail and mail sent from the web
  app, the API, MCP, sequences and campaigns is rebuilt from what was stored:
  its headers, text and HTML bodies and attachments. A rebuilt message carries
  `X-Saasmail-Reconstructed: yes`.
- **saasmail's own state** goes in headers other mail programs ignore, so a
  later import into saasmail can restore it:

  | Header                    | Value                                                                                                                                                                               |
  | ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | `X-Saasmail-Labels`       | Like Gmail's `X-Gmail-Labels`: `Inbox`, `Sent`, `Junk` or `Trash` (none for archived mail), then `Starred` and the custom folders, comma-separated (a name with a comma is quoted). |
  | `X-Saasmail-Seen`         | `yes` or `no`, for received mail.                                                                                                                                                   |
  | `X-Saasmail-Person`       | The customer's person id.                                                                                                                                                           |
  | `X-Saasmail-Conversation` | The conversation key snooze and assignment use.                                                                                                                                     |

  Starred and seen are yours, the person who asked for the export.

- **The format** is `mboxrd`: each message starts with a `From <sender> <date>`
  line, line endings are LF, and a body line that starts with `From ` (after
  any number of `>`) gets one more `>`. Readers that understand mboxrd undo
  that quoting.

The export runs in the background, a slice of up to 200 messages at a time, so
any size works. The form's list shows its progress; when it is done you get a
notice in the open app and, if you turned on notifications, a push
notification. **Download** gets the file. It is kept for 7 days, then deleted
(the list then says **Expired**). **Cancel** stops a running export;
**Delete** removes a finished one and its file.

One export of an inbox runs at a time. Only the person who asked for an export
can see and download it, and only while they can still read the inbox. Admins
see and can download every export.

### API

All routes take a session or an `sk_…` API key and follow inbox permissions.

| Route                            | What it does                                                                                                                                                                                 |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/exports`              | `{ inbox, from?, to?, includeTrash?, includeCampaignSends? }` (`from` and `to` are Unix seconds, inclusive). `202` with the export; `403` for an inbox you can't read; `409 EXPORT_RUNNING`. |
| `GET /api/exports`               | Your exports, newest first (the last 50); every export for an admin.                                                                                                                         |
| `GET /api/exports/{id}`          | One export: `status` (`running`, `completed`, `failed`, `expired`), `processedMessages`, `bytes`, `expiresAt`, `error`.                                                                      |
| `GET /api/exports/{id}/download` | The file, `application/mbox`, named `<inbox>-<date>.mbox`. `409 EXPORT_NOT_READY` while it runs, `410 EXPIRED` after 7 days.                                                                 |
| `DELETE /api/exports/{id}`       | Cancels a running export, or deletes a finished one and its file.                                                                                                                            |

Someone else's export answers `404`. Starting, finishing and downloading an
export are recorded in the [audit log](audit-log.md) (`export.started`,
`export.completed`, `export.downloaded`).

### How it runs

The export is an `async_jobs` row (`job_type = 'mail_export'`) worked through
in slices on `EMAIL_QUEUE`, one slice per queue batch. Each slice renders up
to 200 messages (or about 8 MiB, or 20 seconds' worth) and streams them into
one R2 multipart upload in 5 MiB parts, uploading each part as it fills; the
bytes short of a part wait in R2 for the next slice. A slice holds one message
and one part in memory at a time. A slice that fails is retried, three times
in all, and then the export is marked failed and its upload aborted. A
delivery of a slice the export has already passed does nothing, and two
deliveries of the same slice cannot both run, so a queue retry never writes a
message twice.

The hourly cron deletes files older than 7 days, and queues again an export
that has not moved for 15 minutes (its queue message was lost, or a slice
crashed); the fourth time that happens, the export fails. On a `DEMO_MODE`
deployment, which has no queue consumer, the slices run in the background of
the request that started the export, and the hourly cron finishes one that
outlived it.

The file is stored at `exports/<id>/<inbox>.mbox` in the `R2` bucket.

## Download one message

**Download (.eml)** in the reading pane (and **.eml** under a message in a
customer's timeline) saves one message as an RFC 5322 file, the same bytes the
export writes for it, without the `X-Saasmail-*` state headers.
`GET /api/messages/{received|sent}/{id}/raw.eml` does the same over the API;
a rebuilt message also answers with an `X-Saasmail-Reconstructed: yes`
response header.

## Import mail

**Settings → Data → Import mail** (admins). Bring years of mail into an inbox
from an mbox file — Gmail Takeout, Thunderbird (ImportExportTools), Apple
Mail, Fastmail and most providers export one — or a single `.eml`, up to 5 GB.
Pick the file, the inbox it goes into, and which messages to take:

- **Only mail to or from this inbox** (the default): a message whose From is
  the inbox becomes a Sent message; one whose To, Cc, Bcc, `Delivered-To` or
  `X-Original-To` names the inbox becomes received mail; anything else is
  skipped and counted ("not addressed to this inbox").
- **Everything as received**: every message not from the inbox is stored as
  received by it, whoever it was addressed to — for mail exported from an
  address that no longer exists.

The inbox must already exist (a sender identity, or mail). The browser uploads
the file in 32 MiB parts (a part that fails is retried three times; **Cancel
upload** stops it), then the import runs in the background. Progress, the counts and
the first 50 notes (skipped messages, dropped attachments) show in the list;
you get a notice when it is done.

**Imported mail is history.** It is stored the way live mail is (the same code:
threading, conversations, attachments, the original bytes for JMAP and
exports), but it arrives read, counts only in its sender's total (not unread,
and their last activity never moves back in time), and fires no rules,
notifications, webhooks, forwards or suggested replies — an import never
auto-replies to a thousand old messages. It never trains the learning spam
filter. A message's date is its `Date` header, else the mbox separator's date.
In an inbox that [groups by thread](inboxes.md#conversations-by-customer-or-by-thread),
a reply met before the message it answers starts a thread of its own, so when
the import finishes the inbox's mail is walked once more, oldest first, to join
them; JMAP clients then resync once.

**Labels become state.** Gmail's `X-Gmail-Labels` and saasmail's own
`X-Saasmail-Labels` (from an [export](#export-a-mailbox)) are read, but only
from the block of `X-GM-*`, `X-Gmail-*` and `X-Saasmail-*` lines the exporter
puts above a message's own headers: a labels header the original sender wrote
is ignored, so a message cannot file or star itself. `Spam` or
`Junk` → Junk, `Trash` → Trash, no `Inbox` label (and not `Sent`) → archived,
`Starred` → starred for you, and other labels → custom folders of the inbox,
created on first use (untick **Create folders from labels** to skip that).
Gmail's own `Important`, `Opened`, `Unread` and `Category …` labels are
ignored. A message without a labels header lands in the Inbox. Gmail drafts
(the `Draft` label) are skipped: they were never sent. Folder names match
whatever their case. The state changes are recorded in the audit log as yours,
on the `import` channel.

**Duplicates are skipped.** A received message already in the inbox (same
Message-ID) and a sent one already sent from it are counted as skipped, so
importing the same file twice imports nothing new. A message without a
Message-ID is given `<import-<sha-256 of its bytes>@saasmail.local>`, and a
message sent through JMAP (whose row keeps the provider's Message-ID) is found
by its own. Every imported row records its import (`import_job_id`).

**Limits.** Attachments follow live mail's limits (50 per message, 25 MB in
all); the rest are dropped with a note. A message larger than 32 MB is
skipped with a note (Email Routing caps live mail at 25 MB), and so is one
that fails three times in a row: the import goes on with the rest of the file
(after ten such messages it stops as failed). Bodies longer than 250,000 characters are cut in the
database (D1 rows are at most 2 MB); the whole message stays in R2, so its
`.eml` and an export carry it in full. The uploaded file is deleted 24 hours
after the import ends; an upload nobody finished is given up after 24 hours.
Messages already imported stay when you cancel or delete an import.

### Reading an mbox

A message starts at a `From ` line at the start of the file or after an
empty line, followed by a time (`From sender Sat Oct  3 14:02:00 2026`), so an
unquoted body line such as "From here on…" after a blank line does not split a
message. `mboxrd` quoting is undone (`>From ` loses one `>`); CRLF and LF files
both work. A file that does not start with such a line is read as one message
(`.eml`).

### API

Admin only, with a session or an admin's `sk_…` key.

| Route                                                   | What it does                                                                                                                                                          |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/admin/imports`                               | `{ inbox, filename, size, direction?: "strict" \| "all_received", createFoldersFromLabels?: true }` → `201` with the import (`status: "uploading"`, `partsExpected`). |
| `PUT /api/admin/imports/{id}/parts/{n}`                 | The raw bytes of part `n`: exactly 32 MiB, the last part what is left. `400 INVALID_PART_SIZE` otherwise; sending a part again replaces it.                           |
| `POST /api/admin/imports/{id}/complete`                 | Starts the import (`202`); `400 PARTS_MISSING` names parts not uploaded yet. Records `import.started`.                                                                |
| `GET /api/admin/imports`, `GET /api/admin/imports/{id}` | Imports newest first, with `bytesRead`, `processedMessages`, `importedMessages`, `skippedMessages` and `notes`.                                                       |
| `DELETE /api/admin/imports/{id}`                        | Cancels an import or deletes a finished one's record and file.                                                                                                        |

The import runs as an `async_jobs` row (`job_type = 'mail_import'`) in slices
on `EMAIL_QUEUE` (one slice per queue batch, each stopping at 200 messages,
about 450 D1 and R2 calls, or 20 seconds), reading the file from R2 8 MiB at a
time from a byte cursor; a larger message is found by scanning for the next
one and read on its own. A retried slice is safe: a message it already stored
is found, counted once and labelled again. It records
`import.completed` with the counts. The hourly cron queues again an import
that has stopped moving, as for exports.

## Backups

**Settings → Data → Backups** (admins). A daily logical dump of the whole
database into an R2 bucket, and a script that loads it into a fresh
instance. [D1 Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/)
(`wrangler d1 time-travel`) restores the database to any minute of the last
30 days, which covers "we deleted the wrong inbox"; a backup is the copy you
can move to another account or runtime. Both buckets live in the same
Cloudflare account as the database, so a backup only survives losing that
account if you also copy it elsewhere (replicate the `BACKUPS` bucket, or
`rclone` it on a schedule).

### What is in a backup

One file per table, `<table>.ndjson.gz`: each row a JSON line with the
table's column names (blobs as `{"$blob": "<base64>"}`), gzip-compressed (a
file written in steps is several gzip members one after another, which `gunzip`
and every gzip library read as one stream). Every table is in it except
sessions and tokens (`sessions`, `verifications`, `oauth_access_tokens`,
`oauth_refresh_tokens`), the OAuth signing keys (`jwkss`, made again on first
use) and short-lived counters (`auth_rate_limits`, `jmap_changes`,
`send_idempotency`, `send_counters`, `subscribe_attempts`, `backup_runs`).
Password hashes, API key hashes and passkeys' public keys are included.

`manifest.json` lists the files in the order a restore loads them (parents
before the tables that reference them), with each table's rows, columns,
primary key, foreign keys and the SHA-256 of each part of its file, the last
applied migration, and whether the files are encrypted (and with which key);
`manifest.sha256` checks the manifest itself. The hashes catch corruption, not
tampering: anyone who can write to the bucket can rewrite the manifest too, so
protect the bucket (a retention lock, write access for nobody else).

**Not an instant snapshot.** A backup is written table by table over minutes
while mail keeps arriving, so it can hold a row twice (one that was deleted
and written again between pages) or a row whose parent was deleted before its
own table was written. The restore keeps the last copy of a row and leaves
orphans out, with a count. For an exact copy of one instant, use
`wrangler d1 export` (or Time Travel) instead.

**R2 objects are not copied:** attachments, raw messages, newsletter assets,
exports and import files are already in your R2 bucket (the manifest lists
their prefixes). Moving to another account means copying the bucket too, with
[rclone](https://rclone.org/s3/#cloudflare-r2) or the S3 API.

### Where, when and how long

- **Where:** the `BACKUPS` bucket when you bind one (recommended: a bucket of
  its own, ideally with a retention lock or replicated elsewhere), else the
  attachments bucket under `backups/`. Each backup is a prefix:
  `backups/<date>T<time>Z-<id>/`; a run remembers its bucket, so binding
  `BACKUPS` later still prunes the older runs where they are.
- **When:** off until an admin turns it on. Then every day at the first hourly
  tick at or after the chosen hour (UTC, default 3), and whenever you press
  **Back up now**. One runs at a time.
- **How long:** files older than the chosen number of days (default 14) are
  deleted by the hourly cron; the run stays in the list, marked deleted. The
  newest backup that completed is never deleted, however old, so a run of
  failures cannot leave you with none.
- **Encryption:** set `BACKUP_ENCRYPTION_KEY` (64 hex characters) and every
  file is encrypted with AES-256-GCM: a series of frames, each a 4-byte length,
  a fresh 12-byte IV and the ciphertext with its tag, bound to its file and
  position (a frame moved elsewhere does not decrypt). The manifest records
  which key (an HMAC of it, not the key), so the restore says "wrong key"
  rather than failing halfway; a key changed while a backup runs fails that
  backup. Keep the key outside Cloudflare; without it an encrypted backup
  cannot be read.

A backup runs in steps on the queue (about 50,000 rows, 16 MB or 20 seconds
each), reading pages of at most 500 rows or about 4 MB of stored data (the
sizes are read ahead, so a run of message bodies cannot fill a Worker's
memory) and streaming each table into an R2 multipart upload, so a large
database finishes without any one invocation nearing its limits. A failed step is
retried; after three failures the backup is marked failed and its files are
deleted. A run that stops moving is queued again once after two hours and
failed after a day. Starting, finishing and failing are in the
[audit log](audit-log.md) (`backup.started`, `backup.completed`,
`backup.failed`), and turning the schedule on or off as `settings.changed`.

### Restoring

Restoring is a script you run, never a button: loading a dump over a live
database replaces it.

1. Create and migrate the target database (a new instance, or the same one
   after `wrangler d1 time-travel` was not enough):
   `yarn db:migrate:prod`. The target must have at least the backup's last
   migration (`manifest.json` → `lastMigration`); a newer one is fine, and
   columns added since get their defaults.
2. Copy the backup out of the bucket into a local directory, for example
   `rclone copy r2:saasmail-backups/backups/2026-10-04T0300Z-xyz/ ./backup/`,
   or `wrangler r2 object get <bucket>/<prefix><file> --remote --file ./backup/<file>`
   for `manifest.json`, `manifest.sha256` and each table's file.
3. Check the plan without loading anything:

   ```bash
   node scripts/restore-backup.mjs --from ./backup --database saasmail-db --dry-run
   ```

   It verifies the manifest and every file's parts against their hashes,
   decrypts with `--key <hex>` when the backup is encrypted (and refuses
   another key), checks the target's migrations, and prints the tables, row
   counts and warnings (orphans left out, columns the target lacks); the SQL it
   would run is left in a temporary directory. It streams each table, so a
   large backup needs little memory.

4. Load it: the same command without `--dry-run`, then type `yes` (or pass
   `--yes`; without a terminal it refuses rather than guess). Every table in
   the backup is emptied (children first) and loaded (parents first), in files
   of a few megabytes run with `wrangler d1 execute --remote --file`; values
   longer than D1's statement limit are appended in pieces, and a row that
   clashes with another on a unique key other than its primary key is
   skipped. Emptying `users` also deletes sessions and OAuth tokens, so
   everyone signs in again; JMAP clients resync. If a file fails, the script
   names it: fix the cause and run the same command with `--from-file <n>` to
   go on from there.
5. Copy the R2 bucket if you moved accounts, and deploy.

`--tables people,emails` restores only those tables, and differently: their
rows are written over the current ones by primary key, and nothing is
deleted, since emptying one table would cascade into others (D1 cannot turn
foreign keys off). Rows added since the backup stay. `--local` targets the
local development database (`--persist-to <dir>` a scratch one), which is how
to rehearse a restore.

### API

Admin only.

| Route                                  | What it does                                                                                                                      |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/admin/backups`               | The schedule (`enabled`, `hourUtc`, `keepDays`, `nextDue`), `destination` (`BACKUPS` or `R2`), `encryption` and the last 30 runs. |
| `PATCH /api/admin/backups/settings`    | `{ enabled?, hourUtc?, keepDays? }`.                                                                                              |
| `POST /api/admin/backups/run`          | Back up now (`202`); `409 BACKUP_RUNNING`, `400 INVALID_KEY` for a malformed `BACKUP_ENCRYPTION_KEY`.                             |
| `GET /api/admin/backups/{id}/manifest` | A finished backup's manifest. The files themselves are fetched from the bucket, not through the Worker.                           |
