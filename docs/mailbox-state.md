[saasmail](../README.md) › [Docs](README.md) › **Mailbox state**

# Mailbox state

Message state is stored separately from the canonical received and sent message
rows. Reads still come from the unified `queryMessages()` service; state only
changes visibility when a caller explicitly asks for a folder/filter policy.

## State model

Personal state is keyed by user and message:

- **seen** — received mail bootstraps from `emails.is_read` until that viewer has
  a `message_user_state` row. Once a row exists, `seen_at` is authoritative.
- **starred** — personal to the viewer; another user cannot see the star.
- Sent messages are always seen.

Shared inbox state is keyed by message:

- **archived**
- **spam**
- **trashed**

Conversation snooze state is shared per inbox and conversation key. A group
thread uses its `conversation_id`; a one-to-one thread uses `p:<person_id>`.
Messages without either value have no conversation and cannot be snoozed.
`snoozed_until` is evaluated at read time, so no scheduler or cron job is
needed. A new received message clears the snooze for that conversation; outbound
replies do not.

Archive and spam apply only to received mail. Trash applies to both received and
sent mail. Custom folders are rows in `mailboxes` plus
`message_mailboxes` memberships; system folders are derived and are never
mailbox rows.

## Folder definitions

| Folder         | Messages included                                                                           |
| -------------- | ------------------------------------------------------------------------------------------- |
| Inbox          | Received only; not archived, spam, trashed, or actively snoozed                             |
| Sent           | Sent only; not trashed. Campaign sends are excluded by default on the HTTP/MCP Sent surface |
| Archive        | Received only; archived, not spam or trashed                                                |
| Junk           | Received only; spam, not trashed                                                            |
| Trash          | Received and sent with trash state                                                          |
| Snoozed        | Received only; actively snoozed, not spam or trashed                                        |
| Custom mailbox | Members of that mailbox, not trashed, scoped to the mailbox inbox                           |

A message that is both spam and trashed appears in Trash. Removing the trash
state makes it visible in Junk again.

`queryMessages()` is visibility-neutral when no folder/include flags are
supplied: archived, spam, trashed, and snoozed messages are not hidden
implicitly. Callers can set `includeSnoozed: false` for a neutral non-folder
query that should exclude active snoozes. Each
surface opts into its own policy. The existing per-person timeline excludes
spam and trash but continues to show archived messages.

## HTTP API

All routes use the normal authenticated API middleware and inbox permissions.

### Read messages

`GET /api/messages`

Query parameters:

- `inbox`
- `folder=inbox|sent|archive|junk|trash|snoozed`
- `mailboxId` for a custom mailbox
- `starred=true`
- `unseen=true`
- `personId`
- `q`
- `cursor`
- `limit` (default 50, maximum 100)
- `excludeCampaignSends=true|false`

The response is `{ messages, nextCursor }`. Message references are serialized
as `received:<id>` or `sent:<id>`. Each message includes a `state` object
with `seen`, `starredAt`, `archivedAt`, `spamAt`, `trashedAt`,
`mailboxIds`, `conversationKey`, and the active `snoozedUntil` value (or
`null` after expiry).

When `folder=sent`, campaign sends are excluded unless
`excludeCampaignSends=false` is supplied.

### Mutate state

- `POST /api/messages/user-state` — `{ refs, seen?, starred? }`
- `POST /api/messages/mailbox-state` — `{ refs, archived?, spam?, trashed? }`
- `POST /api/messages/mailbox-membership` — `{ refs, add?, remove? }`
- `POST /api/messages/snooze` — `{ refs, until }`, where `until` is a
  future Unix timestamp no more than 366 days away, or `null` to clear snooze

Each request accepts at most 500 message refs.

### Manage custom mailboxes

- `GET /api/mailboxes?inbox=...`
- `POST /api/mailboxes` — `{ inbox, name, parentId? }`
- `PATCH /api/mailboxes/{id}` — `{ name?, sortOrder? }`
- `DELETE /api/mailboxes/{id}`

Inaccessible messages/mailboxes are reported as `404`; invalid state/query
requests as `400`; duplicate mailbox names as `409`.

## MCP and WebMCP

The remote MCP server exposes:

- `list_messages` — requires `email:read`; mirrors `GET /api/messages`.
- `set_message_state` — requires `email:manage`; supports
  seen/starred/archive/spam/trash plus `snoozeUntil`.

WebMCP exposes the same tool names for the signed-in browser session. Its
`set_message_state` supports seen, starred, archive, spam, and reversible
`snoozeUntil`, but it still cannot trash or delete messages.

## Contributor invariants

- Unified message reads go through `worker/src/lib/messages/query.ts`.
- Message state mutations go through `worker/src/lib/messages/state.ts`;
  conversation snooze mutations go through
  `worker/src/lib/messages/conversation-state.ts`.
- Every hard-delete of a message must call `deleteMessageState()` before the
  message row is removed.
- State lookups that can exceed D1's bound-parameter limit are batched.
