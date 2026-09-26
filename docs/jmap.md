[saasmail](../README.md) › [Docs](README.md) › **JMAP**

# JMAP mail access

saasmail exposes a bounded subset of [JMAP Core (RFC 8620)](https://www.rfc-editor.org/rfc/rfc8620) and [JMAP Mail (RFC 8621)](https://www.rfc-editor.org/rfc/rfc8621). It is intended for mail clients and integrations that need standards-based mailbox reads plus safe message-state updates without a second copy of mail or a second permission model.

## Endpoints

- `GET /.well-known/jmap` — authenticated JMAP Session resource.
- `POST /jmap/api` — JMAP method calls.
- `GET /jmap/download/{accountId}/{blobId}/{name}?type={type}` — attachment download.

Authenticate with the same credentials as the HTTP API: either a signed-in session cookie or `Authorization: Bearer sk_...`. Session-cookie callers have the same passkey-registration gate as `/api/*`; API keys retain their normal issuance-time passkey guarantee. Every object is scoped through the caller's allowed inboxes. Objects outside that scope are reported as not found rather than disclosed.

There is one JMAP account per saasmail user. Its account id is a derived, opaque value (not the user id) and it is advertised as personal and writable. JMAP writes are deliberately limited to Email state: creating drafts, destroying messages, mailbox administration, and EmailSubmission remain unsupported.

## Ids and account (breaking in this release)

Every id the JMAP layer emits — account, mailbox, Email, thread, identity and blob — is now a valid RFC 8620 `Id`: 1–255 octets drawn from `A-Za-z0-9-_`. Previously mailbox and identity ids embedded the inbox address verbatim, which both violated the character set and overflowed the length limit for a maximum-length (254-character) inbox address.

The **account id changed** as a result. RFC 8620 §1.6.2 requires that a server which reallocates ids be treated as though the account were deleted and recreated with a new id, so connected clients must drop their cached ids, states and blobs and refetch from `/.well-known/jmap` before making further calls. Passing the previous account id to any method returns `accountNotFound`, and the download route returns 404 for it.

State strings moved with the ids: they are now `j2-<seq>-<issuedAt>-<fp>`. A client that still holds a `j1-` state gets `cannotCalculateChanges` from `Email/changes` or `Mailbox/changes`, and `stateMismatch` from `Email/set`'s `ifInState` — never a partial change set computed against ids the server no longer emits.

The web UI, the HTTP API and MCP are unaffected: the internal `received:<id>` / `sent:<id>` message references they use are unchanged, and only the JMAP boundary encodes and decodes.

Body-part blob ids (`P<email id>_text` / `P<email id>_html`) are not downloadable yet — the same pre-existing gap as before. See "Limits and known gaps" below.

## Supported methods

The server advertises `urn:ietf:params:jmap:core` and `urn:ietf:params:jmap:mail` and supports:

- `Core/echo`
- `Mailbox/get`, `Mailbox/query`
- `Email/get`, `Email/query`, `Email/set`, `Email/changes`
- `Thread/get`
- `Identity/get`
- `Mailbox/changes`

`Email/set` is update-only. It can change `$seen`/`$flagged`, move received mail among Inbox/Archive/Junk/Trash, move sent mail between Sent/Trash, and add/remove custom-folder membership. Create and destroy requests are returned per-id as `forbidden`. `Thread/changes`, `Identity/changes`, and every `*/queryChanges` continue to return `cannotCalculateChanges`.

Mailbox objects are a view over the existing mailbox-state model. Each allowed inbox gets virtual Inbox, Drafts, Sent, Archive, Junk, and Trash mailboxes whose ids are derived values, not the inbox address. Drafts is currently advertised as an empty mailbox. Custom folders from the `mailboxes` table get ids derived from the folder row. `mayReadItems`, `mayAddItems`, `mayRemoveItems`, `maySetSeen`, and `maySetKeywords` are true for normal system and custom mailboxes. Drafts remains read-only. Mailbox create/rename/delete and submission rights remain false.

Email ids are derived from the underlying saasmail message reference and are not the internal `received:<id>` / `sent:<id>` strings the HTTP API uses. `Email/get` exposes addresses, subject, dates, preview, seen/flagged keywords, mailbox membership, text/HTML body structure and optional body values, plus attachment blob ids. `Email/query` supports `inMailbox`, `text`, `from`, `after`, `before`, `hasKeyword`, and `notKeyword` for `$seen`/`$flagged`. The only supported sort is `receivedAt` descending. Thread ids are derived from the conversation keys the unified message service uses.

Attachment blob downloads reuse the same permission-checked attachment lookup as `GET /api/attachments/{id}`.

## State and changes

Mailbox/get, Email/get, Thread/get, and Email/set use change-log state strings of the form `j2-<seq>-<issuedAt>-<fp>`. `issuedAt` is the start of the current UTC day, so repeated reads of unchanged data keep the same state throughout the day; Email/set's `ifInState` compares the parsed sequence and permission fingerprint, not the issuance timestamp. Change rows are scoped by the caller's allowed inboxes and, for personal seen/flagged state, by user. States older than the supported window are rejected with `cannotCalculateChanges`; change-log rows are retained for 30 days and pruned in bounded batches by the existing scheduled maintenance chain.

Email/changes coalesces repeated activity for an Email into created/updated/destroyed ids and supports paging through an intermediate state. Mailbox/changes also reports mailbox count changes caused by Email activity. Because mailbox counts are small, saasmail does not page Mailbox/changes: if the result would exceed `maxChanges`, it returns `cannotCalculateChanges` instead.

Snooze is intentionally invisible to JMAP. A snoozed conversation remains in its normal JMAP system mailbox (normally Inbox), is returned by matching Email/query calls, and contributes to mailbox counts. Snooze-only changes therefore do not advance JMAP Email or Mailbox state.

## Pointing a client at saasmail

Use the deployment origin as the JMAP host. A client that supports automatic JMAP discovery should request:

```text
https://your-domain.example/.well-known/jmap
```

For clients that ask for endpoints manually, use `https://your-domain.example/jmap/api` for the API endpoint and authenticate with an API key as a bearer token. The Session response supplies the exact API and download URL templates.

## Limits and known gaps

The Session advertises a 10 MB request limit, 16 method calls per request, 256 objects per `/get`, 256 objects per `/set`, four concurrent requests, and `i;ascii-casemap` collation. Result references (`#property`) are supported, including wildcard JSON-pointer paths used to feed one method response into a later call in the same request.

Upload, EventSource push, Email creation/destruction, mailbox mutation, EmailSubmission, search snippets, raw-message blob download, and body-part blob download are not implemented. Thread/changes, Identity/changes, and query-change calculation are also not implemented. Draft rows are not yet projected into JMAP Email objects.

`Email/get` accepts the full RFC 8621 Email property-name set, including well-formed `header:{name}[:as{Form}][:all]` selectors, so standard clients may request their normal property lists. `messageId` and `inReplyTo` are returned when they are already present in the unified message row. Properties the current unified model cannot supply cheaply — including raw-message `blobId`, `references`, `sender`, `bcc`, `replyTo`, `bodyStructure`, `headers`, and dynamic `header:*` selectors — are returned as `null`. These nulls are a deliberate compatibility deviation from the stricter RFC field types until those values are modeled; names outside the RFC property set still return `invalidArguments`.

The API does not add a scheduler or maintain separate mailbox state; reads go through the same `queryMessages()` and state tables used by the saasmail UI and HTTP API.

---

**See also:** [Mailbox state](mailbox-state.md) · [Users and API keys](users-and-api-keys.md) · [MCP server](mcp.md)
