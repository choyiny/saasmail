# SPEC: Export a mailbox as mbox, and any message as .eml

Stage 11 (data ownership), slice 1 of 3. Depends on `docs/archive/SPEC-audit-log.md`. Label `minor`.

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

## Spec changes (made while building it)

The five decisions stand. What the code does differently from the sections above, and why:

1. **JMAP sends** are read from `jmap_message_content.raw_r2_key`, the message `buildRawMessage` already
   wrote when the content was created (and what JMAP serves as its `blobId`), rather than rebuilt again.
   Same bytes, no second rendering.
2. **State headers.** `X-Saasmail-Labels` carries the state Gmail-style (`Inbox` / `Sent` / `Junk` /
   `Trash`, none for archived mail, then `Starred` and the custom folders), because that is what
   `SPEC-mail-import.md` decision 3 reads back; plus `X-Saasmail-Seen` (received mail), `-Person` and
   `-Conversation`. Starred and seen are the requester's. **No seen-by count:** counting readers per
   message means scanning `message_user_state` (its key starts with the user), and an import has
   nothing to restore it to.
3. **Rebuilt received mail** takes its addresses (Reply-To included), subject, Message-ID and threading
   headers from the stored columns, folded with the JMAP renderer's encoders, and copies only `List-*`, `Auto-Submitted`, `Authentication-Results`,
   `Received-SPF`, `DKIM-Signature` and `X-Spam-Score` from `raw_headers`.
4. **Slices are safe to run twice.** The queue message carries the slice number (`{ type:
"mail_export", jobId, slice }`), and a delivery for a slice the job has passed does nothing; a slice
   is claimed with a two-minute lease, so two deliveries of one slice cannot both run (the second is
   retried after the lease, and then finds the slice done); MIME boundaries are derived from the message
   id, so a retried slice re-uploads identical parts. A slice checks its limits after each message and
   resumes from that message's cursor; it runs one per queue batch (others in the batch go back on the
   queue), and the raw keys and stored headers of a page are read in two statements, not per message.
5. **Parts are exactly 5 MiB** (R2 wants every part but the last to be the same size); the bytes short of
   a part are carried to the next slice in an R2 object. Parts are uploaded as they fill, so a slice
   holds one part and one message; `mboxEntry` is sized exactly and rebuilt attachments are base64'd as
   bytes, so a 25 MB message stays inside the Worker's memory. An export smaller than one part is written with
   a single put and its multipart upload aborted. Completion is its own step (the last slice's message),
   so a retry after `complete` only marks the job done.
6. **Failure and recovery:** the consumer marks the export `failed` (and aborts the upload) on the
   third failed attempt of a slice. Instead of failing running exports untouched for 24 h, the hourly
   reaper queues again an export idle for 15 minutes whose claim has run out (a crashed slice, a lost
   queue message), up to three times, and then fails it; failing, expiring or deleting an export
   deletes everything under its R2 prefix. A `POST` whose queue send fails deletes the export.
7. **`DEMO_MODE`** has no queue consumer: the slices run in the background (`waitUntil`) of the request
   that started the export, and the reaper runs a stalled one inline.
8. **One running export per inbox** is enforced by the insert itself (`INSERT … WHERE NOT EXISTS`), so
   two requests at once cannot both start one.
9. **Download access:** the requester only while they can still read the inbox (losing the inbox loses
   the file); `409 EXPORT_NOT_READY` while it runs and `410 EXPIRED` after the reaper. `POST` answers
   `403` for an inbox the caller cannot read and `400` for a reversed range.
10. **Notification:** a new `export_ready` realtime event on the notifications hub, which also sends the
    Web Push (the hub's push sender was split out of the new-mail path for it). The app shows a toast
    that opens Settings → Data.
11. **UI:** one form in **Settings → Data** for everyone (admins see every inbox there), inline rather
    than in a dialog; the Inboxes page has a per-row **Export** link that opens it with the inbox chosen,
    instead of its own dialog. The customer timeline has no per-message menu, so its **.eml** is a link
    beside **Reply**.
