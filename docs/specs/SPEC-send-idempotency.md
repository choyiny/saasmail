# SPEC: Idempotency keys for sends

Stage 9 (trust and safety), slice 3 of 5. Depends on `SPEC-audit-log.md` (emits nothing new, but
replays must not emit `mail.sent` twice). Label `minor`.

## Why

A browser that retries after a timeout, an agent that reissues a tool call after a transport error, or
an API client's retry loop sends the same message twice. #52 added Resend idempotency keys, but those
protect one accepted send across outbox retries; two accepted sends are two outbox rows with two keys.
Mailroom requires a stable idempotency key on its send tools. With agents able to call `send_email`
and `reply_email` over MCP, a duplicate is one network blip away.

## Decisions (proposed 2026-10-03)

1. Optional everywhere (no client breaks), generated automatically by the web composers, documented as
   required practice for MCP and API clients.
2. Scope: `POST /api/send`, `POST /api/send/reply/{emailId}`, `POST /api/email-templates/{slug}/send`, and the MCP tools
   `send_email`, `reply_email`, `send_template`. Not JMAP (`EmailSubmission` creation ids are the
   client's handle), not campaigns and sequences (their own ledgers).
3. A key is scoped to the authenticated user (API keys and MCP tokens resolve to a user). Keys are kept
   24 hours, Resend's and Stripe's window.
4. Same key + same request → the stored response is replayed with `Idempotency-Replayed: true`. Same key
   - different request → `422 IDEMPOTENCY_KEY_REUSED`. Same key while the first request is still
     running → `409 IDEMPOTENCY_IN_PROGRESS` with `Retry-After: 2`. A request that fails releases the
     key, so the retry can run.
5. The request fingerprint is computed from the parsed send fields, not the raw body (multipart
   boundaries differ between retries).

## 1. Table

**Files:** `worker/src/db/send-idempotency.schema.ts`, `worker/src/db/schema.ts`, migration,
`helpers.ts`.

```
send_idempotency (
  user_id         TEXT NOT NULL,
  key             TEXT NOT NULL,        -- 1–255 printable ASCII chars
  fingerprint     TEXT NOT NULL,        -- sha256 hex of the canonical request
  status          TEXT NOT NULL,        -- pending | completed
  response_status INTEGER NULL,
  response_body   TEXT NULL,            -- JSON, the exact body returned
  sent_email_id   TEXT NULL,
  created_at      INTEGER NOT NULL,
  completed_at    INTEGER NULL,
  PRIMARY KEY (user_id, key)
)
index (created_at)
```

## 2. Service

**Files:** new `worker/src/lib/send-idempotency.ts`.

- `sendFingerprint(input)`: canonical JSON (sorted keys) of `{ kind: "send" | "reply" | "template",
emailId?, to, cc, fromAddress, subject, bodyHtml, bodyText, templateSlug, variables, replyTo,
transactional, recipient, attachments: [{ filename, size, sha256 }] }` → SHA-256 hex. Attachment
  bytes are hashed once while they are already in memory for the send.
- `withIdempotency(db, { userId, key, fingerprint }, run: () => Promise<{ status, body, sentEmailId? }>)`:
  1. `INSERT … ON CONFLICT DO NOTHING RETURNING key`. Claimed → step 3.
  2. Not claimed → read the row. Different fingerprint → throw `IdempotencyReusedError`. `pending` and
     `created_at` within the last 5 minutes → throw `IdempotencyInProgressError`. `pending` and older →
     a worker died mid-send: take the claim over with a conditional update of `created_at` guarded by
     `status = 'pending' AND created_at < …`; if 0 rows changed, someone else took it: throw
     in-progress.
     `completed` → return the stored response, flagged `replayed: true`.
  3. `await run()`. Success → update the row to `completed` with `response_status`, `response_body`,
     `sent_email_id` and `completed_at`. Throw → `DELETE` the claim and rethrow.
- `pruneSendIdempotency(db, now)`: rows older than 24 h, 1,000 per pass, in the hourly chain.
- Key validation: `^[\x21-\x7e]{1,255}$` (printable ASCII, no spaces); invalid → `400
INVALID_IDEMPOTENCY_KEY`.

## 3. Boundaries

**Files:** `worker/src/routers/send-router.ts`, `worker/src/routers/email-templates-router.ts`
(`sendTemplateRoute`), `worker/src/mcp/server.ts`,
`src/lib/api.ts`, `src/pages/ComposeModal.tsx`, the reply composer, `src/webmcp/tools/` (if a WebMCP
tool sends through `api.ts`, it inherits the header).

- HTTP: `Idempotency-Key` header, or `idempotencyKey` in the multipart payload; the header wins. The
  route parses and validates the request first (a 400 is never stored), computes the fingerprint, then
  wraps the existing send in `withIdempotency`. Replays return the stored status and body plus
  `Idempotency-Replayed: true`; errors map to 409/422 JSON `{ error, code }` like other routes.
- MCP: `idempotencyKey: z.string().optional()` on the three tools, described as "a UUID you generate per
  intended send and reuse if you retry". Replays return the stored result with `replayed: true`; reuse
  with a different payload returns a tool error naming the key.
- Web: `ComposeModal` and the reply composer create `crypto.randomUUID()` when they open and send it on
  every attempt of that composer session; a successful send closes the composer, so the next message
  gets a new key. The key is kept with the autosaved draft (`drafts` context) so a reload mid-retry
  reuses it.
- Audit: a replay emits no `mail.sent` (the original did).

## Tests

- Service: claim → complete → replay returns the same body and `replayed`; different fingerprint →
  reused error; concurrent pending → in-progress; stale pending is taken over; failure releases the
  claim; prune.
- Route: header and field; replayed header; 422 and 409 bodies; invalid key 400; a 400 validation error
  does not consume the key.
- MCP: `send_email` twice with the same key sends once (one `sent_emails` row, one outbox row).
- Web (vitest): the composer sends the same key on retry and a fresh one after success.

## Docs and CHANGELOG

- `docs/users-and-api-keys.md` (API usage) and the `use-saasmail` skill
  (`.claude/skills/use-saasmail/SKILL.md`): the header, the semantics, an example. `docs/mcp.md`: the
  input on the three tools.
- CHANGELOG `### Added`: **Idempotency keys for sends.** …
