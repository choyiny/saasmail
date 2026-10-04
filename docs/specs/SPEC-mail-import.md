# SPEC: Import mail from mbox and .eml

Stage 11 (data ownership), slice 2 of 3. Depends on `SPEC-mail-export.md` (shares the Data UI, the
`async_jobs` columns and `docs/data.md`) and `docs/archive/SPEC-audit-log.md`. Label `minor`.

## Why

Moving a team onto saasmail means leaving years of mail behind, or keeping the old provider around to
search it. Every mail provider exports mbox (Gmail Takeout, Fastmail, Thunderbird, Apple Mail); importing
it is how the customer timeline becomes complete on day one. JMAP `Email/import` (#65) only creates
drafts by design and is one message per call. Mailflare lists import among its features.

Facts to build on: the inbound handler's storage code (people upsert, attachments to R2, CID rewriting,
conversation id, raw blob, `emails` insert) is inline in `handleEmail`; extracting it is the first step.
`list_import` already does "upload to R2, parse in resumable slices on the queue, report progress".
`emails` is unique on `(message_id, recipient)`.

## Decisions (proposed 2026-10-03)

1. Admin-only. The admin picks the **target inbox** and a **direction rule**:
   - `strict` (default): a message whose From is the target inbox becomes a **sent** row; one whose
     To/Cc/Bcc/`Delivered-To`/`X-Original-To` includes the target becomes a **received** row; anything
     else is skipped and counted ("not addressed to this inbox").
   - `all_received`: every message not from the inbox is stored as received by the target inbox,
     whatever its headers said (for mail exported from an address that no longer exists).
2. Imported mail is history: `is_read = 1`, no `unread_count` bump (only `total_count`), no
   notifications, webhooks, forwarding, suggested replies or **rules** (an import must never
   auto-reply to a thousand old messages). `received_at` is the `Date` header, else the mbox separator
   date, else now. The same storage helper the live handler uses, so threading headers, raw bytes,
   attachments and conversation ids are identical to live mail.
3. Gmail's `X-Gmail-Labels` and our own `X-Saasmail-*` export headers map to state: `Spam`/`Junk` →
   junk, `Trash` → trash, no `Inbox` label and not `Sent` → archived, `Starred` → starred for the
   importer, other labels → custom folders of the target inbox, created on demand (opt-in checkbox
   "Create folders from labels", default on). Everything else: Inbox, unseen by no one (`is_read = 1`).
4. Dedupe by Message-ID per inbox for received (the unique index) and per `from_address` for sent;
   duplicates are counted as skipped. A message without a Message-ID gets a synthetic one
   (`<import-<sha256 of bytes>@saasmail.local>`) so re-running the same file is idempotent.
5. Upload goes straight to R2 through a multipart upload driven by the browser in 32 MiB parts
   (Workers bodies are capped at 100 MB on the paid plan); up to 5 GB per file; `.eml` and `.mbox`
   (also `.mbx`, no extension). Processing runs in resumable slices on `EMAIL_QUEUE`; the source object
   is deleted 24 h after completion.
6. Attachment limits are the live handler's (50 per message, 25 MB total); oversize attachments are
   dropped with a per-message note in `error_summary` (first 50).

## 1. Extract the storage helper

**Files:** new `worker/src/lib/inbound/store-received.ts`, `store-sent.ts`;
`worker/src/email-handler.ts` (calls the helper, unchanged behaviour), tests (the existing handler
tests must pass unchanged).

- `storeReceivedMessage(db, env, { parsed, inbox, receivedAt, now, source: "inbound" | "import",
importOptions? })` → `{ emailId, personId, conversationId, autoFiledSpam? }`. Contains the people
  upsert (with `source: "import"` → `total_count + 1` only, `is_read = 1`), the attachment loop and CID
  rewrite, `identityRows`/domains/`computeConversationId`, the raw blob write (`inbound-raw/<id>.eml`
  for both sources), the `emails` insert (including `reply_to` from SPEC-reply-to and
  `spam_probability` only for `inbound`). The D14 threshold stays in the handler (live mail only).
- `storeSentMessage(db, env, { parsed, inbox, sentAt, now })` → inserts a `sent_emails` row
  (`status: "sent"`, `person_id` from the first To address's person, created if missing without count
  bumps, `message_id`, `in_reply_to`, `cc`, `additional_to`, `bcc` from headers, `conversation_id`) and
  its attachments (`kind: "sent"`). No outbox row, no provider.

## 2. Upload and job

**Files:** `worker/src/routers/imports-router.ts`, `worker/src/db/async-jobs.schema.ts` (`job_type`
gains `mail_import`), `worker/src/lib/queue-router.ts` (`type: "mail_import"`), new
`worker/src/lib/import/mbox-reader.ts`, `mail-import.ts`, migration, `helpers.ts`.

- `POST /api/admin/imports { inbox, filename, size, direction, createFoldersFromLabels }` → job row
  (`status: "uploading"` — enum gains `uploading`), `storage_key: imports/<jobId>/source`,
  `createMultipartUpload`; returns `{ jobId, uploadId }`.
  `PUT /api/admin/imports/{jobId}/parts/{n}` (body = part bytes, ≤ 32 MiB; `uploadPart`, etag kept in
  `params.parts`) · `POST /api/admin/imports/{jobId}/complete` → `completeMultipartUpload`, `status:
running`, enqueue, `import.started` · `DELETE /api/admin/imports/{jobId}` → abort/cancel/delete.
- `mbox-reader.ts` (pure, tested): `readMessages(range: Uint8Array, startOffset, isFinal)` → complete
  messages found in the window (`From ` at line start after an empty line or at offset 0 starts a
  message; `mboxrd` unquoting of `>From `; CRLF/LF tolerant), each with its byte range and separator
  date, plus `nextOffset` of the first incomplete message. An `.eml` file is one message at offset 0.
- Slice (`runMailImportSlice`): `R2.get(storage_key, { range: { offset: cursor, length: 8 MiB } })`;
  a message longer than the window extends the read up to 64 MiB (beyond that it is skipped with a
  note); for each message: postal-mime parse (reuse `parseEmail`'s normalisation by giving it a
  raw-bytes entry point `parseRawEmail(bytes)`), direction rule → `storeReceivedMessage` /
  `storeSentMessage` / skip, labels → state via `setMailboxState`/`setUserState`/`setMailboxMembership`
  as the importing admin (user id recorded, so SPEC-spam-learning's "human" rule must exclude actor
  channel `import`: the import runs in an audit context `{ channel: "import", actorType: "user" }` and
  `trainMessage` ignores that channel); update `processed_rows`, `imported_count`, `skipped_count`,
  `cursor` (byte offset), `error_summary`; stop the slice at 200 messages or 20 s; re-enqueue while
  `cursor < size`. Done → `completed`, `import.completed` (counts in `details`), realtime + push to the
  admin; the source object is reaped after 24 h by the hourly chain.
- Realtime: imported mail must not trigger per-message fan-out; the slice sends one `mail_refresh`
  event (introduced by SPEC-ai-folders) per inbox at its end.

## 3. UI

**Files:** Settings → **Data** (from SPEC-mail-export) or `src/pages/InboxesPage.tsx`, `src/lib/api.ts`,
new `src/components/data/ImportDialog.tsx`.

- "Import mail…": file picker (`.mbox`, `.eml`, any file ≤ 5 GB), target inbox, direction rule with the
  two sentences above, "Create folders from labels"; the browser slices the file with `Blob.slice` and
  PUTs parts sequentially with a progress bar (resumable within the session: a failed part is retried
  3 times), then completes. The Imports list shows status, processed/imported/skipped, errors (first
  50), Cancel/Delete.

## Tests

- `mbox-reader`: Gmail Takeout sample, Thunderbird sample, a body line `From ` quoted `>From `, CRLF
  file, a message spanning two windows, an `.eml`.
- Helpers: `storeReceivedMessage(source: "import")` writes the same rows as the live handler except
  `is_read` and counts; `storeSentMessage` rows; attachments; synthetic Message-ID; dedupe on
  re-import (second run imports 0).
- Job: direction rules (strict skips, all_received stores); labels → archived/junk/trash/starred/
  folders created once; two slices resume at the byte cursor; no notifications, rules or webhooks fired
  (spy on the queue, hub and webhook dispatcher); the import never trains the spam filter; cancel.
- Routes: admin-only; part size cap; complete without all parts → 400.
- e2e: import a 3-message fixture mbox into the seeded inbox; the messages appear in Mail; a second
  import imports 0.

## Docs and CHANGELOG

- `docs/data.md` (Import section: formats, direction rules, what imported mail does and doesn't do,
  label mapping, limits), `docs/architecture.md` (the storage helper), `AGENTS.md` ("inbound storage
  lives in `lib/inbound/`; the handler and the importer both call it").
- CHANGELOG `### Added`: **Import mail from mbox and .eml.** …
