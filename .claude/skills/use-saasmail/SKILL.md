---
name: use-saasmail
description: Send transactional emails and enroll recipients in drip sequences through a deployed saasmail instance's HTTP API. Use this skill whenever the user wants to programmatically send mail, fire off a template, kick off an onboarding/drip sequence, manage recipient enrollment, or integrate their app with their self-hosted saasmail server — even if they don't name the product (e.g. "send a welcome email from my Worker", "enroll this signup in my onboarding drip", "POST to /api/send", "use my mail API").
---

# Using the saasmail HTTP API

saasmail is a self-hosted email server on Cloudflare Workers. Once a user has a deployed instance, they interact with it from their own apps over HTTP. This skill covers the three things callers do most:

1. Send a one-off email (with or without attachments).
2. Send an email rendered from a saved **template**.
3. Enroll a person in a **sequence** (a multi-step drip campaign), and manage that enrollment.

If the user hasn't deployed saasmail yet, point them at `/saasmail-onboarding` first — without a running instance there's no API to call.

## Two pieces of info you always need

Before writing any request, get these from the user (or confirm them):

- **Base URL** — the host their instance is deployed at, e.g. `https://mail.example.com`. There is no shared SaaS endpoint; every instance is the user's own Worker.
- **API key** — a string like `sk_abc123...`. Generated in the saasmail UI under **Settings → API Keys** (or `POST /api/api-keys`). It's shown **once** at creation. Send it as `Authorization: Bearer sk_...` on every request.

If the user hasn't created a key yet, tell them where to do it rather than guessing. Keys are gated behind a passkey in non-dev environments, so they may need to register a passkey first.

The other parameter that comes up in nearly every request is **`fromAddress`**. It must be one of the sender identities configured in that instance (the addresses the user verified during onboarding, like `noreply@yourdomain.com`). Sending from an unverified address returns a permission error — don't invent one.

## 1. Send a one-off email

`POST /api/send` — content type **`multipart/form-data`** (not JSON). The body has:

- A `payload` field whose value is a **JSON-encoded string** of the email body.
- Zero or more `files` fields, each an attachment.

This shape is unusual but deliberate: it lets the same endpoint handle plain sends and sends with attached files without a separate route.

### Minimum payload

```json
{
  "to": "recipient@example.com",
  "fromAddress": "noreply@yourdomain.com",
  "subject": "Welcome",
  "bodyHtml": "<p>Hello!</p>"
}
```

Optional fields worth knowing:

- `bodyText` — plaintext fallback. Strongly recommended for deliverability; without it some providers downrank the message.
- `cc` — array of `{ email, name? }` objects, up to 50. The `name` becomes the `Name <addr>` display in the header.
- `replyTo` — overrides where replies go. Useful for contact-form flows where mail is sent from `noreply@` but you want responses to reach the actual submitter.

### Examples

**curl, no attachments:**

```bash
curl -X POST "$SAASMAIL_URL/api/send" \
  -H "Authorization: Bearer $SAASMAIL_KEY" \
  -F 'payload={"to":"alice@example.com","fromAddress":"noreply@yourdomain.com","subject":"Welcome","bodyHtml":"<p>Hi Alice!</p>","bodyText":"Hi Alice!"}'
```

**curl, with attachments:**

```bash
curl -X POST "$SAASMAIL_URL/api/send" \
  -H "Authorization: Bearer $SAASMAIL_KEY" \
  -F 'payload={"to":"alice@example.com","fromAddress":"noreply@yourdomain.com","subject":"Your receipt","bodyHtml":"<p>See attached.</p>"}' \
  -F 'files=@receipt.pdf' \
  -F 'files=@invoice.pdf'
```

**Node / fetch:**

```ts
const fd = new FormData();
fd.append(
  "payload",
  JSON.stringify({
    to: "alice@example.com",
    fromAddress: "noreply@yourdomain.com",
    subject: "Welcome",
    bodyHtml: "<p>Hi Alice!</p>",
    bodyText: "Hi Alice!",
    cc: [{ email: "team@yourdomain.com", name: "Team" }],
    replyTo: "support@yourdomain.com",
  }),
);
// Optional attachment:
// fd.append("files", new Blob([bytes], { type: "application/pdf" }), "receipt.pdf");

const res = await fetch(`${SAASMAIL_URL}/api/send`, {
  method: "POST",
  headers: { Authorization: `Bearer ${SAASMAIL_KEY}` },
  body: fd,
});
const { id, resendId, status, attachmentIds } = await res.json();
```

A successful response is `201` with `{ id, resendId, status, attachmentIds }`. `status` is `"sent"` on success, `"retrying"` if the provider failed transiently (saasmail retries hourly for up to 24 attempts; check GET /api/outbox or the Outbox tab for the outcome), `"failed"` if the provider rejected permanently, `"suppressed"` if every recipient was on the suppression list.

### Side effect to know about

Sending to a recipient **cancels any active sequence enrollment** for that person. The product treats a manual touch as superseding the automated drip. If you're sending from a worker that also enrolls people into sequences, sequence the calls accordingly — enroll first, then send manual mail only when you actually want to interrupt the drip.

## 2. Send using a template

Templates let you store the subject + HTML body once and render with variables at send time. Variables in templates use `{{name}}` syntax (Mustache-style).

### Discover templates and their variables

```bash
# List all templates available to this caller
curl -H "Authorization: Bearer $SAASMAIL_KEY" "$SAASMAIL_URL/api/email-templates"

# Get the required variables for a given template
curl -H "Authorization: Bearer $SAASMAIL_KEY" \
  "$SAASMAIL_URL/api/email-templates/welcome-email/variables"
# → { "variables": ["firstName", "verifyUrl"] }
```

Always call the `/variables` endpoint before sending if you don't know the template intimately — `POST .../send` will reject the request with `400` and list the missing variables, but checking up front avoids a round trip.

### Send through a template

`POST /api/email-templates/{slug}/send` — **`application/json`** (different content type from `/api/send`!).

```bash
curl -X POST "$SAASMAIL_URL/api/email-templates/welcome-email/send" \
  -H "Authorization: Bearer $SAASMAIL_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "to": "alice@example.com",
    "fromAddress": "noreply@yourdomain.com",
    "variables": { "firstName": "Alice", "verifyUrl": "https://app.example.com/v/abc" }
  }'
```

Response: `201` with `{ id, resendId, status }`.

Template sends through this endpoint do **not** support attachments or `cc`. If you need either, render the template yourself (or fetch it via `GET /api/email-templates/{slug}` and interpolate) and call `/api/send` instead.

## 3. Attach a sequence to a recipient

Sequences are saved series of (template, delay) steps. Enrolling a person schedules every step up front: the first email sends immediately, each subsequent step fires `delayHours` after the previous one (anchored to the next top-of-hour).

### Find the sequence you want

```bash
curl -H "Authorization: Bearer $SAASMAIL_KEY" "$SAASMAIL_URL/api/sequences"
```

Each item has an `id`, `name`, and `steps` (array of `{ order, templateSlug, delayHours }`). Note the `id` — that's what you enroll into.

### Enroll a person

`POST /api/sequences/{sequenceId}/enroll` — `application/json`.

You can reference the recipient two ways:

- `personEmail` — by email. If no person exists with that address yet, saasmail creates one.
- `personId` — by their existing internal id (use this if you already have it).

Required: `fromAddress` (a sender identity you own). Optional:

- `variables` — values for any `{{placeholders}}` referenced inside the sequence's templates. Required if templates have variables; the enroll succeeds without validation, but individual sends will fail at send time if vars are missing.
- `skipSteps` — array of step `order` numbers to skip entirely (e.g. `[2]` to drop step 2).
- `delayOverrides` — object mapping step `order` (as string) → hours, to override the template-defined delay (e.g. `{ "3": 48 }` to push step 3 to 48h after step 2). The first step still sends immediately regardless of any override on it.

```bash
curl -X POST "$SAASMAIL_URL/api/sequences/seq_abc123/enroll" \
  -H "Authorization: Bearer $SAASMAIL_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "personEmail": "alice@example.com",
    "fromAddress": "noreply@yourdomain.com",
    "variables": { "firstName": "Alice", "productName": "Acme" },
    "skipSteps": [],
    "delayOverrides": { "3": 48 }
  }'
```

Response: `201` with `{ enrollment, scheduledEmails }`. `scheduledEmails` is the full plan — useful for showing the user what's queued and when.

### Constraint to remember

A person can only be in **one active sequence at a time**. Trying to enroll someone who's already mid-sequence returns `400 "Person is already in an active sequence"`. If you need to swap them onto a different drip, cancel their current enrollment first.

### Check / cancel an enrollment

```bash
# What's this person currently enrolled in?
curl -H "Authorization: Bearer $SAASMAIL_KEY" \
  "$SAASMAIL_URL/api/sequences/people/$PERSON_ID/enrollment"
# → { enrollment, scheduledEmails, sequenceName }  (enrollment is null if none active)

# Cancel an enrollment by id
curl -X DELETE -H "Authorization: Bearer $SAASMAIL_KEY" \
  "$SAASMAIL_URL/api/sequences/enrollments/$ENROLLMENT_ID"
```

Cancellation also marks every pending/queued sequence email as `cancelled` — they won't fire later.

### Auto-cancel via send

As noted above, calling `/api/send` (or `/api/send/reply/{emailId}`) for a person triggers `cancelSequencesForPerson` — so any active drip for that recipient stops automatically when a human or worker sends them direct mail. Lean on this rather than calling cancel manually when the user's flow is "stop drip when they reply" or "stop drip when sales takes over".

## Errors you'll actually hit

- `403` on `fromAddress` — that address isn't one of this caller's allowed sender identities. Don't retry; pick a valid one or have the user add the identity in their saasmail UI.
- `400 "Missing required template variables"` — the response body includes `missingVariables` and `requiredVariables`. Use those to either supply the values or fail clearly back to the user.
- `400 "Person is already in an active sequence"` on enroll — see above.
- `404 "Template not found"` / `"Sequence not found"` — slug or id is wrong. List the resources to find the right one before retrying.

## Where to look in the code

If something doesn't match the docs, the routers themselves are the source of truth:

- `worker/src/routers/send-router.ts` — `/api/send` and `/api/send/reply/{emailId}`
- `worker/src/routers/email-templates-router.ts` — template CRUD and `/send`
- `worker/src/routers/sequences-router.ts` — sequence CRUD, enroll, cancel
- `worker/src/index.ts` — auth middleware (Bearer key handling)
