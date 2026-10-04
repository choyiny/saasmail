[saasmail](../README.md) › [Docs](README.md) › **JMAP**

# JMAP mail access and sending

saasmail exposes a bounded subset of [JMAP Core (RFC 8620)](https://www.rfc-editor.org/rfc/rfc8620) and [JMAP Mail (RFC 8621)](https://www.rfc-editor.org/rfc/rfc8621), including message submission. A standards JMAP client can read the mail of the inboxes you can access, change message state, keep drafts, attach files, and send from those inboxes. It works on the same mail and the same permission model as the web UI, the HTTP API and MCP.

## Endpoints

- `GET /.well-known/jmap`: the JMAP Session resource.
- `POST /jmap/api`: method calls.
- `POST /jmap/upload/{accountId}/`: blob upload.
- `GET /jmap/download/{accountId}/{blobId}/{name}?type={type}`: blob download.
- `GET /jmap/eventsource/?types={types}&closeafter={closeafter}&ping={ping}`: push ([Push](#push-eventsource)).

Authenticate with the same credentials as the HTTP API: either a signed-in session cookie or `Authorization: Bearer sk_...`. Session-cookie callers have the same passkey-registration gate as `/api/*`; API keys keep their normal issuance-time passkey guarantee. A session-cookie `POST /jmap/api` must send `Content-Type: application/json`, and a session-cookie upload must carry an `Origin` header from a trusted origin (`BASE_URL` or `TRUSTED_ORIGINS`); otherwise each is refused with `403`. Bearer callers are not browsers and may omit the `Origin`. Every object is scoped through the caller's allowed inboxes. Objects outside that scope are reported as not found rather than disclosed.

Method names are case-sensitive in the `methodCalls` array, and a method that is not implemented for the account answers `unknownMethod` rather than acting partially. A method whose capability is missing from `using` is `unknownMethod` too: the `EmailSubmission/*` methods and `Identity/set` need `urn:ietf:params:jmap:submission`, everything else `urn:ietf:params:jmap:mail`.

There is one JMAP account per saasmail user. Its account id is a derived, opaque value (not the user id), and it is advertised as personal and writable. JMAP writes are deliberately limited to drafts, message state and sending: destroying received or sent mail and mailbox administration remain unsupported.

## Ids and account (breaking in this release)

Every id the JMAP layer emits (account, mailbox, Email, thread, identity, blob and submission) is a valid RFC 8620 `Id`: 1–255 octets drawn from `A-Za-z0-9-_`. Earlier development builds embedded the inbox address in mailbox and identity ids, which broke both the character set and, for a 254-character inbox address, the length limit.

The **account id changed** as a result. RFC 8620 §1.6.2 requires that a server which reallocates ids be treated as though the account were deleted and recreated with a new id, so connected clients must drop their cached ids, states and blobs and refetch from `/.well-known/jmap`. Passing the previous account id to any method returns `accountNotFound`; the upload route answers `403` and the download route `404` for it.

State strings moved with the ids: they are now `j2-<seq>-<issuedAt>-<fp>`. A client that still holds a `j1-` state gets `cannotCalculateChanges` from `Email/changes` or `Mailbox/changes`, and `stateMismatch` from `Email/set`'s `ifInState`, never a partial change set computed against ids the server no longer emits.

The web UI, the HTTP API and MCP are unaffected: the internal message references they use are unchanged, and only the JMAP boundary encodes and decodes ids.

**A second reset (id format v3)** came with `inReplyTo` and `references` for received mail. Both are immutable Email properties that used to be `null`, and a client never refetches an immutable property, so the account id changed again rather than the values changing under ids clients already hold. The v2 account id now answers `accountNotFound`, and states are `j3-…`: resync from `/.well-known/jmap` as for the first reset. Every other id (mailboxes, Emails, threads, identities, blobs, submissions) is unchanged.

**A third reset (id format v4)** came with every To address. Received mail's `to` used to be only the inbox the copy arrived in, and a sent message's `to` only its first address, with `bcc` always `null`. Now received mail's `to` is its To header as it arrived (names included, groups flattened; mail stored without a To header still lists the inbox), and a sent message lists every To and its Bcc. Both are immutable, so the v3 account id now answers `accountNotFound` and states are `j4-…`; resync as before. Ids other than the account id are unchanged.

**The account epoch (a fourth reset, then one per conversation-mode change).** The account id now also mixes in an instance-wide account epoch (`app_settings.jmap_account_epoch`, 0 until first moved): `a` and the SHA-256 of `jmap-account-v4e<epoch>:<user id>`. Deploying this release therefore resets every client once more, which also exposes `replyTo` for received mail (an immutable property that used to be `null`). After that, the epoch moves whenever an inbox's [conversation regrouping](inboxes.md#conversations-by-customer-or-by-thread) ends or stops, because `threadId` is immutable and that regrouping changes it: the held account id answers `accountNotFound`, older states answer `cannotCalculateChanges` (the epoch is part of a state's fingerprint), an open push stream ends, and the client resyncs from `/.well-known/jmap`. No code change is needed for it.

## Capabilities and limits

The Session advertises `urn:ietf:params:jmap:core`, `urn:ietf:params:jmap:mail` and `urn:ietf:params:jmap:submission`, and the account is primary for mail and submission.

| Capability value                          | saasmail                                                 |
| ----------------------------------------- | -------------------------------------------------------- |
| core `maxSizeUpload`                      | the configured provider's attachment limit (table below) |
| core `maxConcurrentUpload`                | 4                                                        |
| core `maxSizeRequest`                     | 10,000,000 bytes                                         |
| core `maxConcurrentRequests`              | 4                                                        |
| core `maxCallsInRequest`                  | 16                                                       |
| core `maxObjectsInGet`, `maxObjectsInSet` | 256                                                      |
| core `collationAlgorithms`                | `i;ascii-casemap`                                        |
| mail `maxSizeAttachmentsPerEmail`         | same as `maxSizeUpload`                                  |
| mail `emailQuerySortOptions`              | `receivedAt`                                             |
| submission `maxDelayedSend`               | 86400 (24 hours)                                         |
| submission `submissionExtensions`         | `{"FUTURERELEASE": ["86400", "<now + 24 h, UTC>"]}`      |

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
- `Email/get`, `Email/query`, `Email/changes`, `Email/queryChanges`, `Email/set`, `Email/import` (drafts only, see [Importing a message](#importing-a-message-emailimport))
- `Thread/get`, `Thread/changes`
- `Identity/get`, `Identity/set` (read-only, see below)
- `EmailSubmission/get`, `EmailSubmission/query`, `EmailSubmission/changes`, `EmailSubmission/set`

`Mailbox/queryChanges`, `Thread/queryChanges`, `EmailSubmission/queryChanges`, `Identity/changes` and `Identity/queryChanges` return `cannotCalculateChanges`.

`Identity/set` never changes anything: a create is refused with `forbidden`; an update or destroy returns `notFound` for an unknown id and `forbidden` for a known one. Identities are managed in the saasmail web UI.

Result references (`#property` with JSON-pointer paths, including `*` wildcards) and creation references (`#creationId`, RFC 8620 §3.3) are supported. A creation id from `Email/set` or `Email/import` can be used in a later call's `ids`, in `Email/set` `update` keys and `destroy`, and in `EmailSubmission/set`'s `emailId`. The response echoes `createdIds` when the request sent it.

## Mailboxes

Each allowed inbox gets virtual Inbox, Drafts, Sent, Archive, Junk and Trash mailboxes. Their ids are derived values, and their names read "Drafts — support@example.com". Custom folders from the `mailboxes` table appear with ids derived from the folder row. Counts include drafts: Drafts counts the caller's drafts in that inbox, and Trash counts trashed mail plus trashed drafts.

Counts cost four D1 queries a mailbox, so `Mailbox/get` computes them only for the mailboxes it returns, and `Mailbox/query` computes none (no filter or sort it supports needs them). A caller whose inboxes give more than `maxObjectsInGet` (256) mailboxes, 43 inboxes or more, gets `requestTooLarge` for `Mailbox/get` with `ids: null`, as RFC 8620 §5.1 allows; such a client lists the ids with `Mailbox/query` and fetches them in pages of up to 256.

`mayReadItems`, `mayAddItems`, `mayRemoveItems`, `maySetSeen` and `maySetKeywords` are true for every system mailbox (including Drafts) and every custom folder. `maySubmit` is false everywhere: it is the IMAP "post to this mailbox" right, not permission to send. Mailbox create, rename and delete are not supported.

## Emails

Email ids are derived from the underlying message: `R…` for received mail, `S…` for sent mail and `D…` for drafts. They are not the internal `received:<id>` / `sent:<id>` references the HTTP API uses.

`Email/get` exposes addresses, subject, dates, preview, keywords, mailbox membership, text/HTML body structure, optional body values, and attachment blob ids. For Emails that saasmail created through JMAP (drafts and everything sent from them), every property is modeled from the stored message: `blobId` (the raw RFC 5322 message), exact `size`, `messageId`, `inReplyTo`, `references`, `sender`, `bcc`, `replyTo`, names on every address, and the full `bodyStructure`. Received mail lists every address of its To header in `to`, and other sent mail every To and its Bcc. Received mail also has the `inReplyTo` and `references` it arrived with, its Reply-To list in `replyTo` (`null` when it had none), and mail received since saasmail began keeping it has a raw-message `blobId` (the message exactly as it arrived, kept for as long as the Email exists) and an exact `size`. For other received and sent mail, properties the unified mail model can't supply cheaply (raw-message `blobId` of older received mail and of sent mail, `references` of sent mail, `sender`, `replyTo` of sent mail, `bodyStructure`, `headers` and `header:*` selectors) are returned as `null`, a deliberate deviation from the stricter RFC field types. `Email/get` accepts the full RFC 8621 property-name set, including well-formed `header:{name}[:as{Form}][:all]` selectors; names outside it return `invalidArguments`.

An Email's `threadId` follows its inbox's [conversation mode](inboxes.md#conversations-by-customer-or-by-thread): grouped by customer, a thread is the conversation with that customer (or group); grouped by thread, it is the reply chain, so `Thread/get` returns only the messages linked by `In-Reply-To` and `References`.

`Email/query` supports `inMailbox`, `inMailboxOtherThan`, `text`, `subject`, `body`, `from`, `after`, `before`, `hasKeyword` and `notKeyword` for `$seen`, `$flagged` and `$draft`. The only supported sort is `receivedAt` descending. Drafts take part in queries, totals and mailbox counts like any other Email.

`subject` matches a subject that contains the value, ignoring case. `body` matches the stored text body the same way, for every kind of Email: received mail's text body, sent mail's text body, and a draft's text body values (the values only, never the JSON they are stored in); a value inside a word matches too. `text` keeps its broader search of subject and body. A query uses at most one of `text`, `subject` and `body`; two of them are `unsupportedFilter`. `inMailboxOtherThan` keeps Emails that are in none of the listed mailboxes, which is how a client builds an "All mail" view; ids that name no mailbox are ignored, and it can be combined with `inMailbox`.

A filter can be a `FilterOperator` as long as it reduces to one condition: an `AND` whose conditions flatten, however deeply nested, into one condition that names no property twice is that condition, and an `AND` or `OR` over a single condition is that condition. That covers what clients such as aerc send (their search terms joined with `AND`). An `OR` or `NOT` over several conditions, a `NOT` at all, and an `AND` that names a property twice (two `hasKeyword` conditions, say) are `unsupportedFilter`.

One `Email/query` call returns at most 10,000 ids. Without a `limit`, or with a larger one, the page holds up to 10,000 and the response carries `"limit": 10000` (RFC 8620 §5.5); a smaller `limit`, including 0, is used as given and not echoed. The page size is not a cap on the result: `position` beyond it works and `calculateTotal` counts everything. `canCalculateChanges` is `true` when the whole result is known to fit in one page (the page started at position 0 and nothing followed it, or the computed `total` is at most 10,000), since `Email/queryChanges` can only diff such a result. `Email/get` stays limited to 256 ids per call.

## Drafts

A client creates a draft with `Email/set` `create`:

- `mailboxIds` must be exactly the Drafts mailbox of the identity's inbox, `keywords` must include `$draft` (`$seen` and `$flagged` are also allowed), and `from` must hold exactly one address, which must be one of your usable identities. Anything else is `invalidProperties`.
- The server sets `messageId` (`<id@identity-domain>`) and `sentAt` when omitted, and `receivedAt` at creation. `receivedAt` never changes afterwards.
- Dates are checked strictly (RFC 8620 §1.4): `sentAt` must be an RFC 3339 date-time and `receivedAt`, like every `before`/`after` query filter, a UTCDate ending in `Z`. An impossible calendar date such as `2026-02-30` is refused (`invalidProperties`, or `invalidArguments` for a filter) rather than rolled over to March.
- The body is given either as `textBody`/`htmlBody`/`attachments` with `bodyValues`, or as `bodyStructure` with `bodyValues`, never both (`invalidProperties` on `bodyStructure`). Supported `bodyStructure` shapes: a single `text/plain` or `text/html` part; `multipart/alternative` (text + HTML or HTML + `multipart/related`); `multipart/related` (HTML plus inline `cid` parts); and `multipart/mixed` with such a body plus attachment parts. Text is stored and sent as UTF-8. `headers` is never accepted, on the Email or on any part, and neither is any `header:*` property.
- Every attachment `blobId` is resolved at creation: your own uploads, attachments of messages you can read, and parts or raw blobs of Emails you can read. If any is missing, the create fails with `blobNotFound`, and `notFound` lists every missing blob id. The client's `name`, `type`, `cid` and `disposition` are kept; sizes are measured by the server. The bytes are copied into the draft, so the draft keeps its attachments after the upload expires or the source message is deleted. The total must fit `maxSizeAttachmentsPerEmail`, otherwise the create fails with `tooLarge`.
- The create response carries `id` (`D…`), `blobId` (the raw message), `threadId` and `size`.
- A draft that replies to a message you can see (matched by Message-ID in `inReplyTo` or `references`) joins that message's thread. Otherwise it joins the conversation its recipients would form in saasmail, and failing that it starts its own thread (`Td…`).

Drafts are visible only to their author, and only while the author can still access the draft's inbox.

### Importing a message (`Email/import`)

Some clients, aerc among them, write the whole RFC 5322 message themselves, upload it, and `Email/import` it into Drafts before sending it (RFC 8621 §4.8). saasmail imports **drafts only**: `keywords` must include `$draft` and `mailboxIds` must name a Drafts mailbox and no other system mailbox, otherwise the import fails with `forbidden` ("Email/import only creates drafts"). Custom folders of the draft's inbox may be named next to Drafts.

The message is not stored as uploaded. It is parsed into saasmail's own draft structure and created through the same path as an `Email/set` create, so every draft rule above applies:

- Kept: `From`, `To`, `Cc`, `Bcc` and `Reply-To` with their names, `Subject`, `Date` (as `sentAt`, when valid), `Message-ID`, `In-Reply-To` and `References` (the last 100 ids), the text and HTML bodies, and every other part as an attachment or, inside `multipart/related` or marked inline, an inline part, with its name, type, `cid` and disposition. An attached `message/rfc822` is kept as an attachment with its bytes unchanged.
- Dropped: every other header (`X-Mailer`, `User-Agent`, `Autocrypt`, custom headers) and the message's original MIME layout, which saasmail rebuilds.
- The created Email's `blobId` is that rebuilt message, not the uploaded blob, which is left to expire like any upload. `receivedAt` is the one given, or the time of import.

An import is refused, with nothing stored, when:

| Condition                                                                                                                                                | SetError                                                    |
| -------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| An unknown property, a wrong type, a `null`, or a `receivedAt` that isn't a UTCDate                                                                      | `invalidProperties` naming the properties                   |
| `blobId` is not a blob you can read (your uploads, and the attachments, parts and raw messages of Emails you can read)                                   | `invalidProperties`, `properties: ["blobId"]`               |
| Not a draft target (see above)                                                                                                                           | `forbidden`                                                 |
| The message is larger than `maxSizeUpload`, has more than 32 attachments and inline parts, or its parts exceed `maxSizeAttachmentsPerEmail`              | `tooLarge`                                                  |
| A signed or encrypted part at any depth (`multipart/signed`, `multipart/encrypted`, `application/pkcs7-mime`, `application/pgp-encrypted`)               | `invalidEmail`                                              |
| More than one inline `text/plain` or `text/html` body part (a draft keeps one of each), more than 100 MIME parts, or nesting deeper than 10              | `invalidEmail`                                              |
| A part (or the message itself) with more than one `Content-Type`, `Content-Transfer-Encoding` or `Content-Disposition` header (RFC 2045 allows one each) | `invalidEmail`                                              |
| A `Content-Type` or `Content-Disposition` outside the strict grammar below, at any depth                                                                 | `invalidEmail`                                              |
| A `Content-Transfer-Encoding` other than `7bit`, `8bit`, `binary`, `base64` or `quoted-printable` (a trailing comment such as `base64 (x)` is fine)      | `invalidEmail`                                              |
| A header saasmail can't store as a draft (for example a subject over 900 characters or a malformed address)                                              | `invalidEmail` naming the header                            |
| The From isn't one of your usable identities                                                                                                             | `invalidProperties`, `properties: ["from"]`, as `Email/set` |

Signed and encrypted mail is refused because rebuilding the message would break its signature or lose its content. The parts of an attached `message/rfc822` are not inspected.

Every `Content-Type` and `Content-Disposition` must fit one strict grammar, because saasmail reads the MIME structure itself and postal-mime converts the parts, and the two must never read a part differently (a second `boundary` that one of them ignores could hide a signed part). After RFC 822 comments are removed, a `Content-Type` is `type/subtype` (both RFC 2045 tokens) and a `Content-Disposition` a single token, each followed by `; attribute=value` parameters: the attribute a token, the value a token or a quoted string (backslash escapes allowed), with optional whitespace around each `;` and one trailing `;` allowed. Refused: a parameter without `=` or without a value, an unterminated quoted string or anything but whitespace or `;` after one, an attribute given twice in any case (`filename` next to `filename*` counts), and every RFC 2231 extended or continued parameter (`boundary*0`, `charset*`) except `name*` on `Content-Type` and `filename*` on `Content-Disposition`, which carry non-ASCII file names. A `boundary` must be 1 to 70 RFC 2046 characters (letters, digits, space and `'()+_,-./:=?`, not ending in a space), and a non-ASCII byte anywhere in `Content-Type`, `Content-Disposition` or `Content-Transfer-Encoding` is refused except inside a `name` or `filename` value. Every header line of every part must be `Name: value`, the name printable ASCII with nothing before the colon, or a continuation line (starting with a space or tab) right after one; any other line in a header block is refused. Header values elsewhere may hold 8-bit text or RFC 2047 encoded words. A message of more than 100 parts is refused as soon as the 101st is found, however many more follow.

**Another inbox's Drafts.** A client that keeps one Drafts mailbox for the whole account (aerc does) may import a message from one inbox into another inbox's Drafts. When `mailboxIds` names exactly one Drafts mailbox and it belongs to another inbox you can access, the draft is created in the Drafts of its From's inbox instead. Custom folders are not remapped, so they must still belong to the From's inbox. A plain `Email/set` never remaps.

A call takes up to `maxObjectsInSet` messages (`requestTooLarge` beyond that), honours `ifInState`, and answers with `oldState`, `newState`, `created` (`id`, `blobId`, `threadId`, `size` per creation id) and `notCreated`.

### Drafts written in the web UI

A draft written in the saasmail web composer also appears in JMAP, as an ordinary draft in its inbox's Drafts mailbox. Its content is immutable like any Email's, so the web publishes it as a new revision at coarse moments, not on every keystroke: when the composer closes, and after a minute without edits. Each revision is a new `D…` Email; the previous one is destroyed, so a client sees `destroyed: [old]` and `created: [new]` in `Email/changes`. A revision keeps the custom folders and `$flagged` the client gave the previous one.

- A draft is published once it has a From that is one of your identities and a complete To address; until then it stays web-only.
- A web reply draft carries `inReplyTo` and `references` of the message it answers, so it joins that thread.
- Saving the same values again (opening and closing a draft without editing it) makes no revision.
- Deleting the draft in the web deletes it in JMAP. While a client has the published draft destroyed, being sent or in Trash, the web draft doesn't publish (and never pulls a trashed draft back into Drafts); moved back to Drafts, it publishes again.
- Attachments added in the web composer aren't part of the published draft.

Drafts made in a JMAP client are listed in the web UI's Drafts folder, marked "Mail client". The web shows them read-only (From, To, Cc, Bcc, subject, body and attachment names) and can delete them; editing and sending them stays in the mail client. A draft in Trash isn't listed.

## Sending

`EmailSubmission/set` `create` takes `{ identityId, emailId, envelope? }` and sends the draft immediately, or at a later time ([Delayed send](#delayed-send)). Sending follows the web composer's rules for a manual message: it is **transactional**, a single message with the visible To and Cc, with no suppression-list filtering, no unsubscribe footer and no `List-Unsubscribe` header.

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
| An SMTP parameter other than one `HOLDFOR` or `HOLDUNTIL` on `mailFrom`         | `invalidProperties` on `envelope`                       |
| A `HOLDFOR` or `HOLDUNTIL` more than 86400 seconds ahead, or malformed          | `invalidProperties` on `envelope`                       |
| More than one Reply-To (it goes out as one bare address)                        | `invalidEmail`, `properties: ["replyTo"]`               |
| A text part that is neither the text nor the HTML body (upload it as a blob)    | `invalidEmail`, `properties: ["bodyStructure"]`         |
| A stored attachment can't be read                                               | `invalidEmail` on `attachments`                         |
| More than 32 attachments, inline parts included                                 | `invalidEmail` on `attachments`                         |
| No outbound provider is configured                                              | `forbiddenToSend`                                       |
| The stored message exceeds the whole-message limit                              | `tooLarge` with `maxSize`                               |
| The draft is already being sent                                                 | `forbiddenToSend`: "This message is already being sent" |
| You reached your daily JMAP send limit ([Sending controls](sending.md))         | `forbiddenToSend`: "Daily send limit reached: …"        |
| The provider refused the message permanently                                    | `forbiddenToSend` with the provider's reason            |

The message carries the draft's From name, every To and Cc with their display names (Bcc recipients receive it through the envelope and appear nowhere in it), subject, `Message-ID`, `In-Reply-To`, `References`, `Reply-To` and every stored part, inline or attached (inline parts keep their `cid`). Cloudflare assembles the MIME message from those parts itself, so the delivered message's structure can differ from the draft's `blobId`, and it sets its own `Message-ID` and `Date` (see below). It also appends a line break to text attachments and drops the filename of inline images ([Email providers](email-providers.md#per-message-limits)). The text body is the draft's `text/plain` body parts and the HTML body its `text/html` ones, so a text-only draft goes out without an HTML part and an HTML-only draft without a text part. If one create in a call fails unexpectedly, it gets `serverFail` and the call still reports the others.

### Message-IDs: the Email's own and the delivered one

Some providers replace the `Message-ID` a message is sent with. **Cloudflare Email Service always does**: it generates its own and doesn't let the caller set it ([Email headers](https://developers.cloudflare.com/email-service/reference/headers/)). A message sent through JMAP therefore has two ids:

- **The Email's own `messageId`**, the one `Email/get` returns. It is set when the draft is created and never changes: filing the draft into Sent, or a separate `S…` Email, keeps it (RFC 8621 lets a server alter headers when it submits a message).
- **The delivered Message-ID**, the one recipients received. saasmail records it on the sent message; the web UI's replies use it.

Clients keep citing the Email's own id. When a draft's `inReplyTo` or `references` cites the own id of a message sent through JMAP, the message goes out citing that message's delivered id instead, so the recipient's client threads it; the stored draft and its `blobId` keep what the client wrote. A draft that cites either id joins the sent message's thread. With Postmark, Resend and Bavimail, saasmail records the id it sent, and the two are the same.

A submission is accepted when the provider accepted the message, or when the provider failed temporarily and the outbox owns the retries. Accepted submissions have `undoStatus: "final"` (sent messages can't be recalled), `deliveryStatus: null` and `sendAt`; a delayed one is `pending` until then. The submission's `emailId` stays the draft's `D…` id even after that Email is destroyed or filed into Sent. A permanently refused message creates no Sent Email and leaves no stored attachments behind; the draft is left as it was. A draft whose send is still in flight is locked: a second `EmailSubmission/set` for it is `forbiddenToSend` until the send settles, after which the draft can be submitted again, updated or destroyed.

`EmailSubmission/get` and `/query` show accepted and delayed submissions. `/query` filters by `identityIds`, `emailIds`, `threadIds`, `undoStatus`, `before` and `after`, and sorts by `emailId`, `threadId` or `sentAt`. Settled submissions are kept for 7 days after their `sendAt` and then pruned. The only update is `{"undoStatus": "canceled"}` on a delayed send ([below](#delayed-send)); a sent submission answers `cannotUnsend`, any other change `invalidProperties`, and an unknown id `notFound`. Destroying a submission returns `notFound` for an unknown id and `forbidden` for a known one.

### Delayed send

A client holds a message with an RFC 4865 FUTURERELEASE parameter on `envelope.mailFrom.parameters`: `{"HOLDFOR": "<seconds>"}` or `{"HOLDUNTIL": "<RFC 3339 date-time>"}`, at most 86400 seconds (24 hours) ahead. The Session advertises both FUTURERELEASE arguments RFC 4865 defines, the longest hold in seconds and the latest release time in UTC. A hold that is already over (`HOLDFOR=0`, a `HOLDUNTIL` in the past) sends now. Every other rule in the table above is checked when the submission is created.

- **At create**, nothing is sent. The submission is created with `undoStatus: "pending"` and `sendAt` set to the release time, and the on-success step runs now, as RFC 8621 §7.5 requires: filing the draft into Sent puts the same `D…` Email in Sent immediately. The web UI shows it in Sent marked "Scheduled for …".
- **At `sendAt`**, a queue message releases it: attachments are staged and the message goes through the outbox like any other send. `undoStatus` stays `pending` while it is being sent and becomes `final` once the provider accepted it or the outbox owns its retries. A permanent refusal leaves the Email in Sent, marked failed in the web UI, with `undoStatus: "final"`. If the queue misses a release, the hourly maintenance sends it (late by up to an hour).
- **Cancel** with `EmailSubmission/set` `update: {"<id>": {"undoStatus": "canceled"}}`. The cancel and the release race on the same row: the cancel wins only while the submission is still waiting; once the release has claimed it, the answer is `cannotUnsend`. Canceling changes only the submission (and marks the Sent message "Canceled" in the web UI). The client then moves the Email back: an `Email/set` update that gives the `D…` Email `$draft` and a Drafts (or Trash) mailbox makes it a draft again, under the same id and with the same content. Only the submission's author can do this, only after a cancel, and only for the Email the draft was filed into Sent as; every other Sent-to-Drafts move stays `invalidProperties`. Other inbox members see that Email destroyed.
- **Deleting** a scheduled message in the web UI (or its person) before it goes out cancels it at once. Moving it to Trash doesn't: `Email/set` and `EmailSubmission/set` stay independent (RFC 8621 §7), so a trashed scheduled message is still sent. The web UI asks instead: trashing a scheduled message offers "Cancel the scheduled send and move it to Trash?"; confirmed, it cancels first and trashes only what was canceled, and if the send has already started (`cannotUnsend`) it says so and leaves the message where it is.
- **Access** is checked again at release: if the author can no longer send from the identity, the message isn't sent and is marked failed.

In the web UI, **Outbox → Scheduled** lists your own delayed sends with their time. Its **Cancel** cancels the submission and then moves the message back to Drafts; if that second step fails, the send stays canceled and the hourly maintenance finishes the move. A send whose draft was never filed into Sent (no `onSuccessUpdateEmail`) has nothing to move: its draft is where the client left it, and the canceled copy stays in Sent.

### After sending: `onSuccessUpdateEmail` and `onSuccessDestroyEmail`

These run exactly as RFC 8621 §7.5 describes. After **all** creates in the `EmailSubmission/set` call have run, one implicit `Email/set` is built from the accepted submissions' `onSuccessUpdateEmail` patches and `onSuccessDestroyEmail` ids. Its response follows the `EmailSubmission/set` response with the same method call id. Keys may be submission creation references (`"#sub"`); a key naming a submission from an earlier call never applies. A create that failed is skipped, and the successful ones are still applied. It is an ordinary `Email/set`, so the mailbox and keyword rules below apply to it, and a patch that breaks them fails with `invalidProperties` while the send itself stands.

- **Filing the draft into Sent** (for example `{"keywords/$draft": null, "mailboxIds/<Drafts>": null, "mailboxIds/<Sent>": true}`): the same `D…` Email becomes the Sent Email. Its id and every immutable property (`blobId`, `size`, `threadId`, `receivedAt`, `messageId`, addresses and names, `subject`, `references`, body structure, attachments with `cid`) are unchanged; only `mailboxIds` and `keywords` change. The rest of the patch (a custom folder, `$flagged`) applies to it. `$seen` is implied rather than required, because a Sent Email is always seen in saasmail, so RFC 8621's own example patch — which only removes `$draft` — works unchanged.
- **A patch that keeps it a draft** (`$flagged`, or moving it to Trash) applies to the draft, and the Sent message appears as a separate `S…` Email.
- **`onSuccessDestroyEmail`** destroys the draft, and the Sent message appears as a separate `S…` Email. If the same submission is also in `onSuccessUpdateEmail`, the destroy wins and the update is reported `notUpdated` with `willDestroy`.
- **Neither argument:** the draft stays as it was and the Sent message appears as `S…`.

**Another inbox's Sent or Drafts in the patch.** For the same reason as on import, a client may name another inbox's Sent and Drafts in `onSuccessUpdateEmail`. When the submission is created, each `mailboxIds/<id>` key (and each id of a whole `mailboxIds` value) that names a system mailbox (Inbox, Drafts, Sent, Archive, Junk, Trash) of another inbox you can access is rewritten to the same mailbox of the draft's own inbox. If two keys then name the same mailbox with the same value they become one; if their values differ, both are left as the client sent them, and the implicit `Email/set` applies them exactly as a plain `Email/set` would. For example, `{own Sent: true, other Sent: null}` files the draft into its own Sent (removing it from a mailbox it isn't in changes nothing), while `{own Drafts: true, other Drafts: null, other Sent: true}` leaves it in Drafts next to Sent and is refused with `invalidProperties`. Custom folders and mailboxes you can't access are never rewritten. Only this implicit update is remapped; a client's own `Email/set` that moves a draft into another inbox's Sent is refused.

An `S…` Email created from a draft has every immutable property of that draft, including a downloadable raw-message `blobId`, except `receivedAt`, which is the send time.

## Mailbox and keyword rules

One set of rules applies to every `Email/set` update, whether the client sends it or it is the implicit update after a submission. An update whose result breaks a rule fails with `invalidProperties` and changes nothing.

| Email                                    | Exactly one system mailbox of its inbox | Custom folders of that inbox | Keywords                                 |
| ---------------------------------------- | --------------------------------------- | ---------------------------- | ---------------------------------------- |
| Received                                 | Inbox, Archive, Junk or Trash           | any                          | `$seen`, `$flagged`                      |
| Sent (including a draft filed into Sent) | Sent or Trash                           | any                          | `$seen` (required), `$flagged`           |
| Draft                                    | Drafts or Trash (Drafts when created)   | any                          | `$draft` (required), `$seen`, `$flagged` |

A draft can move into Sent only inside the implicit update of its own accepted or delayed submission (the patch must also remove `$draft`). Outside that window, filing a draft into Sent or Inbox, or removing `$draft`, is `invalidProperties`. The one move back, Sent to Drafts, is for a canceled delayed send ([Delayed send](#delayed-send)). A draft's custom folders are personal, like the draft: other members don't see it in them. When a draft is filed into Sent, ordinary patch rules decide its folders: a patch that doesn't remove a folder keeps it on the Sent Email, and a full `mailboxIds` keeps only what it lists. Deleting a custom folder takes it off every draft filed in it.

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

Mailbox/get, Email/get, Thread/get, Email/set, the EmailSubmission methods, and the `queryState` of `Email/query` and `Mailbox/query` use change-log state strings of the form `j4-<seq>-<issuedAt>-<fp>`. `issuedAt` is the start of the current UTC day, so repeated reads of unchanged data keep the same state throughout the day; `ifInState` compares the parsed sequence and permission fingerprint, not the issuance timestamp. Change rows are scoped by the caller's allowed inboxes and, for personal state (seen/flagged, drafts, submissions), by user. States older than the supported window are rejected with `cannotCalculateChanges`; change-log rows are retained for 30 days and pruned in bounded batches by the scheduled maintenance chain.

Two states are not mail state and follow their own objects. The Session's `state` changes only when the Session does (the account, the username, or the inboxes it covers), not when mail arrives. The Identity `state` (`Identity/get`, and `Identity/set`'s `ifInState`) is a hash of the identities you see, so it moves with any visible change to them.

Email/changes coalesces repeated activity for an Email into created/updated/destroyed ids and supports paging through an intermediate state. Mailbox/changes also reports mailbox count changes caused by Email activity. Because mailbox counts are small, saasmail does not page Mailbox/changes: if the result would exceed `maxChanges`, it returns `cannotCalculateChanges` instead.

`Email/queryChanges` takes the same filter and sort as `Email/query`, with the same validation and errors, plus `sinceQueryState`, `maxChanges` and `calculateTotal`. A state `Email/changes` would refuse gets `cannotCalculateChanges`, as does a query whose result is larger than 10,000. The server reads the current state first, then the change log and the current results. Every Email changed since the state is in `removed`, except one created since (it can't have been in the old results), and every changed or created Email in the current results is in `added` with its index; so `removed` may list Emails that were never in the old results, which RFC 8620 allows. A write that lands while the answer is being assembled can show up in `added` and again in the next call's answer, which is harmless for a client applying it; it is never missed. `maxChanges` counts `removed` and `added` together, and more changes than that is `tooManyChanges`. `upToId` is accepted and ignored: RFC 8620 only lets a server use it for immutable filters and sorts, and these filters can match on keywords and mailboxes.

`Thread/changes` is derived from the Emails changed since the state: each changed Email that still exists names its thread, which is `created` when every Email in it was created since the state and `updated` otherwise. `destroyed` is always empty, because the change log keeps no thread for an Email that is gone: a thread whose last Email was destroyed is not reported, and `Thread/get` answers `notFound` for it. More changed threads than `maxChanges` is `cannotCalculateChanges` rather than a page, so the client refetches. The call also stays within 30 D1 queries: a change set too large to look up in that many (a few thousand changed Emails) is `cannotCalculateChanges` too.

Drafts are personal: creating, changing and destroying one shows up only in its author's change log. When a draft is filed into Sent by its submission, the author sees the same Email id as **updated**, and other members of the inbox see it **created**; no one ever sees a separate `S…` for it. A Sent message that is waiting for its submission's on-success step is hidden from JMAP until that step has run. `EmailSubmission/changes` reports accepted submissions and their pruning.

Snooze is intentionally invisible to JMAP. A snoozed conversation remains in its normal JMAP system mailbox (normally Inbox), is returned by matching Email/query calls, and contributes to mailbox counts. Snooze-only changes therefore do not advance JMAP Email or Mailbox state.

## Push (EventSource)

The Session's `eventSourceUrl` is `https://your-domain.example/jmap/eventsource/?types={types}&closeafter={closeafter}&ping={ping}` (RFC 8620 §7.3), on the host the client reached. It takes the same credentials as the rest of JMAP and answers `401` without them. The response is a `text/event-stream` that starts with `retry: 5000`, the reconnect delay browsers honour.

- `types` is `*` or a comma-separated list of `Email`, `Mailbox`, `Thread` and `EmailSubmission`; other names are ignored (without `types`, every type). With none left, the stream carries only pings and keepalives.
- `closeafter` is `state` or `no` (the default). With `state`, the stream sends no initial event and closes right after the first change.
- `ping` is a whole number of seconds, 0 (the default) for none. Any other value is raised to at least 10 and at most 300, rounded up to a multiple of 10, and each `ping` event's data says the interval in use, as `{"interval": 20}` for a requested 15.

Unless `closeafter=state`, the stream opens with a `state` event carrying the current state of every requested type. Every 10 seconds it checks the change log, and when the state moved it sends one `state` event, a `StateChange` naming only the requested types on one line of JSON. The four types share one state string, so a change to any of them moves all four. Before any `state` event goes out the caller is authenticated again: a revoked API key, an expired session, a change of role (an admin made a member, even of the same inboxes) or a changed set of inboxes closes the stream without the event. A comment line goes out after 30 seconds without any bytes, since Cloudflare closes connections idle for 100 seconds.

A stream lasts at most 5 minutes, and less once it has used 40 D1 queries (the free Workers plan allows 50 per request), counting from the first query of the request (authentication, the grant, the connect state and the initial event's re-check) and each re-authentication (a tick starts only if its check and a re-check both fit, and the initial event is sent only if its re-check fits). The check costs one query whatever the number of inboxes. A query past the budget is refused before it runs: a stream that runs out while connecting answers `200` with only its `retry:` line and no event, and the client reconnects after the delay. It then closes cleanly and the client reconnects. It also ends when the client disconnects and on a database error, without a partial event. Noticing a disconnect needs the `enable_request_signal` compatibility flag in `wrangler.jsonc` (it is in `wrangler.jsonc.example`; add it to an existing deployment's config and redeploy): without it the Worker never learns the client left, and a stream whose client is gone keeps checking the change log until its 5 minutes or its query budget run out. Advertising push changed the Session, so its `state` moved once; clients that cache the Session, such as aerc, pick up the URL on their next request.

## Delivery, retries and failures

A message the provider fails temporarily stays with the outbox, which retries it every hour for up to 24 attempts. A retry sends exactly the stored message: the same From display name, recipients and names, `Message-ID`, `References`, bodies and attachments, even if the identity's display name changed in between. Reply-chain ids are mapped to delivered ids again on each attempt, and the attempt that succeeds records its delivered Message-ID.

While an admin has [paused outbound sending](sending.md), a submission is accepted and waits in the outbox like a temporary failure (without using up an attempt), and a delayed send stays `pending` until sending resumes.

If a retried message finally fails, its Sent Email stays visible (the submission was already accepted) and the web UI marks it failed, as it does for web sends.

An hourly recovery pass finishes submissions that a Worker crash interrupted: it completes the ones the provider accepted, releases the ones that never reached the provider, and applies any pending on-success update exactly once.

One window stays open: if the provider accepted a message and the Worker died before recording it, the outbox still sees the attempt as pending and sends it again. On **Resend** that retry carries the same idempotency key (one per outbox row), so Resend returns its original answer instead of sending twice, for 24 hours. Cloudflare, Postmark and Bavimail offer no such key, so there the recipient may get a duplicate.

## Pointing a client at saasmail

Use the deployment origin as the JMAP host. A client that supports automatic JMAP discovery should request:

```text
https://your-domain.example/.well-known/jmap
```

For clients that ask for endpoints manually, use `https://your-domain.example/jmap/api` for the API endpoint and authenticate with an API key as a bearer token. The Session response supplies the exact API, upload and download URL templates, as absolute URLs on the host the client reached.

To check a deployment end to end, run `yarn jmap:e2e` (`scripts/jmap-send-e2e.mjs`). It sends real email; the variables it needs are listed at the top of the script.

## Identities are read-only

`Identity/set` answers `forbidden` for every create, update and destroy, on purpose. A saasmail identity is a shared inbox, not a personal sending profile: it carries organization-wide settings (display name, signature, forwarding, spam threshold, agent instructions) that everyone using the inbox shares. Letting any member change them from a mail client would change them for everyone, so they are managed in saasmail's settings. Per-user identity preferences would be a separate, future layer.

## Known gaps

- Delayed send beyond 24 hours, changing a scheduled send's time, and scheduling from the web composer. Recalling a message that was sent.
- A canceled delayed send whose Sent copy is a separate `S…` Email (the submission didn't file the draft into Sent) can't be destroyed over JMAP; move it to Trash.
- Raw-message `blobId` for sent mail that wasn't created through JMAP, and for mail received before the raw message was kept (it stays `null`).
- Drafts made in a JMAP client are read-only in the web UI (edit and send them in the client), and a web draft's attachments aren't published to JMAP ([Drafts written in the web UI](#drafts-written-in-the-web-ui)).
- A send whose Worker stopped after the provider accepted it but before saasmail wrote the provider's answer down records the Message-ID saasmail submitted, since the delivered one was never saved. Crash recovery and the campaign sweep otherwise use the delivered id kept on the held outbox row.
- Mailbox thread counts group JMAP-sent mail by its saasmail conversation, not by its JMAP `threadId`.
- Search snippets, mailbox mutation and `Email/copy`. `Email/import` creates drafts only, and signed or encrypted mail can't be imported ([Importing a message](#importing-a-message-emailimport)).
- `Identity/changes` and query changes other than `Email/queryChanges`. `Thread/changes` never reports a destroyed thread.
- `to`, `cc` and `header` filters, `OR` and `NOT` filter operators, and sorts other than `receivedAt` descending.

The API keeps no separate mailbox state; reads go through the same `queryMessages()` and state tables the saasmail UI and HTTP API use. Drafts and the stored form of JMAP-sent messages live in their own tables, and sending goes through the same outbox as the web composer.

## Upgrading and rollback

Apply the D1 migrations listed in the CHANGELOG before deploying the Worker that needs them. Rolling back means redeploying the previous Worker. It ignores the new tables and columns, but it would expose the old account and ids again, so clients must refetch in both directions.

---

**See also:** [Mailbox state](mailbox-state.md) · [Users and API keys](users-and-api-keys.md) · [MCP server](mcp.md)
