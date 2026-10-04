[saasmail](../README.md) › [Docs](README.md) › **Users and API keys**

# Users and API keys

## User management

Admin-controlled onboarding via one-time invite links. New members sign up with email + password, and can register a passkey for passwordless login on subsequent sessions. Roles: `admin` (full access + user management) and `member` (scoped by inbox assignment).

Inbox assignment is what a member's access actually derives from — see
[Multi-inbox with team permissions](inboxes.md#multi-inbox-with-team-permissions).
The same scoping is enforced for the HTTP API, the [MCP server](mcp.md), and
[WebMCP](webmcp.md), by the same code.

## Signing in

In production every account must register a passkey before it can use the
app or the API. After a new member's first password sign-in the web app takes
them to passkey setup; until they have one, their session can sign out, read
itself and register a passkey, and everything else answers
`403 PASSKEY_REQUIRED`, on saasmail's routes and better-auth's alike. From then
on the password no longer signs in, only the passkey does
(`403 PASSKEY_REQUIRED_FOR_SIGNIN`).

Registering an account's first passkey ends every other session it had and
every OAuth grant (MCP clients), and an MCP access token minted before that
passkey is refused: whatever someone opened with a leaked password in that
window stops working. The client simply connects again. Local development
(`DISABLE_PASSKEY_GATE=true`) and demo deploys skip these rules.

Sign-in is rate-limited per client address, with the counts kept in D1 so the
limits hold however many Workers serve the requests:

| Requests                                   | Limit                  |
| ------------------------------------------ | ---------------------- |
| Password sign-in, change password or email | 3 per 10 seconds       |
| Password reset                             | 3 a minute             |
| OAuth token, authorize and revoke          | 20, 30 and 30 a minute |
| OAuth userinfo; client registration        | 60; 5 a minute         |
| Any other auth route                       | 100 per 10 seconds     |

Past a limit the answer is `429` with an `X-Retry-After` header (seconds).
Reading the session is not limited. Local development and demo deploys are not
limited.

## API keys

Issue scoped API keys for programmatic access to send email, manage templates, enroll contacts in sequences, and query inbox data. Keys are hashed at rest and follow the `sk_…` format.

Pass one as `Authorization: Bearer sk_…`. The interactive explorer at
`/swagger-ui` on your deployment documents every route a key can reach.

### Retrying a send safely

A client that retries after a timeout can send the same message twice. The
send routes (`POST /api/send`, `POST /api/send/reply/{emailId}`,
`POST /api/email-templates/{slug}/send`) take an `Idempotency-Key` header:
generate one per message you intend to send (a UUID) and send the same key on
every retry of that message.

- A retry of the same request with the same key is answered with the first
  response and `Idempotency-Replayed: true`; nothing is sent again.
- The same key with a different request is `422` with
  `code: "IDEMPOTENCY_KEY_REUSED"`. Use a new key for a new message.
- A retry while the first request is still running is `409` with
  `code: "IDEMPOTENCY_IN_PROGRESS"` and `Retry-After: 2`, whatever it asks.
- A request refused before anything was sent (a validation error, a missing
  template variable, an inbox you may not send from) releases the key, so the
  corrected request can use it.
- Once the provider has the message, the key belongs to that send for good. If
  the request fails after that point (a 5xx while saasmail records the send),
  retrying with the key answers `{ id, status, incomplete: true }` instead of
  sending a second copy.
- Keys belong to the user behind the API key and are kept 24 hours. A key is 1
  to 255 printable ASCII characters without spaces; anything else is `400`
  with `code: "INVALID_IDEMPOTENCY_KEY"`.

A send over the key owner's daily API limit is `429` with
`code: "DAILY_SEND_LIMIT_REACHED"` and `Retry-After` set to the seconds until
midnight UTC; a replay with the same key never counts. While an admin has paused
outbound sending, sends answer `201` with `status: "retrying"` and
`paused: true`. See [Sending controls](sending.md).

A client that cannot set headers can put `idempotencyKey` in the JSON payload;
the header wins when both are present. The web app does this for you: every
compose and reply window sends one key per message.

```bash
curl -X POST "$SAASMAIL_URL/api/send" \
  -H "Authorization: Bearer $SAASMAIL_KEY" \
  -H "Idempotency-Key: $(uuidgen)" \
  -F 'payload={"to":"alice@example.com","fromAddress":"noreply@yourdomain.com","subject":"Welcome","bodyHtml":"<p>Hi</p>"}'
```

Reuse the same value when you retry; `$(uuidgen)` above makes a new one each
time it runs, so store it before the first attempt in real code.

---

**See also:** [MCP server](mcp.md) for OAuth-based AI assistant access · [Webhooks](webhooks.md) · the `/use-saasmail` Claude Code skill
