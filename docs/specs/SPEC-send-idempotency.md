# SPEC: Idempotency keys for sends

Stage 9 (trust and safety), slice 3 of 5. Depends on `docs/archive/SPEC-audit-log.md` (emits nothing new, but
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

## Spec changes (2026-10-04, while implementing)

The five decisions are unchanged. Where the code differed from what the sections assumed, or a detail
was left open:

1. **The web keeps the key in `sessionStorage`, per compose context**, not "with the autosaved draft":
   the `drafts` table has no column for it, the autosave is debounced (a key written with it could be
   missing at the reload it is meant for), and a retry happens in one tab. `sessionStorage` is written
   when the key is created and survives a reload of that tab. No schema change.
2. **No WebMCP tool sends mail** (they save drafts and drive the UI), so none needs the header.
3. **The chat view's quick reply sends a key too**: it is a web send path the section did not list.
4. **"Success" is a 2xx answer.** A reply or template send that is refused (400 missing body or
   variables, 404 not found) is answered, not stored, and releases the key, like a thrown error:
   decision 4's "a request that fails releases the key".
5. **One upsert claims the key**: a free key, an expired one (older than 24 hours, so a key is reusable
   after its window even before the prune runs), or the same request's claim abandoned for 5 minutes.
   The stale takeover therefore also requires the same fingerprint; another request on a stale key is
   `IDEMPOTENCY_KEY_REUSED`. Release and completion touch only the claim they made.
6. **The prune takes up to ten batches of 1,000 per hourly pass**, as the audit log's does: one batch an
   hour would fall behind an instance that sends more than 24,000 keyed messages a day.
7. **The web turns the two refusals into words**: a reused key means an earlier attempt from that window
   went out without the window learning it, so the user is told to check Sent and the key is replaced;
   an in-progress key asks them to wait. API errors now carry the server's `status` and `code`.
8. **The fingerprint normalises addresses** (trimmed, lowercased) the way the send path does, and leaves
   the key itself out. HTTP and MCP share the field builder (`sendRequestFields`).
9. **CORS exposes `Idempotency-Replayed` and `Retry-After`**, so a browser client can read them.

After an independent review of the first implementation (same day), the design changed where it could
still send a message twice:

10. **An accepted send never releases its key.** The outbox tells a keyed send the moment the provider
    has the message (or its retries are the outbox's), before writing anything else
    (`notifySendAccepted`), and the key is completed at once with `{ id, status, incomplete: true }`.
    A failure after that point (a D1 error recording the send, a Worker that dies) leaves the key
    answering with that send; a retry never sends a second copy. The request's full answer replaces
    the provisional one when it finishes. Decision 4's "a request that fails releases the key" now
    reads "a request refused before the provider has the message".
11. **A running claim makes every request wait** (409), whatever it asks; the reuse error is only for a
    completed key. An abandoned claim (pending after 5 minutes) never reached the provider, so any
    request may take it over. A request still waiting on the provider after 5 minutes can still be
    overtaken: a known limit.
12. **The completion write is tried twice**, and the release after a refusal is guarded like the one
    after a throw.
13. **HTTP and MCP keys are separate** (the fingerprint names the surface): the two store differently
    shaped answers for the same send.
14. **The web forgets a key when the composer is closed** without sending, not only after a send: a
    later, different message must not inherit it. A reload closes nothing and keeps it. The chat quick
    reply shares the full reply composer's key for the same message. A reused key is worded as "this
    message was not sent; an earlier attempt may already have gone out".
15. **OpenAPI declares `Idempotency-Replayed` on the 201 and `Retry-After` on the 409.**
