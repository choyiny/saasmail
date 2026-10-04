[saasmail](../README.md) › [Docs](README.md) › **Audit log**

# Audit log

Shared inboxes are changed by several people, by API keys, by MCP and JMAP
clients, by automation rules and by the native agent. The audit log records who
did what, so that when a message leaves Inbox, a reply goes out under a shared
identity or somebody's access changes, there is an answer to "who or what did
that?".

Admins read it at **Admin → Audit log** (`/admin/audit`). Members never see the
log, not even their own actions: each row names other people too.

## What an event says

| Field              | Meaning                                                                                                                                                                                                         |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Time               | When it happened.                                                                                                                                                                                               |
| Actor              | A person (their email), `API key sk_abcde...` (the key's prefix), `MCP client <name>`, `JMAP (...)`, `agent for <email>`, `rule <name>`, or `system`. An admin acting as another user is `admin@… as member@…`. |
| Channel            | `web`, `api`, `mcp`, `jmap`, `agent`, `rule`, `inbound`, `cron` or `queue`.                                                                                                                                     |
| Action             | A dotted name, listed below.                                                                                                                                                                                    |
| Target and inbox   | What it was done to (a message, a folder, a rule, a user, …) and the inbox it belongs to, when there is one.                                                                                                    |
| Summary            | One sentence, for example "Archived 3 messages in support@acme.com".                                                                                                                                            |
| Details            | A small JSON object: what changed, counts, the first 20 ids of a bulk operation.                                                                                                                                |
| Address and client | The caller's IP address and user agent, for requests over HTTP.                                                                                                                                                 |

An action on many things is one event with a count, not one per item. That holds
for a bulk action in the web app, for one JMAP request that moves several
messages, and for a purge. The count is of what really changed: archiving a
message that is already archived, or removing from a folder a message that was
not in it, is not an event.

## What is recorded

| Actions                                                                                                                                               | When                                                                                                                                                                                                                                                 |
| ----------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mail.sent`                                                                                                                                           | A composed message, a reply, a template send, a JMAP submission (a delayed one when it goes out, as the person who scheduled it), a rule's auto-reply, a campaign test, or a failed send that went out on a manual retry was handed to the provider. |
| `mail.archived`, `mail.unarchived`, `mail.spam`, `mail.not_spam`, `mail.trashed`, `mail.restored`                                                     | Somebody changed a message's shared state. A rule's junk mark is recorded under the rule's name.                                                                                                                                                     |
| `mail.moved`                                                                                                                                          | A message was filed into or removed from a folder.                                                                                                                                                                                                   |
| `mail.snoozed`, `mail.unsnoozed`, `mail.assigned`, `mail.unassigned`                                                                                  | A conversation was snoozed or assigned.                                                                                                                                                                                                              |
| `mail.deleted`                                                                                                                                        | A message was permanently deleted, alone, with its contact, or in a purge of blocked mail.                                                                                                                                                           |
| `settings.changed`                                                                                                                                    | The brand name, the webhook or a daily send limit changed. A secret is never written, only that one is set, and the webhook URL is kept without credentials or query.                                                                                |
| `sending.paused`, `sending.resumed`                                                                                                                   | An admin paused or resumed outbound sending ([Sending controls](sending.md)).                                                                                                                                                                        |
| `send.limit_reached`                                                                                                                                  | A person first reached a channel's daily send limit that UTC day (once per person, channel and day).                                                                                                                                                 |
| `inbound.rejected`                                                                                                                                    | A message was refused at SMTP time, by a [`reject` rule](automations.md#rejecting-mail) (actor: the rule) or because its address is not an inbox (actor: system). Details name the sender, recipient, subject and Message-ID.                        |
| `inbox.created`, `inbox.updated`, `inbox.deleted`                                                                                                     | An inbox was added, changed (with the fields that changed) or removed.                                                                                                                                                                               |
| `folder.created`, `folder.renamed`, `folder.deleted`                                                                                                  | A custom folder was added, renamed or removed.                                                                                                                                                                                                       |
| `rule.created`, `rule.updated`, `rule.toggled`, `rule.deleted`                                                                                        | An automation rule changed. Switching one on or off is `rule.toggled`.                                                                                                                                                                               |
| `user.invited`, `user.joined`, `user.role_changed`, `user.removed`, `user.inbox_access_changed`, `user.updated`, `user.impersonated`                  | Team membership and inbox access changed; an admin banned a user, set a password or revoked sessions (`user.updated`); an admin started acting as another user.                                                                                      |
| `user.passkey_added`, `user.passkey_removed`                                                                                                          | A passkey was registered or removed.                                                                                                                                                                                                                 |
| `auth.sign_in`, `auth.sign_in_failed`                                                                                                                 | A sign-in succeeded or failed. A failure is recorded only against an existing account, never with the password, and at most once a minute per account.                                                                                               |
| `api_key.created`, `api_key.revoked`                                                                                                                  | An API key was issued or revoked, named by its prefix.                                                                                                                                                                                               |
| `oauth.client_registered`, `oauth.consent_granted`, `oauth.consent_revoked`                                                                           | An MCP client registered itself, was granted access, or had it withdrawn (by the user or by an admin).                                                                                                                                               |
| `customer.linked`, `customer.unlinked`, `customer.merged`                                                                                             | Contacts were linked into a customer, unlinked, or two customers merged.                                                                                                                                                                             |
| `sequence.enrolled`, `sequence.cancelled`, `list.member_added`, `list.member_removed`, `campaign.scheduled`, `campaign.started`, `campaign.cancelled` | A person or the agent enrolled or cancelled a sequence, changed a list's members, or scheduled, started or cancelled a campaign (a scheduled one is started by the system; the schedule names the person).                                           |
| `agent.action_executed`, `agent.action_denied`                                                                                                        | The agent ran an action you approved, or you declined one.                                                                                                                                                                                           |

## What is not recorded

- Reads: opening, listing or searching mail.
- Personal state: read/unread and stars are per user and not shared.
- A rule's routine filing of inbound mail (archive, folder, snooze, assign): the
  rule's match count covers it, and it would drown everything else. A rule's
  sends and junk marks are recorded.
- The system's own work: storing inbound mail, automatic junk filing by spam
  score, stopping a contact's sequences when they write or are written to,
  push notifications.
- A subscriber's own subscribe and unsubscribe through public links, list
  imports, and sequence or campaign messages one by one (the enrollment and the
  campaign start are recorded instead).

Recording is best effort: if the log cannot be written, the action still
succeeds and the failure goes to the Worker's logs.

## Retention

Events are kept for 180 days and then deleted by the hourly maintenance, at most
10,000 per pass. Set the optional `AUDIT_RETENTION_DAYS` variable to keep them
longer or shorter; it cannot go below 30 days. See
[Configuration](configuration.md).

## API

Admin only, like every `/api/admin/*` route.

- `GET /api/admin/audit` returns `{ events, nextCursor }`, newest first. Filters:
  `action` (exact), `actionPrefix` (for example `mail.`), `actorUserId`, `inbox`,
  `targetType`, `targetId`, `from` and `to` (Unix seconds), and `q` (text in the
  summary or the actor). Page with `limit` (up to 100) and `cursor` (the previous
  page's `nextCursor`).
- `GET /api/admin/audit/actions` returns every action name the log can record.
- `GET /api/admin/audit/export.csv` takes the same filters and returns the events
  as CSV, at most 10,000 rows per download; narrow the date range for more.

---

**See also:** [Users and API keys](users-and-api-keys.md) · [Automations](automations.md) · [Native mail agent](agent.md) · [MCP server](mcp.md)
