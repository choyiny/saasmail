[Docs](README.md) › **Automations**

# Automations

Saasmail has one rules engine for inbound routing and future automation uses.
Rules are evaluated inline after a received message and its mailbox state are
stored, but before conversation wake-up and notification fan-out.

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
`snooze`, and `assign`. Snooze accepts 1–720 hours. Folder moves require
an inbox-scoped rule and a folder in that same inbox. Assignment also requires
an inbox-scoped rule, and the assignee must have access to that inbox; admins
have access to every inbox.

Each action is best-effort. A failed action is logged and later actions still
run, so a routing failure never rejects inbound delivery. Match counts and
last-match timestamps are recorded per matched rule.

Mail already auto-filed to Junk by the inbox spam threshold does not enter the
rules engine. If a rule itself marks a message as spam, the message follows
the same silent path: it does not wake a snoozed conversation and does not
fan out realtime or push notifications.

## Assignment

Assignment is conversation state stored per inbox and conversation key. A new
inbound message preserves the current assignment. Assigning `null` unassigns
the conversation.

`POST /api/messages/assign` accepts message refs plus a user id or null.
The caller must be allowed to access every referenced inbox. Message reads can
filter by `assignedTo=me` or a user id, and state-aware responses expose
`state.assignedUserId`.

## Admin API

Admins can list, create, partially update, delete, and reorder rules under
`/api/admin/rules`. `POST /api/admin/rules/test` evaluates a supplied
rule's conditions against an existing received email and returns the
per-condition results without saving the rule or running any actions.

The remote MCP server exposes read-only `list_rules` under the
`email:read` scope.
