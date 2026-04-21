# Reply to Your Own Sent Messages — Design

**Date:** 2026-04-21
**Status:** Approved for planning

## Problem

The Reply action is only available on received messages. Sent messages in a thread have no Reply button, and even if one were shown, the backend's `/reply/{emailId}` route only resolves ids against the `emails` (received) table. Users cannot follow up on their own outreach from within the thread UI.

## Goal

Allow the Reply action on sent messages with full parity to replying to received messages, including correct RFC 5322 threading via `In-Reply-To`.

## Non-goals

- Changing how received-email threading works.
- Rewriting the sender abstraction or provider logic.
- Back-filling Message-IDs for historical `sent_emails` rows. Replies to pre-existing sent rows will omit `In-Reply-To` and thread by subject only.
- Supporting CC / multi-recipient replies (current behavior sends to a single `toAddress`).

## Current state (as of 2026-04-21)

- `src/components/MessageBubble.tsx:179` gates the Reply button on `email.type === "received"`.
- `worker/src/routers/send-router.ts` `/reply/{emailId}` queries only the `emails` table for the original. A sent-email id 404s.
- `worker/src/db/sent-emails.schema.ts` stores `inReplyTo` and `resendId` but does not store the outgoing Message-ID of the sent message itself.
- `worker/src/lib/email-sender.ts` wraps Resend, Cloudflare `SendEmail`, a demo sender, and a noop. None of them reliably return an RFC 822 Message-ID that we could store after the fact.

## Approach (Option A1 — full parity, generated Message-ID)

We generate our own `Message-ID` at send time, pass it to the provider via the `headers` option, and persist it on the sent row. The reply route then accepts either received or sent ids and uses the appropriate Message-ID for `In-Reply-To`.

### Schema

Add a nullable column to `sent_emails`:

```ts
messageId: text("message_id"),
```

Generate the migration via `drizzle-kit generate`. No back-fill; existing rows remain `null`.

### Sender path

Both send endpoints in `worker/src/routers/send-router.ts` (`/send` and `/reply/{emailId}`) currently call `sender.send({ from, to, subject, html, text, headers })` and then insert into `sent_emails`. Change both:

1. Before the send call, construct a Message-ID:
   ```ts
   const domain = fromAddress.split("@")[1];
   const messageId = `<${nanoid()}@${domain}>`;
   ```
2. Pass it through headers alongside any existing headers:
   ```ts
   headers: {
     ...(orig?.messageId ? { "In-Reply-To": orig.messageId } : {}),
     "Message-ID": messageId,
   }
   ```
3. Persist `messageId` on the inserted `sent_emails` row.

Providers all accept custom `Message-ID` headers. Resend documents header pass-through; the Cloudflare `SendEmail` binding forwards headers verbatim; the demo/noop senders ignore them.

### `/reply/{emailId}` lookup

Change the resolution to fall through both tables:

1. Look up the id in `emails`. If found, behavior is unchanged:
   - `toAddress` = `people.email` for `orig.personId`.
   - `In-Reply-To` = `orig.messageId` if present.
2. If not found, look up the id in `sent_emails`. If found:
   - `toAddress` = `sentEmails.toAddress` directly — do not re-derive from `people`, because the person's canonical email may have changed or the sent row may have targeted a different address.
   - `personId` = `sentEmails.personId` (used for sequence cancellation and linking the new sent row).
   - `In-Reply-To` = `sentEmails.messageId` if present; otherwise omit the header.
   - Subject defaults to the sent email's subject with a `Re: ` prefix (same rule as the received path).
3. If neither lookup succeeds, return 404 as today.

The `assertInboxAllowed` check on `fromAddress` stays unchanged — the user can still only send from an inbox they own.

### Frontend

**`src/components/MessageBubble.tsx`:** Remove the `email.type === "received"` guard on the Reply button so it renders for both types. No other changes to the bubble.

**`src/components/ReplyComposer.tsx`:** No change. It already posts to `/reply/{emailId}` and the backend now handles both id types.

**`src/pages/PersonDetail.tsx`:** Wherever the parent computes the From picker's `recipients` / default selection from the clicked email, extend to the sent case:

- For a received email: current behavior — candidates derived from the original's `recipient` / allowed inboxes.
- For a sent email: default to `email.fromAddress` (the inbox that originally sent it), still constrained to allowed inboxes.

The picker list itself remains the set of allowed inboxes; only the default selection changes based on the clicked message's type.

## Testing

**Unit / integration (`worker/src/__tests__/`):**

- `emails-router.test.ts` or `email-sender.test.ts`: add a case where a sent email is inserted with a generated `messageId`, then `POST /reply/{sentEmailId}` is called. Assert:
  - 201 response.
  - A new `sent_emails` row exists with `inReplyTo` equal to the original sent row's `messageId`.
  - `toAddress` on the new row equals the original sent row's `toAddress`.
  - `subject` is `Re: ` + original.
- Add a case where the original sent row has `messageId = null` (legacy data): reply still succeeds, and the new row's `inReplyTo` is `null`.

**E2E (`e2e/specs/`):**

Add one spec (extend `compose.spec.ts` or a new file) that:

1. Seeds a thread with a sent message (no prior received reply).
2. Opens the person detail page, clicks Reply on the sent message.
3. Types a body and sends.
4. Asserts a new sent bubble appears with a `Re: ` subject.

## Migration / rollout

- Migration adds one nullable column. Safe to deploy without coordination.
- Replying to a pre-migration sent row (no `messageId`) degrades to omitting `In-Reply-To`. Mail clients still thread by normalized subject in practice; acceptable.
- No feature flag needed.

## Out of scope / future work

- Adding a `message_id` column to the `emails` (received) table is outside this change; received replies already use the parsed `messageId` column they have.
- If we later want deterministic threading for older sent rows, a one-time back-fill could synthesize Message-IDs from `resendId` — not planned here.
