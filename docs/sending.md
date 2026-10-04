[saasmail](../README.md) › [Docs](README.md) › **Sending controls**

# Sending controls

Three ways to stop outbound mail when something goes wrong: a rule
auto-replying in a loop, an agent with a bad prompt, a leaked API key.

| Control                  | Who sets it             | What it stops                                                    |
| ------------------------ | ----------------------- | ---------------------------------------------------------------- |
| Pause outbound sending   | An admin, at run time   | Every message; all but forwards are held, not lost               |
| `MCP_SEND_ENABLED=false` | The deployer, at deploy | The MCP tools that send mail, for every connected agent at once  |
| Daily send limits        | An admin, at run time   | One person's messages through one channel, past a number per day |

## Pause outbound sending

**Settings → Sending → Pause sending** (admins). While sending is paused:

- Every send is still accepted and recorded. The composer, the API, MCP, JMAP,
  rules, sequences, campaigns and list subscription confirmations go on as
  before; the message shows in Sent as **retrying** and waits in the outbox.
  Nothing is refused.
- No provider is called. The hourly outbox run does nothing (one already
  running stops within seconds), and a manual **Retry** in the outbox keeps the
  message waiting without using up one of its attempts. A held message can be
  canceled from the outbox right away.
- A delayed JMAP send (`FUTURERELEASE`) stays scheduled, and can still be
  canceled.
- Answers say so: the send routes and MCP tools answer `"status": "retrying"`
  with `"paused": true`, and `GET /api/outbox/count` gives `"paused": true` and
  `held`, the number of messages waiting.
- Two sends are not held, because they have no outbox entry to wait in: inbox
  forwarding is skipped (the message itself is still in the inbox), and a
  campaign test send answers `sent: false`.
- Admins see a banner on every page with who paused and since when, and a
  **Resume** button. Everybody sees "Sending is paused; your message will be
  queued" above the Send button.

**Resume** starts delivering what was held straight away, through the queue:
50 messages per queue message, one after the other, then the delayed JMAP sends
that came due. A message accepted in the last minute before the resume goes
once its minute is up (the outbox gives every new message a minute before a
retry may claim it). Each held message is tried once this way; one that fails
then is retried by the hourly outbox run, like any other.

An API key can pause sending but cannot resume it or change a limit: that takes
a signed-in admin (`403` with `code: "SESSION_REQUIRED"`), so a leaked key
cannot undo the controls. The audit log records `sending.paused` and
`sending.resumed` with who did it.

## Agents: `MCP_SEND_ENABLED`

Set `"MCP_SEND_ENABLED": "false"` in `wrangler.jsonc` and deploy, and every
connected agent loses the ability to send at once. `send_email`, `reply_email`,
`send_template` and `enroll_sequence` stay listed but refuse with:

```
MCP_SEND_DISABLED: Sending through MCP is disabled on this server by its administrator.
```

`whoami` reports `"sendEnabled": false`, so a client can know before trying. A
token without the `email:send` scope still gets the scope error first. Reading
tools are unaffected. Unset (or any other value), sending is on.

## Daily send limits

**Settings → Sending → Daily send limits** (admins), or
`PATCH /api/admin/settings` with `dailySendLimits`. A limit is the number of
messages one person may send in a UTC day through one channel:

| Channel | What counts                                                  | Default   |
| ------- | ------------------------------------------------------------ | --------- |
| `web`   | The composer, replies and the chat quick reply               | Unlimited |
| `api`   | The HTTP send routes called with an `sk_…` API key           | Unlimited |
| `mcp`   | `send_email`, `reply_email` and `send_template`              | 200       |
| `jmap`  | `EmailSubmission/set` (a delayed send counts when submitted) | Unlimited |

Blank (`null`) is unlimited and never touches the counters. `0` blocks the
channel.

What is not counted: campaigns and sequences (they have
`PROVIDER_DAILY_SEND_LIMIT` and their own ledgers), enrolling into a sequence,
rule auto-replies, the native agent, the outbox's retries, and a replayed
request with the same [idempotency key](users-and-api-keys.md#retrying-a-send-safely).
A send that is refused (no access to the inbox, a missing template, an invalid
message) gives its slot back.

The count and the check are one statement, so two sends racing at the limit
cannot both get under it. Over the limit:

| Surface | Answer                                                                                                |
| ------- | ----------------------------------------------------------------------------------------------------- |
| HTTP    | `429` with `{ "error", "code": "DAILY_SEND_LIMIT_REACHED", "retryAfter" }` and a `Retry-After` header |
| MCP     | A tool error: `DAILY_SEND_LIMIT_REACHED: Daily send limit reached: 200 messages a day through mcp. …` |
| JMAP    | `notCreated` with `forbiddenToSend` and the same description                                          |

`Retry-After` is the number of seconds to the next UTC midnight, when the
counts start again. The first refusal of a day records `send.limit_reached` in
the audit log, once per person and channel.

**Settings → Sending** lists today's counts, busiest first
(`GET /api/admin/send-usage?day=YYYY-MM-DD`). Counts are kept for a week.

## API

| Route                       | What it does                                                                                                                             |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/admin/settings`   | `outboundPaused`, `outboundPause` (`since`, `byLabel`), `dailySendLimits`, `brandName`                                                   |
| `PATCH /api/admin/settings` | Takes `outboundPaused: boolean` and `dailySendLimits: { web, api, mcp, jmap }` (any of them); resuming and limits need a signed-in admin |
| `GET /api/admin/send-usage` | Today's counts per channel and person, at most 20                                                                                        |
| `GET /api/config`           | `outboundPaused` (whether only), for the web app; no sign-in needed                                                                      |
| `GET /api/outbox/count`     | `pending`, `held` and `paused`                                                                                                           |

---

**See also:** [Configuration](configuration.md) · [MCP server](mcp.md) · [JMAP](jmap.md) · [Audit log](audit-log.md)
