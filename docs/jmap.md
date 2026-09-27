[saasmail](../README.md) › [Docs](README.md) › **JMAP**

# JMAP mail access

saasmail exposes a bounded subset of [JMAP Core (RFC 8620)](https://www.rfc-editor.org/rfc/rfc8620) and [JMAP Mail (RFC 8621)](https://www.rfc-editor.org/rfc/rfc8621). It is intended for mail clients and integrations that need standards-based mailbox reads plus safe message-state updates without a second copy of mail or a second permission model.

## Endpoints

- `GET /.well-known/jmap` — authenticated JMAP Session resource.
- `POST /jmap/api` — JMAP method calls.
- `POST /jmap/upload/{accountId}/` — blob upload (RFC 8620 §6.1). Returns `201` with `{ accountId, blobId, type, size }`.
- `GET /jmap/download/{accountId}/{blobId}/{name}?type={type}` — blob download. The response uses `name` as the filename and `type` as the `Content-Type` (RFC 8620 §6.2), always with `Content-Disposition: attachment` and `X-Content-Type-Options: nosniff`.

Authenticate with the same credentials as the HTTP API: either a signed-in session cookie or `Authorization: Bearer sk_...`. Session-cookie callers have the same passkey-registration gate as `/api/*`; API keys retain their normal issuance-time passkey guarantee. Every object is scoped through the caller's allowed inboxes. Objects outside that scope are reported as not found rather than disclosed.

Method names are case-sensitive in the JMAP `methodCalls` array, and a method that is not implemented for the account answers `unknownMethod` rather than acting partially.

There is one JMAP account per saasmail user. Its account id is a derived, opaque value (not the user id) and it is advertised as personal and writable. JMAP writes are deliberately limited to Email state, drafts and sending: destroying received or sent messages and mailbox administration remain unsupported.

## Ids and account (breaking in this release)

Every id the JMAP layer emits — account, mailbox, Email, thread, identity and blob — is now a valid RFC 8620 `Id`: 1–255 octets drawn from `A-Za-z0-9-_`. Previously mailbox and identity ids embedded the inbox address verbatim, which both violated the character set and overflowed the length limit for a maximum-length (254-character) inbox address.

The **account id changed** as a result. RFC 8620 §1.6.2 requires that a server which reallocates ids be treated as though the account were deleted and recreated with a new id, so connected clients must drop their cached ids, states and blobs and refetch from `/.well-known/jmap` before making further calls. Passing the previous account id to any method returns `accountNotFound`, and the download route returns 404 for it.

State strings moved with the ids: they are now `j2-<seq>-<issuedAt>-<fp>`. A client that still holds a `j1-` state gets `cannotCalculateChanges` from `Email/changes` or `Mailbox/changes`, and `stateMismatch` from `Email/set`'s `ifInState` — never a partial change set computed against ids the server no longer emits.

The web UI, the HTTP API and MCP are unaffected: the internal `received:<id>` / `sent:<id>` message references they use are unchanged, and only the JMAP boundary encodes and decodes.

Body-part blob ids come in two shapes: `P<email id>_text` / `P<email id>_html` for received and sent mail, and `P<draft id>_<part id>` for a draft's own parts. Both are downloadable; see "Uploads and blobs" and "Drafts".

## Uploads and blobs

Uploads accept any content, including an empty body, up to the Session's `maxSizeUpload`. That value is the configured provider's attachment limit, and the same value is advertised as `maxSizeAttachmentsPerEmail`. A larger body gets `413` with a problem body whose `maxSize` is the limit. The server counts the octets it reads, so a missing or wrong `Content-Length` doesn't help. A request for another account gets `403`. A browser session (cookie) upload must carry an `Origin` from the deployment's trusted origins, or it gets `403`. API-key uploads don't need one.

An uploaded blob (`U…`) is readable only by the user who uploaded it and is deleted after 24 hours. Use it in a draft before then; a draft copies the bytes it keeps, so it still resolves after the upload is reaped. Attachment blobs (`A…`) follow the inbox permissions of their message. Raw-message blobs (`X…`) and body-part blobs (`P…`) are the draft's own content, and are readable by the draft's author while the draft exists.

Creation references work across calls in one request: a later call may use `#creationId` in `ids`, `destroy` and `update` keys to name a record created earlier, and one `Email/set` may reference a draft it creates in the same call. `createdIds` is accepted on the request and echoed on the response, per RFC 8620 §3.3.

## Supported methods

The server advertises `urn:ietf:params:jmap:core`, `urn:ietf:params:jmap:mail` and `urn:ietf:params:jmap:submission` and supports:

- `Core/echo`
- `Mailbox/get`, `Mailbox/query`
- `Email/get`, `Email/query`, `Email/set`, `Email/changes`
- `Thread/get`
- `Identity/get`, `Identity/set`
- `Mailbox/changes`
- `EmailSubmission/set`, `EmailSubmission/get`, `EmailSubmission/query`, `EmailSubmission/changes`

The submission methods and `Identity/set` answer `unknownMethod` unless `urn:ietf:params:jmap:submission` is listed in `using`. `Identity/get` keeps working with `urn:ietf:params:jmap:mail` alone.

`Email/set` creates drafts, and updates and destroys them, alongside today's updates to received and sent mail. It can change `$seen`/`$flagged`, move received mail among Inbox/Archive/Junk/Trash, move sent mail between Sent/Trash, add/remove custom-folder membership, and move a draft between that identity's Drafts and Trash. Destroying received or sent mail is still `forbidden`; only drafts are destroyable. `Thread/changes`, `Identity/changes`, and every `*/queryChanges` continue to return `cannotCalculateChanges`.

Mailbox objects are a view over the existing mailbox-state model. Each allowed inbox gets virtual Inbox, Drafts, Sent, Archive, Junk, and Trash mailboxes whose ids are derived values, not the inbox address. Custom folders from the `mailboxes` table get ids derived from the folder row. `mayReadItems`, `mayAddItems`, `mayRemoveItems`, `maySetSeen`, and `maySetKeywords` are true for system and custom mailboxes, Drafts included; its counts are the caller's own drafts. Mailbox create/rename/delete and submission rights remain false.

Email ids are derived from the underlying saasmail message reference and are not the internal `received:<id>` / `sent:<id>` strings the HTTP API uses; a draft's id is a separate `D…` family. `Email/get` exposes addresses, subject, dates, preview, seen/flagged keywords, mailbox membership, text/HTML body structure and optional body values, plus attachment blob ids. `Email/query` supports `inMailbox`, `text`, `from`, `after`, `before`, `hasKeyword`, and `notKeyword` for `$seen`/`$flagged`/`$draft`; for a draft, `text` matches its subject or body as a substring. Drafts and received/sent mail are merged into one `receivedAt`-descending result, so `position`, `limit` and `total` count both. The only supported sort is `receivedAt` descending. Thread ids are derived from the conversation keys the unified message service uses.

Attachment blob downloads reuse the same permission-checked attachment lookup as `GET /api/attachments/{id}`.

## Drafts

A JMAP client composes by creating a draft with `Email/set`, then reading, editing, trashing or destroying it like any other Email. A draft's id is a `D…` value, and its content is stored separately from its mutable state so the same immutable content can later back a sent Email.

**Creating.** A draft needs exactly one `from` that is one of your usable identities, `mailboxIds` naming exactly that identity's Drafts mailbox, and the `$draft` keyword. `$seen` and `$flagged` may be set at creation. The server fills in `messageId` (`<random>@<identity domain>`), `sentAt` and `receivedAt` when you omit them, and keeps any values you do supply.

Both body forms are accepted (RFC 8621 §4.6): the flattened `textBody` / `htmlBody` / `attachments` plus `bodyValues`, or a `bodyStructure` in one of these shapes:

- `text/plain` or `text/html`
- `multipart/alternative(text, html)`
- `multipart/related(html, inline blobs…)`
- `multipart/mixed(<one of the above>, attachments…)`

`headers` is never accepted, on the Email or on any part, and neither is any `header:*` property.

**Attachments.** Every attachment `blobId` is resolved when the draft is created; a missing or unreadable one is reported as `blobNotFound` with _every_ missing id listed, and nothing is stored. The bytes are then copied into the draft's own storage, so the draft keeps its attachments after the upload expires, and an attachment copied from an existing message survives that message's deletion. The total attachment size is capped at `maxSizeAttachmentsPerEmail`; over it, the draft is refused with `tooLarge`.

**The create response** gives the new draft's `id` (`D…`), `blobId` (`X…`, its raw RFC 5322 message), `threadId` and `size`. The `X…` blob downloads the whole message; each part has a `P…` blob (`P<draft id>_<part id>`) holding that part's bytes.

**Rules for updates and destroys.**

| Kind           | Mailboxes                                                     | Keywords            | Destroy     |
| -------------- | ------------------------------------------------------------- | ------------------- | ----------- |
| Received Email | Inbox / Archive / Junk / Trash, plus custom folders           | `$seen`, `$flagged` | `forbidden` |
| Sent Email     | Sent / Trash                                                  | must keep `$seen`   | `forbidden` |
| Draft          | exactly one of that identity's Drafts / Trash; never a folder | must keep `$draft`  | allowed     |

Anything else fails with `invalidProperties` and changes nothing.

**Threads.** A reply that names a message you can see — through `inReplyTo` or `references` — joins that message's thread. Any other draft takes the thread its sent message will naturally land in (the conversation of its external recipients, or the person thread for a single recipient), and failing that starts a thread of its own (`Td…`). Thread ids are immutable per Email, so a draft's `threadId` is fixed at creation.

**Visibility.** Drafts are private to their author. Another member of the same inbox never sees a draft — not in `Email/get`, `Email/query`, `Thread/get`, `Email/changes`, the Drafts or Trash counts, or an `X…`/`P…` download.

## Sending (EmailSubmission)

Clients that list `urn:ietf:params:jmap:submission` in `using` can send a saved draft with `EmailSubmission/set` (create), and read submissions with `EmailSubmission/get`, `/query` and `/changes`. `EmailSubmission/queryChanges` returns `cannotCalculateChanges`. `Identity/set` exists but is read-only: creates are `forbidden`, and updates and destroys are `notFound` for unknown ids and `forbidden` for known ones.

- **Transactional 1:1 sends, like the web composer.** Exactly one To plus up to 50 Cc (51 recipients); no Bcc; no suppression filtering; no unsubscribe footer or `List-Unsubscribe` header.
- **Exact content.** The message carries the draft's From name, To and Cc display names, subject (no "Re:" rewriting), `Message-ID`, `In-Reply-To`, `References`, `Reply-To` and every attached or inline part (inline parts keep their `cid`). The text body is the draft's `text/plain` body parts and the HTML body its `text/html` ones, so a text-only draft goes out without an HTML part and an HTML-only draft without a text part. The Cloudflare provider also keeps the draft's `Date`. Postmark, Resend and Bavimail stamp their own `Date`, and Bavimail can't carry a `Content-ID`.
- **What can't be sent.** `Reply-To` goes out as one bare address (every provider takes a single one), so a draft with two or more is refused with `invalidEmail` (`replyTo`). A text part that is neither body (for example a `text/plain` attachment given as a `partId`) is refused with `invalidEmail` (`bodyStructure`); upload it as a blob instead. If one create in a call fails unexpectedly, it gets `serverFail` and the others are still reported.
- **Envelope.** If given, `mailFrom` must be the identity's address and `rcptTo` must equal To ∪ Cc. SMTP parameters aren't supported.
- **Size.** `tooLarge.maxSize` is the provider's whole-message cap: Cloudflare 5 MiB (to unverified recipients), Postmark 10 MB, Resend 40 MB.
- **Errors.** Every RFC 8621 §7.5 SetError applies. A provider's permanent rejection returns `forbiddenToSend` with its message, and no Sent Email is created. A temporary failure is accepted: the outbox retries it, and the draft can't be submitted again until the outbox gives up.
- **The Sent copy** appears in the Sent mailbox as its own Email, with the draft's immutable properties (`blobId`, `size`, `threadId`, addresses, bodies…) and `receivedAt` equal to the send time.

A submission is claimed atomically, so two concurrent `EmailSubmission/set` calls for the same draft make exactly one provider call: one gets `created`, the other `forbiddenToSend`. The claim is released again after a terminal failure or when the outbox finally gives up, so the draft can be submitted once more.

Not yet supported:

- `onSuccessUpdateEmail`/`onSuccessDestroyEmail` return `invalidArguments`. After sending, clients move or destroy the draft with their own `Email/set`.
- A retry of a temporarily failed send uses the inbox's current display name and drops the To display name.
- If the server stops between claiming a draft and recording the send, that draft reports "already being sent" until recovery ships.
- Mailbox thread counts group JMAP-sent mail by conversation, not by its JMAP `threadId`.

## State and changes

Mailbox/get, Email/get, Thread/get, and Email/set use change-log state strings of the form `j2-<seq>-<issuedAt>-<fp>`. `issuedAt` is the start of the current UTC day, so repeated reads of unchanged data keep the same state throughout the day; Email/set's `ifInState` compares the parsed sequence and permission fingerprint, not the issuance timestamp. Change rows are scoped by the caller's allowed inboxes and, for personal seen/flagged state, by user. States older than the supported window are rejected with `cannotCalculateChanges`; change-log rows are retained for 30 days and pruned in bounded batches by the existing scheduled maintenance chain.

Email/changes coalesces repeated activity for an Email into created/updated/destroyed ids and supports paging through an intermediate state. Mailbox/changes also reports mailbox count changes caused by Email activity. Because mailbox counts are small, saasmail does not page Mailbox/changes: if the result would exceed `maxChanges`, it returns `cannotCalculateChanges` instead. EmailSubmission/changes reports the same three sets for `E…` submission ids; it shares the Email/Mailbox change-log state, and claiming or releasing a draft's submission lock writes no Email change row.

Snooze is intentionally invisible to JMAP. A snoozed conversation remains in its normal JMAP system mailbox (normally Inbox), is returned by matching Email/query calls, and contributes to mailbox counts. Snooze-only changes therefore do not advance JMAP Email or Mailbox state.

## Pointing a client at saasmail

Use the deployment origin as the JMAP host. A client that supports automatic JMAP discovery should request:

```text
https://your-domain.example/.well-known/jmap
```

For clients that ask for endpoints manually, use `https://your-domain.example/jmap/api` for the API endpoint and authenticate with an API key as a bearer token. The Session response supplies the exact API and download URL templates.

## Limits and known gaps

The Session advertises a 10 MB request limit, 16 method calls per request, 256 objects per `/get`, 256 objects per `/set`, four concurrent requests, and `i;ascii-casemap` collation. Result references (`#property`) are supported, including wildcard JSON-pointer paths used to feed one method response into a later call in the same request.

EventSource push, mailbox mutation, and search snippets are not implemented. Destroying received or sent mail is `forbidden`; only drafts can be destroyed. Thread/changes, Identity/changes, and query-change calculation are also not implemented. `blobId` is still `null` for received and sent mail that didn't come from JMAP, so those messages have no raw-message blob; mail sent through EmailSubmission keeps the draft's `blobId`, because its content row outlives the draft.

`Email/get` accepts the full RFC 8621 Email property-name set, including well-formed `header:{name}[:as{Form}][:all]` selectors, so standard clients may request their normal property lists. `messageId` and `inReplyTo` are returned when they are already present in the unified message row. For received and sent mail, properties the current unified model cannot supply cheaply — including raw-message `blobId`, `references`, `sender`, `bcc`, `replyTo`, `bodyStructure`, `headers`, and dynamic `header:*` selectors — are returned as `null`; a draft supplies all of them from its own stored content. These nulls are a deliberate compatibility deviation from the stricter RFC field types until those values are modeled; names outside the RFC property set still return `invalidArguments`.

The API does not add a scheduler or maintain separate mailbox state; reads go through the same `queryMessages()` and state tables used by the saasmail UI and HTTP API.

---

**See also:** [Mailbox state](mailbox-state.md) · [Users and API keys](users-and-api-keys.md) · [MCP server](mcp.md)
