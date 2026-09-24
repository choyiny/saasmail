[saasmail](../README.md) › [Docs](README.md) › **JMAP**

# JMAP (read-only mail access)

saasmail exposes a read-only subset of [JMAP Core (RFC 8620)](https://www.rfc-editor.org/rfc/rfc8620) and [JMAP Mail (RFC 8621)](https://www.rfc-editor.org/rfc/rfc8621). It is intended for mail clients and integrations that need standards-based mailbox reads without a second copy of mail or a second permission model.

## Endpoints

- `GET /.well-known/jmap` — authenticated JMAP Session resource.
- `POST /jmap/api` — JMAP method calls.
- `GET /jmap/download/{accountId}/{blobId}/{name}?type={type}` — attachment download.

Authenticate with the same credentials as the HTTP API: either a signed-in session cookie or `Authorization: Bearer sk_...`. Session-cookie callers have the same passkey-registration gate as `/api/*`; API keys retain their normal issuance-time passkey guarantee. Every object is scoped through the caller's allowed inboxes. Objects outside that scope are reported as not found rather than disclosed.

There is one JMAP account per saasmail user. Its account id is the user id and it is advertised as personal and read-only.

## Supported methods

The server advertises `urn:ietf:params:jmap:core` and `urn:ietf:params:jmap:mail` and supports:

- `Core/echo`
- `Mailbox/get`, `Mailbox/query`
- `Email/get`, `Email/query`
- `Thread/get`
- `Identity/get`

All `*/changes` and `*/queryChanges` calls return `cannotCalculateChanges`; clients should repeat the corresponding `/get` or `/query` when they need fresh state.

Mailbox objects are a view over the existing mailbox-state model. Each allowed inbox gets virtual Inbox, Drafts, Sent, Archive, Junk, and Trash mailboxes with ids such as `sys:support@example.com:inbox`. Drafts is currently advertised as an empty mailbox. Custom folders from the `mailboxes` table use `mbx:<id>`. All rights are read-only: `mayReadItems` is true and mutation rights are false.

Email ids are the normal saasmail message references (`received:<id>` and `sent:<id>`). `Email/get` exposes addresses, subject, dates, preview, seen/flagged keywords, mailbox membership, text/HTML body structure and optional body values, plus attachment blob ids. `Email/query` supports `inMailbox`, `text`, `from`, `after`, `before`, `hasKeyword`, and `notKeyword` for `$seen`/`$flagged`. The only supported sort is `receivedAt` descending. Thread ids are the same conversation keys used by the unified message service.

Attachment blob downloads reuse the same permission-checked attachment lookup as `GET /api/attachments/{id}`.

## Pointing a client at saasmail

Use the deployment origin as the JMAP host. A client that supports automatic JMAP discovery should request:

```text
https://your-domain.example/.well-known/jmap
```

For clients that ask for endpoints manually, use `https://your-domain.example/jmap/api` for the API endpoint and authenticate with an API key as a bearer token. The Session response supplies the exact API and download URL templates.

## Limits and known gaps

The Session advertises a 10 MB request limit, 16 method calls per request, 256 objects per `/get`, four concurrent requests, and `i;ascii-casemap` collation. Result references (`#property`) are supported, including wildcard JSON-pointer paths used to feed one method response into a later call in the same request.

This is deliberately read-only. Upload, EventSource push, `/set`, submission, search snippets, raw-message blob download, body-part blob download, and change/query-change calculation are not implemented. Draft rows are not yet projected into JMAP Email objects. The API does not add a scheduler or maintain separate mailbox state; reads go through the same `queryMessages()` and state tables used by the saasmail UI and HTTP API.

---

**See also:** [Mailbox state](mailbox-state.md) · [Users and API keys](users-and-api-keys.md) · [MCP server](mcp.md)
