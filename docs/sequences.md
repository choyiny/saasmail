[saasmail](../README.md) › [Docs](README.md) › **Sequences**

# Email sequencing

![Drip sequences](screenshots/sequences.jpg)

Build multi-step drip campaigns. Enroll a contact into a sequence and saasmail sends templated emails on a schedule. Supports step skipping, delay overrides, custom variables, and automatic cancellation when the contact replies. Enrollment is enforced against the member's allowed inboxes.

Scheduling runs on an hourly cron trigger that enqueues due steps onto a
Cloudflare Queue; a consumer in the same worker sends them (see
[Architecture](architecture.md)).

Every sequence step renders through the same engine as a one-off template send,
so the [template syntax](templates.md#template-syntax) and its parse rules apply
unchanged — a step whose template does not parse is marked `failed` rather than
sending something half-formed.

## Sequence provenance

Every new sequence send that produces a `sent_emails` row records both
`sequence_id` and `sequence_enrollment_id`. This applies to sent, retrying,
failed, and crash-repair rows. An initially suppressed sequence step still
creates no `sent_emails` row, matching the existing suppression behavior.

Historical provenance is best-effort. The migration backfills rows linked by
`sequence_emails.sent_email_id` and rows that still have a surviving
`outbox_emails.sequence_email_id` link. Older failed or suppressed history
with no durable backlink remains `NULL` by design.

---

**See also:** [Email templates](templates.md) · [Suppressions and unsubscribe](suppressions.md) · the `/use-saasmail` Claude Code skill for enrolling contacts over the API
