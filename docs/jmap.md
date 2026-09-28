[saasmail](../README.md) › [Docs](README.md) › **JMAP**

# JMAP mail access and sending

saasmail exposes a bounded subset of [JMAP Core (RFC 8620)](https://www.rfc-editor.org/rfc/rfc8620) and [JMAP Mail (RFC 8621)](https://www.rfc-editor.org/rfc/rfc8621), including message submission. A standards JMAP client can read the mail of the inboxes you can access, change message state, keep drafts, attach files, and send from those inboxes. It works on the same mail and the same permission model as the web UI, the HTTP API and MCP.

## Endpoints

- `GET /.well-known/jmap`: the JMAP Session resource.
- `POST /jmap/api`: method calls.
- `POST /jmap/upload/{accountId}/`: blob upload.
- `GET /jmap/download/{accountId}/{blobId}/{name}?type={type}`: blob download.

Authenticate with the same credentials as the HTTP API: either a signed-in session cookie or `Authorization: Bearer sk_...`. Session-cookie callers have the same passkey-registration gate as `/api/*`; API keys keep their normal issuance-time passkey guarantee. A session-cookie `POST /jmap/api` must send `Content-Type: application/json`, and a session-cookie upload must carry an `Origin` header from a trusted origin (`BASE_URL` or `TRUSTED_ORIGINS`); otherwise each is refused with `403`. Bearer callers are not browsers and may omit the `Origin`. Every object is scoped through the caller's allowed inboxes. Objects outside that scope are reported as not found rather than disclosed.

Method names are case-sensitive in the `methodCalls` array, and a method that is not implemented for the account answers `unknownMethod` rather than acting partially. A method whose capability is missing from `using` is `unknownMethod` too: the `EmailSubmission/*` methods and `Identity/set` need `urn:ietf:params:jmap:submission`, everything else `urn:ietf:params:jmap:mail`.

There is one JMAP account per saasmail user. Its account id is a derived, opaque value (not the user id), and it is advertised as personal and writable. JMAP writes are deliberately limited to drafts, message state and sending: destroying received or sent mail and mailbox administration remain unsupported.

## Ids and account (breaking in this release)

Every id the JMAP layer emits (account, mailbox, Email, thread, identity, blob and submission) is a valid RFC 8620 `Id`: 1–255 octets drawn from `A-Za-z0-9-_`. Earlier development builds embedded the inbox address in mailbox and identity ids, which broke both the character set and, for a 254-character inbox address, the length limit.

The **account id changed** as a result. RFC 8620 §1.6.2 requires that a server which reallocates ids be treated as though the account were deleted and recreated with a new id, so connected clients must drop their cached ids, states and blobs and refetch from `/.well-known/jmap`. Passing the previous account id to any method returns `accountNotFound`; the upload route answers `403` and the download route `404` for it.

State strings moved with the ids: they are now `j2-<seq>-<issuedAt>-<fp>`. A client that still holds a `j1-` state gets `cannotCalculateChanges` from `Email/changes` or `Mailbox/changes`, and `stateMismatch` from `Email/set`'s `ifInState`, never a partial change set computed against ids the server no longer emits.

The web UI, the HTTP API and MCP are unaffected: the internal message references they use are unchanged, and only the JMAP boundary encodes and decodes ids.

**A second reset (id format v3)** came with `inReplyTo` and `references` for received mail. Both are immutable Email properties that used to be `null`, and a client never refetches an immutable property, so the account id changed again rather than the values changing under ids clients already hold. The v2 account id now answers `accountNotFound`, and states are `j3-…`: resync from `/.well-known/jmap` as for the first reset. Every other id (mailboxes, Emails, threads, identities, blobs, submissions) is unchanged.

## Capabilities and limits

The Session advertises `urn:ietf:params:jmap:core`, `urn:ietf:params:jmap:mail` and `urn:ietf:params:jmap:submission`, and the account is primary for mail and submission.

| Capability value                          | saasmail                                                       |
| ----------------------------------------- | -------------------------------------------------------------- |
| core `maxSizeUpload`                      | the configured provider's attachment limit (table below)       |
| core `maxConcurrentUpload`                | 4                                                              |
| core `maxSizeRequest`                     | 10,000,000 bytes                                               |
| core `maxConcurrentRequests`              | 4                                                              |
| core `maxCallsInRequest`                  | 16                                                             |
| core `maxObjectsInGet`, `maxObjectsInSet` | 256                                                            |
| core `collationAlgorithms`                | `i;ascii-casemap`                                              |
| mail `maxSizeAttachmentsPerEmail`         | same as `maxSizeUpload`                                        |
| mail `emailQuerySortOptions`              | `receivedAt`                                                   |
| submission `maxDelayedSend`               | 0: messages are sent immediately; delayed send isn't supported |
| submission `submissionExtensions`         | `{}`                                                           |

Two limits come from the outbound provider. The upload and per-Email attachment limit is the provider's attachment allowance. The whole-message limit is checked when a draft is submitted; a larger message is refused with `tooLarge`, whose `maxSize` is this number.

| Provider                 | Upload and attachment limit (bytes) | Whole-message limit (bytes) |
| ------------------------ | ----------------------------------- | --------------------------- |
| Cloudflare Email Service | 3,744,914                           | 5,242,880 (5 MiB)           |
| Postmark                 | 7,489,828                           | 10,000,000                  |
| Resend                   | 26,214,400                          | 40,000,000                  |
| Bavimail                 | 26,214,400                          | 26,214,400                  |
| Demo mode                | 26,214,400                          | 26,214,400                  |
| None configured          | 0                                   | 0                           |

Cloudflare accepts at most 5 MiB per message to arbitrary recipients (25 MiB only to verified destination addresses), attachments included. Its attachment limit is that 5 MiB divided by 1.4, to leave room for base64 and the rest of the message: a conservative estimate, while the whole-message check at submission measures the real message.

Every provider also gets Cloudflare's per-message counts, the strictest of the four: at most 50 recipients (To, Cc and Bcc together) and 32 attachments, inline images included.

## Supported methods

- `Core/echo`
- `Mailbox/get`, `Mailbox/query`, `Mailbox/changes`
- `Email/get`, `Email/query`, `Email/changes`, `Email/set`
- `Thread/get`
- `Identity/get`, `Identity/set` (read-only, see below)
- `EmailSubmission/get`, `EmailSubmission/query`, `EmailSubmission/changes`, `EmailSubmission/set`

`EmailSubmission/queryChanges`, `Thread/changes`, `Identity/changes` and every other `*/queryChanges` return `cannotCalculateChanges`.

`Identity/set` never changes anything: a create is refused with `forbidden`; an update or destroy returns `notFound` for an unknown id and `forbidden` for a known one. Identities are managed in the saasmail web UI.

Result references (`#property` with JSON-pointer paths, including `*` wildcards) and creation references (`#creationId`, RFC 8620 §3.3) are supported. A creation id can be used in a later call's `ids`, in `Email/set` `update` keys and `destroy`, and in `EmailSubmission/set`'s `emailId`. The response echoes `createdIds` when the request sent it.

## Mailboxes

Each allowed inbox gets virtual Inbox, Drafts, Sent, Archive, Junk and Trash mailboxes. Their ids are derived values, and their names read "Drafts — support@example.com". Custom folders from the `mailboxes` table appear with ids derived from the folder row. Counts include drafts: Drafts counts the caller's drafts in that inbox, and Trash counts trashed mail plus trashed drafts.

`mayReadItems`, `mayAddItems`, `mayRemoveItems`, `maySetSeen` and `maySetKeywords` are true for every system mailbox (including Drafts) and every custom folder. `maySubmit` is false everywhere: it is the IMAP "post to this mailbox" right, not permission to send. Mailbox create, rename and delete are not supported.

## Emails

Email ids are derived from the underlying message: `R…` for received mail, `S…` for sent mail and `D…` for drafts. They are not the internal `received:<id>` / `sent:<id>` references the HTTP API uses.

`Email/get` exposes addresses, subject, dates, preview, keywords, mailbox membership, text/HTML body structure, optional body values, and attachment blob ids. For Emails that saasmail created through JMAP (drafts and everything sent from them), every property is modeled from the stored message: `blobId` (the raw RFC 5322 message), exact `size`, `messageId`, `inReplyTo`, `references`, `sender`, `bcc`, `replyTo`, names on every address, and the full `bodyStructure`. Received mail also has the `inReplyTo` and `references` it arrived with. For other received and sent mail, properties the unified mail model can't supply cheaply (raw-message `blobId`, `references` of sent mail, `sender`, `bcc`, `replyTo`, `bodyStructure`, `headers` and `header:*` selectors) are returned as `null`, a deliberate deviation from the stricter RFC field types. `Email/get` accepts the full RFC 8621 property-name set, including well-formed `header:{name}[:as{Form}][:all]` selectors; names outside it return `invalidArguments`.

`Email/query` supports `inMailbox`, `text`, `from`, `after`, `before`, `hasKeyword` and `notKeyword` for `$seen`, `$flagged` and `$draft`. The only supported sort is `receivedAt` descending. Drafts take part in queries, totals and mailbox counts like any other Email.

## Drafts

A client creates a draft with `Email/set` `create`:

- `mailboxIds` must be exactly the Drafts mailbox of the identity's inbox, `keywords` must include `$draft` (`$seen` and `$flagged` are also allowed), and `from` must hold exactly one address, which must be one of your usable identities. Anything else is `invalidProperties`.
- The server sets `messageId` (`<id@identity-domain>`) and `sentAt` when omitted, and `receivedAt` at creation. `receivedAt` never changes afterwards.
- Dates are checked strictly (RFC 8620 §1.4): `sentAt` must be an RFC 3339 date-time and `receivedAt`, like every `before`/`after` query filter, a UTCDate ending in `Z`. An impossible calendar date such as `2026-02-30` is refused (`invalidProperties`, or `invalidArguments` for a filter) rather than rolled over to March.
- The body is given either as `textBody`/`htmlBody`/`attachments` with `bodyValues`, or as `bodyStructure` with `bodyValues`, never both (`invalidProperties` on `bodyStructure`). Supported `bodyStructure` shapes: a single `text/plain` or `text/html` part; `multipart/alternative` (text + HTML or HTML + `multipart/related`); `multipart/related` (HTML plus inline `cid` parts); and `multipart/mixed` with such a body plus attachment parts. Text is stored and sent as UTF-8. `headers` is never accepted, on the Email or on any part, and neither is any `header:*` property.
- Every attachment `blobId` is resolved at creation: your own uploads, attachments of messages you can read, and parts or raw blobs of Emails you can read. If any is missing, the create fails with `blobNotFound`, and `notFound` lists every missing blob id. The client's `name`, `type`, `cid` and `disposition` are kept; sizes are measured by the server. The bytes are copied into the draft, so the draft keeps its attachments after the upload expires or the source message is deleted. The total must fit `maxSizeAttachmentsPerEmail`, otherwise the create fails with `tooLarge`.
- The create response carries `id` (`D…`), `blobId` (the raw message), `threadId` and `size`.
- A draft that replies to a message you can see (matched by Message-ID in `inReplyTo` or `references`) joins that message's thread. Otherwise it joins the conversation its recipients would form in saasmail, and failing that it starts its own thread (`Td…`).

Drafts are visible only to their author, and only while the author can still access the draft's inbox. They are separate from the web composer's autosaved drafts: neither kind appears in the other interface.

## Sending

`EmailSubmission/set` `create` takes `{ identityId, emailId, envelope? }` and sends the draft immediately. Sending follows the web composer's rules for a manual message: it is **transactional**, a single message with the visible To and Cc, with no suppression-list filtering, no unsubscribe footer and no `List-Unsubscribe` header.

Rules, each reported per submission as a SetError (nothing is sent when one fails):

| Condition                                                                       | SetError                                                |
| ------------------------------------------------------------------------------- | ------------------------------------------------------- |
| `emailId` isn't one of your drafts, or `identityId` isn't a usable identity now | `invalidProperties` naming the property                 |
| The draft's `from` isn't the identity's address                                 | `forbiddenFrom`                                         |
| More than one To, with a provider that sends to one To only (Bavimail)          | `invalidEmail`, `properties: ["to"]`                    |
| Any Bcc, with a provider that can't send Bcc (Bavimail)                         | `invalidEmail`, `properties: ["bcc"]`                   |
| No To                                                                           | `noRecipients`                                          |
| An invalid recipient address                                                    | `invalidRecipients` with the list                       |
| More than 50 recipients (To, Cc and Bcc together)                               | `tooManyRecipients`, `maxRecipients: 50`                |
| `envelope.mailFrom` isn't the identity's address                                | `forbiddenMailFrom`                                     |
| `envelope.rcptTo` isn't exactly the To, Cc and Bcc addresses                    | `invalidEmail`                                          |
| SMTP parameters in the envelope                                                 | `invalidProperties` on `envelope`                       |
| More than one Reply-To (it goes out as one bare address)                        | `invalidEmail`, `properties: ["replyTo"]`               |
| A text part that is neither the text nor the HTML body (upload it as a blob)    | `invalidEmail`, `properties: ["bodyStructure"]`         |
| A stored attachment can't be read                                               | `invalidEmail` on `attachments`                         |
| More than 32 attachments, inline parts included                                 | `invalidEmail` on `attachments`                         |
| No outbound provider is configured                                              | `forbiddenToSend`                                       |
| The stored message exceeds the whole-message limit                              | `tooLarge` with `maxSize`                               |
| The draft is already being sent                                                 | `forbiddenToSend`: "This message is already being sent" |
| The provider refused the message permanently                                    | `forbiddenToSend` with the provider's reason            |

The message carries the draft's From name, every To and Cc with their display names (Bcc recipients receive it through the envelope and appear nowhere in it), subject, `Message-ID`, `In-Reply-To`, `References`, `Reply-To` and every stored part, inline or attached (inline parts keep their `cid`). Cloudflare assembles the MIME message from those parts itself, so the delivered message's structure can differ from the draft's `blobId`, and it sets its own `Message-ID` and `Date` (see below). It also appends a line break to text attachments and drops the filename of inline images ([Email providers](email-providers.md#per-message-limits)). The text body is the draft's `text/plain` body parts and the HTML body its `text/html` ones, so a text-only draft goes out without an HTML part and an HTML-only draft without a text part. If one create in a call fails unexpectedly, it gets `serverFail` and the call still reports the others.

### Message-IDs: the Email's own and the delivered one

Some providers replace the `Message-ID` a message is sent with. **Cloudflare Email Service always does**: it generates its own and doesn't let the caller set it ([Email headers](https://developers.cloudflare.com/email-service/reference/headers/)). A message sent through JMAP therefore has two ids:

- **The Email's own `messageId`**, the one `Email/get` returns. It is set when the draft is created and never changes: filing the draft into Sent, or a separate `S…` Email, keeps it (RFC 8621 lets a server alter headers when it submits a message).
- **The delivered Message-ID**, the one recipients received. saasmail records it on the sent message; the web UI's replies use it.

Clients keep citing the Email's own id. When a draft's `inReplyTo` or `references` cites the own id of a message sent through JMAP, the message goes out citing that message's delivered id instead, so the recipient's client threads it; the stored draft and its `blobId` keep what the client wrote. A draft that cites either id joins the sent message's thread. With Postmark, Resend and Bavimail, saasmail records the id it sent, and the two are the same.

A submission is accepted when the provider accepted the message, or when the provider failed temporarily and the outbox owns the retries. Accepted submissions have `undoStatus: "final"` (sent messages can't be recalled), `deliveryStatus: null` and `sendAt`. The submission's `emailId` stays the draft's `D…` id even after that Email is destroyed or filed into Sent. A permanently refused message creates no Sent Email and leaves no stored attachments behind; the draft is left as it was. A draft whose send is still in flight is locked: a second `EmailSubmission/set` for it is `forbiddenToSend` until the send settles, after which the draft can be submitted again, updated or destroyed.

`EmailSubmission/get` and `/query` show accepted submissions only. `/query` filters by `identityIds`, `emailIds`, `threadIds`, `undoStatus`, `before` and `after`, and sorts by `emailId`, `threadId` or `sentAt`. Submissions are kept for 7 days and then pruned. Updating or destroying a submission returns `notFound` for an unknown id and `forbidden` for a known one: there is no unsend.

### After sending: `onSuccessUpdateEmail` and `onSuccessDestroyEmail`

These run exactly as RFC 8621 §7.5 describes. After **all** creates in the `EmailSubmission/set` call have run, one implicit `Email/set` is built from the accepted submissions' `onSuccessUpdateEmail` patches and `onSuccessDestroyEmail` ids. Its response follows the `EmailSubmission/set` response with the same method call id. Keys may be submission creation references (`"#sub"`); a key naming a submission from an earlier call never applies. A create that failed is skipped, and the successful ones are still applied. It is an ordinary `Email/set`, so the mailbox and keyword rules below apply to it, and a patch that breaks them fails with `invalidProperties` while the send itself stands.

- **Filing the draft into Sent** (for example `{"keywords/$draft": null, "mailboxIds/<Drafts>": null, "mailboxIds/<Sent>": true}`): the same `D…` Email becomes the Sent Email. Its id and every immutable property (`blobId`, `size`, `threadId`, `receivedAt`, `messageId`, addresses and names, `subject`, `references`, body structure, attachments with `cid`) are unchanged; only `mailboxIds` and `keywords` change. The rest of the patch (a custom folder, `$flagged`) applies to it. `$seen` is implied rather than required, because a Sent Email is always seen in saasmail, so RFC 8621's own example patch — which only removes `$draft` — works unchanged.
- **A patch that keeps it a draft** (`$flagged`, or moving it to Trash) applies to the draft, and the Sent message appears as a separate `S…` Email.
- **`onSuccessDestroyEmail`** destroys the draft, and the Sent message appears as a separate `S…` Email. If the same submission is also in `onSuccessUpdateEmail`, the destroy wins and the update is reported `notUpdated` with `willDestroy`.
- **Neither argument:** the draft stays as it was and the Sent message appears as `S…`.

An `S…` Email created from a draft has every immutable property of that draft, including a downloadable raw-message `blobId`, except `receivedAt`, which is the send time.

## Mailbox and keyword rules

One set of rules applies to every `Email/set` update, whether the client sends it or it is the implicit update after a submission. An update whose result breaks a rule fails with `invalidProperties` and changes nothing.

| Email                                    | Exactly one system mailbox of its inbox | Custom folders of that inbox            | Keywords                                 |
| ---------------------------------------- | --------------------------------------- | --------------------------------------- | ---------------------------------------- |
| Received                                 | Inbox, Archive, Junk or Trash           | any                                     | `$seen`, `$flagged`                      |
| Sent (including a draft filed into Sent) | Sent or Trash                           | any                                     | `$seen` (required), `$flagged`           |
| Draft                                    | Drafts or Trash                         | none: drafts can't be in custom folders | `$draft` (required), `$seen`, `$flagged` |

A draft can move into Sent only inside the implicit update of its own accepted submission (the patch must also remove `$draft`). Outside that window, filing a draft into Sent or Inbox, or removing `$draft`, is `invalidProperties`.

`Email/set` `destroy` removes drafts. Destroying a received or sent Email returns `forbidden`: saasmail doesn't delete mail over JMAP.

## Blobs: upload and download

Upload with `POST /jmap/upload/{accountId}/`. The body is the raw bytes and `Content-Type` is the blob's type. A successful upload returns `201` with `{ "accountId", "blobId", "type", "size" }`; the blob id starts with `U`. The size is capped while the body is read: over `maxSizeUpload` returns `413` with a problem body that names the limit, another account's id returns `403`, and a missing or invalid credential returns `401`. A zero-byte upload is valid. An upload is readable only by the user who uploaded it and is deleted after 24 hours. Drafts copy what they use at creation, so the expiry doesn't affect them.

Download with the Session's `downloadUrl` template. Blob ids you can download:

| Blob id | What it is                                                                     | Who can read it                                                   |
| ------- | ------------------------------------------------------------------------------ | ----------------------------------------------------------------- |
| `U…`    | your upload                                                                    | you                                                               |
| `A…`    | an attachment of a received or sent message                                    | anyone who can read that message                                  |
| `X…`    | the raw RFC 5322 message of a JMAP-created draft or of a message sent from one | the draft's author; once sent, anyone who can read the Sent Email |
| `P…`    | one body part (`P<emailId>_<partId>`, or `_text` / `_html` for other mail)     | anyone who can read that Email                                    |

The response sets `Content-Type` from the `type` parameter, uses `name` as the filename, and always sends `Content-Disposition: attachment` and `X-Content-Type-Options: nosniff`. A blob you can't read returns `404`, as does another account's id. A `P…` part holds that part's stored bytes, so a text part downloads in its CRLF form while the `bodyValues` entry for the same part is the LF text RFC 8621 defines.

## State and changes

Mailbox/get, Email/get, Thread/get, Email/set and the EmailSubmission methods use change-log state strings of the form `j2-<seq>-<issuedAt>-<fp>`. `issuedAt` is the start of the current UTC day, so repeated reads of unchanged data keep the same state throughout the day; `ifInState` compares the parsed sequence and permission fingerprint, not the issuance timestamp. Change rows are scoped by the caller's allowed inboxes and, for personal state (seen/flagged, drafts, submissions), by user. States older than the supported window are rejected with `cannotCalculateChanges`; change-log rows are retained for 30 days and pruned in bounded batches by the scheduled maintenance chain.

Email/changes coalesces repeated activity for an Email into created/updated/destroyed ids and supports paging through an intermediate state. Mailbox/changes also reports mailbox count changes caused by Email activity. Because mailbox counts are small, saasmail does not page Mailbox/changes: if the result would exceed `maxChanges`, it returns `cannotCalculateChanges` instead.

Drafts are personal: creating, changing and destroying one shows up only in its author's change log. When a draft is filed into Sent by its submission, the author sees the same Email id as **updated**, and other members of the inbox see it **created**; no one ever sees a separate `S…` for it. A Sent message that is waiting for its submission's on-success step is hidden from JMAP until that step has run. `EmailSubmission/changes` reports accepted submissions and their pruning.

Snooze is intentionally invisible to JMAP. A snoozed conversation remains in its normal JMAP system mailbox (normally Inbox), is returned by matching Email/query calls, and contributes to mailbox counts. Snooze-only changes therefore do not advance JMAP Email or Mailbox state.

## Delivery, retries and failures

A message the provider fails temporarily stays with the outbox, which retries it every hour for up to 24 attempts. A retry sends exactly the stored message: the same From display name, recipients and names, `Message-ID`, `References`, bodies and attachments, even if the identity's display name changed in between. Reply-chain ids are mapped to delivered ids again on each attempt, and the attempt that succeeds records its delivered Message-ID.

If a retried message finally fails, its Sent Email stays visible (the submission was already accepted) and the web UI marks it failed, as it does for web sends.

An hourly recovery pass finishes submissions that a Worker crash interrupted: it completes the ones the provider accepted, releases the ones that never reached the provider, and applies any pending on-success update exactly once.

One window stays open: if the provider accepted a message and the Worker died before recording it, the outbox still sees the attempt as pending and sends it again, so the recipient may get a duplicate. The providers saasmail supports offer no idempotency key to close this.

## Pointing a client at saasmail

Use the deployment origin as the JMAP host. A client that supports automatic JMAP discovery should request:

```text
https://your-domain.example/.well-known/jmap
```

For clients that ask for endpoints manually, use `https://your-domain.example/jmap/api` for the API endpoint and authenticate with an API key as a bearer token. The Session response supplies the exact API, upload and download URL templates.

To check a deployment end to end, run `yarn jmap:e2e` (`scripts/jmap-send-e2e.mjs`). It sends real email; the variables it needs are listed at the top of the script.

## Known gaps

- Delayed send, and cancelling or recalling a submission.
- Drafts in custom folders.
- Editable identities (`Identity/set` is read-only).
- Raw-message `blobId` for received mail and for sent mail that wasn't created through JMAP (it stays `null`).
- The web composer's drafts don't appear in JMAP, and JMAP drafts don't appear in the web UI.
- A send whose Worker stopped after the provider accepted it but before saasmail wrote the provider's answer down records the Message-ID saasmail submitted, since the delivered one was never saved. Crash recovery and the campaign sweep otherwise use the delivered id kept on the held outbox row.
- Mailbox thread counts group JMAP-sent mail by its saasmail conversation, not by its JMAP `threadId`.
- EventSource push, search snippets, mailbox mutation, `Email/import` and `Email/copy`.
- `Thread/changes`, `Identity/changes` and query-change calculation.

The API does not add a scheduler or keep separate mailbox state; reads go through the same `queryMessages()` and state tables the saasmail UI and HTTP API use. Drafts and the stored form of JMAP-sent messages live in their own tables, and sending goes through the same outbox as the web composer.

## Upgrading and rollback

Apply the D1 migrations listed in the CHANGELOG before deploying the Worker that needs them. Rolling back means redeploying the previous Worker. It ignores the new tables and columns, but it would expose the old account and ids again, so clients must refetch in both directions.

---

**See also:** [Mailbox state](mailbox-state.md) · [Users and API keys](users-and-api-keys.md) · [MCP server](mcp.md)
