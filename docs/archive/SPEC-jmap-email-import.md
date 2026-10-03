# SPEC: JMAP `Email/import` so aerc can send (JMAP v1 finish line)

Depends on: SPEC-jmap-live-updates.md being merged (shared files: `methods.ts`, `docs/jmap.md`).

## Why

aerc sends by uploading the finished RFC 5322 message, `Email/import`ing it into Drafts with
`{"$draft": true, "$seen": true}`, then `EmailSubmission/set` with `emailId: "#aerc"` and
`onSuccessUpdateEmail: {"#sub": {"keywords/$draft": null, "mailboxIds/<Sent>": true,
"mailboxIds/<Drafts>": null}}` (aerc `worker/jmap/send.go`). Postponing a draft also imports into Drafts
(`worker/jmap/set.go`). saasmail has no `Email/import`, so every send fails.

aerc keeps one mailbox per role (`w.roles[role]`, filled from a Go map, so effectively random): with two
inboxes it may import a hello@ message into privacy@'s Drafts and patch privacy@'s Sent.

Owner decisions (2026-09-28): Drafts-only import; parse into saasmail's own draft structure (rebuilt
`blobId`, extra headers dropped); refuse signed/encrypted mail; remap cross-inbox Drafts on import and
cross-inbox Sent/Drafts in the on-success update to the message's own inbox (plain `Email/set` stays
strict).

## 1. `Email/import` (RFC 8621 §4.8)

**Files:** new `worker/src/jmap/email-import.ts`; dispatch in `worker/src/jmap/methods.ts` (next to
`Email/set`, same `ifInState`/state handling); `worker/src/lib/email-parser.ts` only if a shared MIME
helper is needed.

- Arguments: `accountId`, `ifInState`, `emails: {creationId: {blobId, mailboxIds, keywords, receivedAt?}}`.
  Response: `{accountId, oldState, newState, created: {creationId: {id, blobId, threadId, size}},
  notCreated: {creationId: SetError}}`. Creation ids are recorded so a later call in the same request can
  use `#creationId` (`emailId: "#aerc"`): copy how `Email/set` create registers creation ids
  (`creation-refs.ts`).
- Arguments are validated before any blob is read or anything is written:
  - `emails` must be an object with 1..`maxObjectsInSet` entries (else `invalidArguments` /
    `requestTooLarge`, as `Email/set` does for `create`); creation ids follow the `Email/set` rules.
  - Each import object may only have `blobId` (string, required), `mailboxIds` (Id[Boolean], required),
    `keywords` (String[Boolean], optional, default `{}`), `receivedAt` (UTCDate, optional). A wrong type,
    unknown property or `null` where not allowed → `invalidProperties` naming the property.
  - `receivedAt`, when valid, becomes the draft's `receivedAt` (RFC 8621 §4.8); invalid → `invalidProperties`
    `["receivedAt"]`.
- Per email:
  1. `blobId` must be readable by the caller (`resolveReadableBlob` in `blobs.ts`: own uploads and the other
     kinds it allows); otherwise `invalidProperties` `["blobId"]` (RFC 8621 §4.8; `blobNotFound` stays an
     `Email/set` attachment error). Larger than the upload limit → `tooLarge`.
  2. **MIME tree check before conversion** (bounded: at most 100 parts and depth 10, else `invalidEmail`):
     walk the raw message's part headers (postal-mime flattens the tree, so read the structure from the
     raw bytes, e.g. a small boundary-aware header scanner in `email-import.ts`). Refuse with
     `invalidEmail` (with a description) when any part, at any depth, is `multipart/signed`,
     `multipart/encrypted`, `application/pkcs7-mime` or `application/pgp-encrypted`, or when the message
     can't be represented without loss: more than one `text/plain` or more than one `text/html` body part
     that isn't an attachment (inline-disposition or no-disposition text parts beyond the first of each
     type). `message/rfc822` parts are kept as attachments with their bytes intact.
  3. Parse with postal-mime, then check the send-relevant limits up front: at most 32 attachments + inline
     parts, total bytes within the attachment limit (`lib/send-limits.ts`, the Session's
     `maxSizeAttachmentsPerEmail`); over → `tooLarge`. Nothing has been stored yet.
  4. Build an `Email/set` create object and run it through the existing path (`parseEmailCreate` then
     `createDraftEmail` in `email-create.ts`), so every draft rule applies unchanged:
     - `from`, `to`, `cc`, `bcc`, `replyTo`: from the headers (names kept);
     - `subject`, `sentAt` (Date header, when valid), `messageId`, `inReplyTo`, `references`;
     - bodies: `textBody`/`htmlBody` values from the parsed text and HTML;
     - attachments and inline parts: passed as **in-memory parts**, not temporary uploads. Extend the
       create path with an internal-only blob source (for example a `Map<syntheticBlobId, {bytes, type}>`
       argument that the blob resolver consults before `resolveReadableBlob`; never reachable from a
       client request), so a rejected import stores nothing. Each keeps `name`, `type`, `cid` and
       `disposition` (inline parts keep `cid`, `disposition: inline`);
     - `keywords`: as given (must include `$draft`; else `forbidden`, below);
     - `mailboxIds`: after the remap below.
     Headers not listed are dropped (documented).
  5. The created draft's `blobId` is saasmail's rebuilt raw message, not the uploaded blob (documented
     deviation; the uploaded blob is left to expire).
- Remap on import: if `mailboxIds` names exactly one system Drafts mailbox and it belongs to a different
  inbox the caller can access than the From identity's inbox, replace it with the From inbox's Drafts
  (custom folders are left as given, so they still have to belong to that inbox). Any other target (Inbox,
  Sent, Archive, Junk, Trash, no Drafts) or `keywords` without `$draft` → `forbidden` with description
  "Email/import only creates drafts". A From that is not one of the caller's identities → whatever
  `createDraftEmail` returns today.

## 2. Remap in the on-success update

**Files:** `worker/src/jmap/submission.ts` (where the per-creation patch from `onSuccessForCreation` in
`on-success.ts` is stored on the submission) — the remap runs when the submission is created and the draft
(and so its inbox) is known.

- For each patch key `mailboxIds/<id>` where `<id>` is a system mailbox (`sent`, `drafts`, `trash`,
  `archive`, `junk`, `inbox`) of another inbox the caller can access, rewrite the key to the same role's
  mailbox of the draft's inbox. If a rewritten key would collide with a key the client also sent for that
  mailbox with a **different** value, leave both keys as the client sent them (no remap for that key), so
  the implicit `Email/set` rejects the patch exactly as it would today. Equal values collapse to one key.
- A whole-object `mailboxIds: {…}` value gets the same per-id rewrite.
- Custom-folder ids and ids of inboxes the caller can't access are left alone (the existing rules reject
  them as today).
- Plain `Email/set` (not the implicit on-success one) is untouched.

## 3. Docs

- `docs/jmap.md`: `Email/import` section (Drafts only, what is kept and dropped, rebuilt blobId,
  signed/encrypted refused, the cross-inbox Drafts remap), the on-success remap, remove `Email/import`
  from the limitations list. `CHANGELOG.md` → `Unreleased` → `Added`.
- `scripts/jmap-send-e2e.mjs`: a new step that uploads a small RFC 5322 message, imports it into Drafts
  and submits it with aerc's exact on-success patch shape, then checks it is in Sent and delivered.

## Patterns to copy

- `Email/set` create end to end: `emailSet` in `email-set.ts` (creation ids, `ifInState`, created shape).
- Blob access: `resolveReadableBlob` / `readBlobBytes` in `blobs.ts`; upload rows: `storeUpload` in
  `upload.ts`.
- Tests: `worker/src/__tests__/jmap-submission-fixtures.ts` (`seedAccount`, `jmapCall`,
  `recordingSender`), `jmap-drafts.test.ts`, `jmap-delayed-send.test.ts`.

## Gotchas

- Worker strict mode is off (casts / nullable `error`, as `on-success.ts` `isMethodError`).
- `yarn typecheck` ratchet 434; Prettier enforced.
- Cloudflare send limits (`lib/send-limits.ts`): 5 MiB, 50 recipients, 32 attachments still apply at
  submission; import must not bypass them.

## Done means

1. `yarn format:check`, `yarn typecheck`, `yarn test`, `yarn test:web` pass.
2. Import of a text+HTML message with one attachment, one inline image and one attached `message/rfc822`
   creates a draft whose `Email/get` shows the same From/To/Cc/Bcc/subject/bodies, the attachments (name,
   type, bytes identical) and the inline part (`cid`); `receivedAt` given → used; the draft is listed in the
   web as a "Mail client" draft.
3. aerc's exact request (import into the *other* inbox's Drafts + submission with the other inbox's
   Sent/Drafts in the patch) sends, and the Email ends up in the From inbox's Sent with `$draft` removed.
   Remap collisions: both key orders and a whole-object `mailboxIds` form; a conflicting pair is left as
   sent and the implicit `Email/set` rejects it.
4. Refusals, each asserting that nothing was written (no draft, no content, no blob rows): unreadable blob
   → `invalidProperties` `["blobId"]`; `multipart/signed` at top level and nested inside
   `multipart/mixed` → `invalidEmail`; `multipart/encrypted` top level and nested → `invalidEmail`; two
   inline `text/plain` parts → `invalidEmail`; 33 attachments or over the size limit → `tooLarge`; Inbox
   target or no `$draft` → `forbidden`; unknown property / wrong types / bad `receivedAt` →
   `invalidProperties`; more than `maxObjectsInSet` → `requestTooLarge`; foreign From → as `Email/set`.
5. `#creationId` from `Email/import` works as `emailId` in `EmailSubmission/set` in the same request.
6. Plain `Email/set` update moving a draft into another inbox's Sent is still refused.
7. Live acceptance (after deploy):
   - `yarn jmap:e2e` with `JMAP_EXPECT_DELIVERY=1` (mandatory for this run) passes including the new import
     step, which asserts the delivered copy's From, To and Cc and that the Email is in `JMAP_FROM`'s Sent.
   - aerc (version recorded with `aerc -v`) with the Snowlan account: compose from hello@snowlan.app to
     privacy@snowlan.app, send; then from privacy@snowlan.app to hello@snowlan.app, send. Each arrives in
     the other inbox with the right From, and each is in its own inbox's Sent (checked with `Email/query`
     `inMailbox` Sent per inbox).
