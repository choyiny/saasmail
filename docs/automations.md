[Docs](README.md) › **Automations**

# Automations

Saasmail has one rules engine for inbound routing and future automation uses.
Which rules match a received message is decided before it is stored (a
[`reject`](#rejecting-mail) rule refuses it there); the other actions run once
the message and its mailbox state are stored, before conversation wake-up and
notification fan-out.

## Rules

Rules are ordered by `position` and then id. An enabled
`message.received` rule applies either to one inbox or, when `inbox` is
null, to every inbox. All conditions inside a rule must match; use multiple
rules when you need OR semantics. A rule with zero conditions matches every
message in its scope. Be careful with catch-all rules: pairing one with
`mark_spam` or `archive` affects all mail in that scope. `stop_processing`
stops evaluation after a matching rule.

Text matching is case-insensitive. Regular expressions are deliberately not
supported. A rule may have at most 10 conditions and 5 actions, and it must
have at least one action.

Supported conditions:

- `from_address`: `equals`, `contains`, `ends_with`
- `from_domain`: `equals`
- `subject`: `contains`, `equals`, `starts_with`
- `body`: `contains`; plain text is preferred, with HTML converted to text
  when plain text is absent or blank
- `has_attachments`: `is`
- `spam_score`: `gte`, `lte`; a missing score never matches
- `header`: a header `name` plus `equals` or `contains`

Supported actions are `archive`, `mark_spam`, `move_to_folder`,
`snooze`, `assign`, `auto_reply`, `ai_file` ([AI filing](#ai-filing)) and
`reject` ([below](#rejecting-mail)).
Snooze accepts 1–720 hours. Folder
moves require an inbox-scoped rule and a folder in that same inbox. Assignment
also requires an inbox-scoped rule, and the assignee must have access to that
inbox; admins have access to every inbox. Auto-reply also requires a specific
inbox scope, and a rule may contain at most one auto-reply action.

Each action is best-effort. A failed action is logged and later actions still
run, so a routing failure never rejects inbound delivery. Match counts and
last-match timestamps are recorded per matched rule.

Mail auto-filed to Junk by the inbox spam threshold runs no rule actions. A
`reject` rule still applies to it: rejection comes before storage, and so
before the threshold. If a rule itself marks a message as spam, the message follows
the same silent path: it does not wake a snoozed conversation and does not
fan out realtime or push notifications.

## AI filing

An `ai_file` action lets a model file the message into the inbox's custom
folders that have a description ("What belongs here?", set on the folder in
Mail; see [Mailbox state](mailbox-state.md#manage-custom-mailboxes)). Folders
already behave like labels: a message filed into one stays in Inbox unless it
is archived.

```json
{ "type": "ai_file", "archiveWhenFiled": true }
```

- It needs an inbox-scoped rule, at most one `ai_file` per rule, and at least
  one described folder in that inbox when the rule is saved
  (`400 NO_AI_FOLDERS`).
- It runs in the background (a queue job), a few seconds after the message
  arrives; the mail list refreshes in open tabs when it lands. The inbound
  handler never waits on a model. Later rules therefore cannot act on the
  folders it chooses.
- The model sees the sender, subject, the first 4,000 characters of the body
  (without the quoted reply, unless that is all there is, as in a forward) and
  up to 20 attachment names, as quoted data it is told never to obey, and the
  folders' names and descriptions. It may answer with ids from that list only
  (at most five); anything else is ignored. A hostile message can at worst land
  in the wrong folder, or, with `archiveWhenFiled`, skip the inbox.
- Mail in Junk or Trash is not filed. A temporary model error is retried by
  the queue after 30 seconds; a request the provider will never accept (an
  unknown model, say) ends with a warning in the logs and changes nothing.
- With `archiveWhenFiled`, a message it filed is also archived (it skips the
  inbox); one it filed nowhere stays where it is.
- It uses the agent's provider; `TRIAGE_MODEL` picks a different model for
  filing ([Native mail agent](agent.md#triage_model)). With no model
  configured the action does nothing. Filing writes no audit row; the rule's
  match count records it. A change to a folder's description is recorded
  (`folder.updated`).
- Every matching message is one model call. Mail above the inbox spam
  threshold runs no rule actions; without a threshold, add a `spam_score`
  condition to the rule so junk does not cost a call.
- A rule whose inbox no longer has a described folder files nothing and shows
  a warning; it can still be switched off or renamed.

People can also ask for it: **File with AI** in Mail files the selected
received messages (at most 50, at most 20 requests an hour per person) the
same way, without archiving and skipping Junk and Trash.

## Rejecting mail

A `reject` action refuses the message while the sending server is still
connected: Cloudflare answers it with a `5xx` and the rule's reason, so a
legitimate sender learns their mail did not land. Nothing is stored: no
message, no contact, no attachment, and no forward, auto-reply, webhook or
notification follows.

```json
{ "type": "reject", "reason": "We do not accept mail from this address" }
```

- The reason is optional (1–200 printable ASCII characters, one line); without
  one the reply is `Rejected by mailbox policy`.
- `reject` must be the rule's only action, since none could run on a message
  that is never stored. It may be inbox-scoped or apply to every inbox.
- Which rules match is decided before the message is stored, in the same order
  and with the same conditions as always; the other rules' actions run once it
  is stored. A matching rule with `stop_processing` before a reject rule keeps
  the message. The first matching reject rule wins.
- Blocked senders are still dropped silently, never rejected by a rule: a
  bounce would tell a spammer the address is live. So are redeliveries of a
  message already stored. (The [unknown-recipient](inboxes.md#unknown-recipients)
  check runs before the blocklist.)
- A rejection is decided before the inbox spam threshold, so a matching reject
  rule refuses mail the threshold would have filed to Junk.
- A message sent to several of your addresses at once reaches saasmail once
  per address. Cloudflare does not document how a rejection for one of them
  combines with the others (SMTP refuses a message as a whole once its content
  has been sent), so the sender may get a bounce even though another inbox
  stored the message. Prefer global reject rules over rules scoped to one inbox
  when a sender writes to several.
- A rejection counts as a match of the rule (`match_count`,
  `last_matched_at`) and is recorded in the [audit log](audit-log.md) as
  `inbound.rejected`, by the rule, with the sender, recipient, subject and
  Message-ID.

Mail to an address that is not one of your inboxes can be refused the same way
without a rule: see [Unknown recipients](inboxes.md#unknown-recipients).

## Assignment

Assignment is conversation state stored per inbox and conversation key. A new
inbound message preserves the current assignment. Assigning `null` unassigns
the conversation.

`POST /api/messages/assign` accepts message refs plus a user id or null.
The caller must be allowed to access every referenced inbox. Message reads can
filter by `assignedTo=me` or a user id, and state-aware responses expose
`state.assignedUserId`.

## Auto-replies

An `auto_reply` action sends a one-shot reply from the rule's scoped inbox.
The body is stored as plain text and escaped before it is used as HTML; inbox
signatures are appended with the same signature marker as manual freeform
replies. An optional subject can be supplied, otherwise the normal reply subject
(`Re: <original subject>`) is used. The outbound message is threaded with the
original Message-ID where available, includes `Auto-Submitted: auto-replied`,
and is recorded in Sent through the normal send/outbox path.

An auto-reply always goes to the message's sender (its `From` address), never
to its `Reply-To`. That header is written by whoever sent the message, and an
automatic response should not be steered by it (RFC 3834). Replies a person
sends do follow it: see [Replying](inboxes.md#replying).

Before scheduling a send, saasmail skips automated/list/bounce mail, mail from
any configured sender identity, blocked or suppressed senders, messages already
in Junk, and a sender already auto-replied to by the same rule in the previous
24 hours. The shared automated-mail guard used by both auto-replies and
suggested replies rejects `Auto-Submitted` values other than `no`,
`Precedence: bulk|list|junk`, `List-Id`, `List-Unsubscribe`,
`Return-Path: <>`, `Content-Type: multipart/report`, `X-Autoreply`,
`X-Autorespond`, `X-Auto-Response-Suppress`, and `X-Autogenerated`.
It also rejects senders whose local part is `mailer-daemon`, `postmaster`,
`noreply`, `no-reply`, or `do-not-reply` (case-insensitive, including
`+tag` variants).

For person-to-person mail sent through saasmail's `/api/send` endpoint or MCP
`send_email`, pass `transactional: true`. That avoids the
`List-Unsubscribe` header/footer that intentionally marks marketing mail as
automated, while also bypassing the suppression list.

The rate-limit row is written before the provider call, so a failed attempt
still consumes the 24-hour window. Auto-replies are never retried after a
provider failure. The actual send runs through `ctx.waitUntil`, so inbound
delivery never waits for it and cannot fail because the reply fails.

## Web UI

Admins manage rules at \`/automations\`. The list follows evaluation order and
shows each rule's name, scope, condition/action summary, enabled state, match
count, and relative last-match time. Move controls send the complete ordered id
list to the reorder endpoint. Creating and editing rules uses the same condition
and action limits as the API; folder moves, assignments, and auto-replies are disabled until a
specific inbox scope is selected. Server validation errors stay inline in the
editor, and a zero-condition rule is explicitly called out as matching every
message in its scope.

**Screenshot (list, described):** an Automations page with ordered rows. Each row
has a name and inbox badge on the left, condition and action summaries below,
match activity in the middle, and On/Off, move, edit, and delete controls on the
right.

**Screenshot (editor, described):** a rule dialog with name and scope at the top,
stacked condition and action builders, a catch-all warning when conditions are
empty, Stop processing, and a Test against a message panel that reports the
overall match and each condition result, and says when the message would be
rejected (a test never rejects anything). Choosing **Reject the message**
shows an optional reason and the warning that nothing is stored; it cannot sit
next to another action.

Assignment is also available directly in Mail. The reading pane and bulk
selection bar expose an Assign menu containing only users who can access the
current inbox plus Unassign. Assigned messages show the assignee avatar or
initials in the list, and the folder rail includes **Assigned to me**, which
queries the current inbox with \`assignedTo=me\`.

**Screenshot (mail assignment, described):** a selected message with an Assign
menu open beside the reading-pane actions, a small assignee initials chip on the
corresponding list row, and Assigned to me visible in the folder rail.

## Admin API

Admins can list, create, partially update, delete, and reorder rules under
`/api/admin/rules`. `POST /api/admin/rules/test` evaluates a supplied
rule's conditions against an existing received email and returns the
per-condition results without saving the rule or running any actions. Pass the
rule's `actions` too and the answer's `wouldReject` says whether it matched
with a `reject` action. The test looks at that one rule: an earlier rule with
Stop processing could keep a real message from reaching it.

The remote MCP server exposes read-only `list_rules` under the
`email:read` scope.
