# SPEC: Export a mailbox as mbox, and any message as .eml

Stage 11 (data ownership), slice 1 of 3. Depends on `SPEC-audit-log.md`. Label `minor`.

## Why

"You own your data" is a promise we can't keep today: there is no way to get mail out except one JMAP
blob at a time, and only for mail received after migration 0068 or sent through JMAP. Mailflare has
import/export and scheduled backups; Mailroom has neither, and a self-hosted server without an exit is a
trap. mbox is the one format every client and provider imports (Thunderbird's ImportExportTools, Apple
Mail, Gmail Takeout produces it), and RFC 5322 `.eml` is the single-message equivalent.

Facts to build on: received mail since 0068 keeps its exact bytes (`emails.raw_r2_key`); JMAP sends keep
a content tree that `buildRawMessage()` (`worker/src/jmap/raw-message.ts`) turns into bytes; everything
else (older received mail, web/API/MCP/sequence/campaign sends) has headers, text, HTML and attachments
in D1/R2 and must be rebuilt. `async_jobs` + `EMAIL_QUEUE` is the house pattern for long work
(`list_import`, `campaign_fan_out`).

## Decisions (proposed 2026-10-03)

1. Export unit: one inbox, both directions, optional date range, Trash excluded unless asked, campaign
   sends excluded unless asked (a newsletter to 10,000 people is 10,000 near-identical messages). Any
   member with access to the inbox may export it; the file is private to the requester and admins.
2. Format: **mbox with `mboxrd` quoting** (`From ` lines in bodies become `>From `), one `From
<envelope> <asctime>` separator per message, CRLF normalised to LF as mbox readers expect. Per-message
   status is carried in `X-Saasmail-*` headers (folder state, starred, seen-by-count, person id,
   conversation key) so a later import into saasmail can restore it; other clients ignore them.
3. Exact bytes when we have them, a faithful rebuild when we don't: rebuilt messages carry
   `X-Saasmail-Reconstructed: yes`.
4. The export runs as an `async_jobs` row of type `mail_export`, processed in slices on `EMAIL_QUEUE`,
   streamed into one R2 multipart upload; done → realtime + push notification and a download link
   valid 7 days, then the object is reaped.
5. Single-message `.eml` download is synchronous and small: `GET /api/messages/{kind}/{id}/raw.eml`.

## 1. Message rendering

**Files:** new `worker/src/lib/export/render-message.ts` (+ tests), reusing `buildRawMessage`,
`rfc5322Date`, `toCrlf` from `worker/src/jmap/`.

- `renderMessageBytes(db, env, ref): Promise<{ bytes: Uint8Array; exact: boolean; envelopeFrom:
string; date: Date }>`:
  - received with `raw_r2_key` → the R2 object bytes, `exact: true`;
  - sent with `jmap_content_id` → `buildRawMessage` from the content row (already how JMAP serves its
    `blobId`), `exact: true`;
  - otherwise rebuild: headers from the row (`raw_headers` for received: Message-ID, Date, From, To, Cc,
    Reply-To, In-Reply-To, References, Subject, List-_, Auto-Submitted and the authentication headers
    are copied; for sent rows: `From` = `from_address` with the identity's display name, `To`/`Cc`/`Bcc`
    columns, `Date` = `sent_at`, `Message-ID`, `In-Reply-To`), then a `multipart/alternative` of
    `text/plain` + `text/html` (or one part), wrapped in `multipart/mixed` with the row's attachments
    streamed from R2 (`Content-Disposition: attachment; filename_=…`, inline parts with `Content-ID`for`/api/attachments/{id}/inline`references rewritten back to`cid:`). `exact: false`, header
`X-Saasmail-Reconstructed: yes`.
- `envelopeFrom` is the From address; `date` is `received_at` / `sent_at`.

## 2. The job

**Files:** `worker/src/db/async-jobs.schema.ts` (`job_type` enum gains `mail_export`; new nullable
`params TEXT` JSON and `requested_by TEXT`), migration, `helpers.ts`, `worker/src/lib/queue-router.ts`
(`type: "mail_export"`), new `worker/src/lib/export/mail-export.ts`, `worker/src/routers/exports-router.ts`,
`worker/src/index.ts` (reaper in the hourly chain).

- `POST /api/exports { inbox, from?, to?, includeTrash?, includeCampaignSends? }` → checks inbox access,
  refuses a second running export for the same inbox (`409 EXPORT_RUNNING`), inserts the job
  (`status: running`, `params`, `requested_by`, `storage_key: exports/<jobId>/<inbox>.mbox`), creates
  the R2 multipart upload (its `uploadId` kept in `params`), enqueues `{ type: "mail_export", jobId }`,
  emits `export.started`, returns the job.
- Consumer slice (`runMailExportSlice`): resume from `cursor` (the `queryMessages` cursor over the
  inbox, both directions, `order: "asc"`, folder-neutral, with the trash/campaign filters); render up to
  200 messages or until 8 MiB is buffered or 20 s elapsed; append each as `From <envelopeFrom>
<asctime>\n` + mboxrd-quoted bytes + `\n`; when the buffer passes 5 MiB, `uploadPart` (parts are
  numbered in `params`); update `processed_rows`, `cursor`, `params`; re-enqueue itself while there is
  more. Last slice: upload the final part, `completeMultipartUpload`, `status: completed`,
  `total_rows`, byte size in `params`, `export.completed`, notify the requester (realtime + Web Push,
  "Your export of support@… is ready"). Any throw → the queue retries the slice; after `max_retries`
  the job is `failed` with `error_summary` and the multipart upload is aborted.
- `GET /api/exports` (mine, or all for admins), `GET /api/exports/{id}`, `GET /api/exports/{id}/download`
  (requester or admin; streams the R2 object with `Content-Type: application/mbox` and
  `Content-Disposition: attachment; filename="support@example.com-2026-10-03.mbox"`; emits
  `export.downloaded`), `DELETE /api/exports/{id}` (cancel or delete: aborts the upload / deletes the
  object).
- Reaper: completed exports older than 7 days → delete the object, `status: expired` (enum gains
  `expired`); running jobs untouched for 24 h → `failed`.

## 3. Single message

**Files:** `worker/src/routers/messages-router.ts`, `src/components/mail/MailReadingPane.tsx`.

- `GET /api/messages/{kind}/{id}/raw.eml`: access check, `renderMessageBytes`, `message/rfc822`,
  `Content-Disposition: attachment`, `X-Saasmail-Reconstructed` when rebuilt. Shown as "Download
  (.eml)" in the reading pane menu (the customer view's message menu too).

## 4. UI

**Files:** `src/pages/SettingsPage.tsx` → a new **Data** section (or `src/pages/DataPage.tsx` at
`/settings/data` if Settings gets long), `src/pages/InboxesPage.tsx`, `src/lib/api.ts`.

- "Export mailbox…" per inbox (Inboxes page for admins; Settings → Data for members, listing their
  inboxes): dialog with date range, "include Trash", "include campaign sends"; then the Exports list
  with status, progress (`processed_rows`), size, Download, Delete. The list polls while a job runs.

## Tests

- Renderer: exact bytes for a raw received row; `buildRawMessage` path for a JMAP send; a rebuilt web
  send has the right headers, both bodies, an attachment part and the `Reconstructed` header; `cid:`
  rewrite round-trips; mboxrd quoting of a body line starting with `From `.
- Job: a 3-slice export over 450 messages produces one object whose message count matches; cursor
  resume after a simulated slice failure doesn't duplicate; trash/campaign filters; the 409; download
  permissions (another member of the inbox gets 404, an admin 200); reaper.
- Route: `.eml` for both kinds; access.
- e2e: request an export of the seeded inbox, poll to completed, download a non-empty file.

## Docs and CHANGELOG

- New `docs/data.md` ("Export, import and backups" — the other two Stage 11 specs add their sections),
  linked from `docs/README.md`; `docs/mailbox-state.md` (the `.eml` download).
- CHANGELOG `### Added`: **Export a mailbox as mbox; download any message as .eml.** …
