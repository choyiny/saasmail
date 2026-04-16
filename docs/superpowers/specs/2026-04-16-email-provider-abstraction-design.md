# Email Provider Abstraction Design

Date: 2026-04-16

## Goal

Support both Resend and Cloudflare Email Sending as outbound email providers. The provider is selected automatically at startup based on which environment variable or binding is configured, with no explicit `EMAIL_PROVIDER` setting required.

## Motivation

cmail currently hardcodes Resend for outbound email (three call sites). Cloudflare now offers a native `send_email` Worker binding with a structured JSON API (`env.EMAIL.send({ to, from, subject, html, text })`) that is free and avoids third-party API keys. Self-hosters should be able to pick either without touching code.

## Resolution rules

At startup the factory inspects the environment and picks exactly one provider:

1. If `RESEND_API_KEY` is set → **Resend**
2. Else if the `EMAIL` binding is present (`env.EMAIL !== undefined`) → **Cloudflare Email Sending**
3. Else → the factory returns a sender that throws `"No email provider configured"` when `send()` is called.

Resend wins when both are configured so existing deployments continue to behave as before after upgrading.

## Interface

New file `worker/src/lib/email-sender.ts`:

```typescript
export interface SendEmailParams {
  from: string; // already formatted, e.g. "Name <email@domain>"
  to: string;
  subject: string;
  html: string;
  text?: string;
  headers?: Record<string, string>;
}

export interface SendEmailResult {
  id: string | null; // provider message ID, stored in sent_emails.resendId
  error: { message: string } | null;
}

export interface EmailSender {
  send(params: SendEmailParams): Promise<SendEmailResult>;
}

export function createEmailSender(env: CloudflareBindings): EmailSender;
```

Two implementations live in the same file:

- `ResendSender` — wraps `new Resend(apiKey).emails.send(...)` and maps its `{ data, error }` to `SendEmailResult`.
- `CloudflareSender` — calls `env.EMAIL.send({ to, from, subject, html, text, headers })`, returns `{ id: result.messageId, error: null }`. Catches thrown errors and maps them to `{ id: null, error: { message: e.message } }` so callers don't need separate try/catch logic.

The factory reads `env.RESEND_API_KEY` and `env.EMAIL` and returns the appropriate implementation. The "no provider" case returns a stub that returns `{ id: null, error: { message: "No email provider configured" } }` — call sites already handle `result.error` by marking the sent-email row as `"failed"`, so nothing downstream breaks.

## Call sites to update

Three files replace `new Resend(...)` / `resend.emails.send(...)` with `createEmailSender(env).send(...)`:

1. `worker/src/routers/send-router.ts` — both the compose endpoint and the reply endpoint
2. `worker/src/routers/email-templates-router.ts` — template send endpoint
3. `worker/src/lib/sequence-processor.ts` — `processSequenceEmail` helper

The shape of the result changes slightly (`result.data?.id` → `result.id`, `result.error` stays a truthy-check). The `sent_emails.resendId` column continues to hold whatever the provider returned — renaming it would be churn; a follow-up migration can rename to `provider_message_id` later.

## Config changes

**`wrangler.jsonc.example`** — document the optional `send_email` binding:

```jsonc
// Optional: use Cloudflare Email Sending instead of Resend.
// Leave RESEND_API_KEY unset to activate this provider.
"send_email": [
  { "name": "EMAIL" }
]
```

**`worker-configuration.d.ts`** — regenerated via `wrangler types` after wrangler.jsonc updates. The `EMAIL` binding becomes `SendEmail` type when present.

**`.dev.vars.example`** — add a comment explaining that either `RESEND_API_KEY` or the `EMAIL` binding suffices.

**`CloudflareBindings` type** — needs an optional `EMAIL?: SendEmail` and optional `RESEND_API_KEY?: string` so code can check for their presence without type errors.

## Error handling

The `SendEmailResult` shape is normalized so callers write one codepath:

```typescript
const result = await sender.send(params);
const status = result.error ? "failed" : "sent";
const providerId = result.id;
```

Cloudflare's `send()` throws on error (with a `.code` property); the adapter wraps the call in try/catch and returns a normalized result. Resend returns `{ data, error }` and never throws for send failures; the adapter maps that directly.

## Testing

New file `worker/src/__tests__/email-sender.test.ts`:

- `createEmailSender` returns Resend adapter when `RESEND_API_KEY` is set
- Returns Cloudflare adapter when only `EMAIL` binding is present
- Returns Resend when both are set (precedence)
- Returns the "no provider" stub when neither is set, and that stub returns `{ id: null, error: { message: ... } }`
- `CloudflareSender.send()` catches thrown errors and returns a normalized result (use a fake `EMAIL` binding whose `send()` throws)

Existing tests that mock Resend via a fake API key continue to work because the factory still picks Resend when `RESEND_API_KEY` is set.

## Out of scope

- Renaming `sent_emails.resendId` to a generic `provider_message_id` — deferred to avoid a migration
- Per-user or per-sequence provider selection — explicitly not needed
- Admin UI for provider selection — deploy-time env is sufficient per requirements
- REST API / HTTP fallback for Cloudflare Email Sending — only the Worker binding is supported

## Files touched

- `worker/src/lib/email-sender.ts` (new)
- `worker/src/__tests__/email-sender.test.ts` (new)
- `worker/src/routers/send-router.ts`
- `worker/src/routers/email-templates-router.ts`
- `worker/src/lib/sequence-processor.ts`
- `wrangler.jsonc.example`
- `.dev.vars.example`
- `worker-configuration.d.ts` (regenerated)
