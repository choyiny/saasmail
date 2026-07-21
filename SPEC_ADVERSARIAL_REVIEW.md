# Newsletter Spec Adversarial Review

**Reviewed:** 2026-07-21  
**Artifact:** [`SPEC.md`](SPEC.md)  
**Scope:** Correctness, security, Cloudflare platform constraints, deliverability, data integrity, scalability, authorization, privacy, compliance, and operability.

This review was reconciled against the current repository and Cloudflare documentation. It used a fresh-context adversarial reviewer. A cross-model second opinion was offered and skipped.

## Verdict

The product shape is sound, but implementation should not begin until the critical and high-priority findings below are resolved in the spec. The largest architectural correction is to make campaign fan-out and CSV import resumable jobs, with the existing outbox serving as the durable delivery authority.

## Critical Findings

### 1. Delivery idempotency is not guaranteed

**Spec area:** Campaign fan-out and queue consumer.

The proposed pre-send `campaign_recipients.status !== 'sent'` check is racy. Two queue deliveries can both pass it and call the provider. A crash after provider acceptance but before D1 records success can also cause a duplicate.

A unique `(campaignId, personId)` ledger key protects the database row, not the external send side effect. Cloudflare Queues provides at-least-once delivery.

**Required correction:**

- Reuse the write-ahead outbox pattern in `worker/src/lib/outbox.ts`.
- Give each campaign recipient a unique, stable outbox reference and provider idempotency key where supported.
- Add recipient states such as `processing`, `retrying`, and `unknown`.
- Treat Queue retries as triggers for durable outbox processing, not as the sole retry mechanism.
- Describe delivery as **at-least-once with duplicate suppression**, not exactly-once.
- Test duplicate queue delivery and a crash after provider success but before bookkeeping completes.

### 2. A 10,000-recipient fan-out cannot safely run in one request

**Spec area:** Campaign fan-out initialization.

The spec requires both one `db.batch()` and batches of at most 100 statements. Those requirements conflict. Sending 10,000 individual Queue messages creates 10,000 producer operations; even 100-message `sendBatch()` calls require 100 calls.

Current D1 limits also differ by plan: up to 50 queries per invocation on Workers Free and 1,000 on Workers Paid. D1 is single-threaded per database and can return overloaded errors under excessive concurrent writes.

**Required correction:**

- Enqueue one fan-out coordinator message rather than performing the complete fan-out in the HTTP request.
- Each coordinator invocation processes a deterministic cursor page of at most 100 recipients.
- Insert ledger rows in bounded batches and publish with `EMAIL_QUEUE.sendBatch()`.
- Enqueue the next cursor page only after the current page succeeds.
- Store fan-out progress so retries resume from a durable cursor.
- State explicitly whether Workers Free is supported for newsletter sends.
- Apply the same resumable-job pattern to CSV import.

### 3. Open-event deduplication fails under SQLite `NULL` semantics

**Spec area:** `campaign_events` uniqueness.

The proposed unique key includes `(campaignId, personId, eventType, url)`, while open events store `url = NULL`. SQLite permits multiple unique-key rows when a component is `NULL`, so repeated opens can create duplicates and inflate counters.

**Required correction:** use separate partial unique indexes:

```sql
CREATE UNIQUE INDEX campaign_events_open_unique
ON campaign_events (campaign_id, person_id)
WHERE event_type = 'open';

CREATE UNIQUE INDEX campaign_events_click_unique
ON campaign_events (campaign_id, person_id, url)
WHERE event_type = 'click';
```

Test repeated opens and repeated clicks independently.

### 4. Newsletter subscribers do not fit the current `people` model

**Spec area:** List member creation and public subscription.

The current `people` table requires `lastEmailAt` and represents correspondents in inbox/person views. Importing thousands of subscribers with no message history can pollute those views and requires invented timestamps.

**Required decision:** choose one model before defining newsletter migrations:

1. Introduce a dedicated `contacts` table, linking to `people` only when message history exists; or
2. Redesign `people` to support contacts without messages (`lastEmailAt` nullable or an explicit contact state), and update existing queries/UI so cold contacts do not appear as conversations.

The dedicated `contacts` model is safer for long-term separation of CRM identity, conversation history, and marketing consent.

## High-Priority Findings

### 5. Aggregate counters are contentious and semantically inconsistent

**Spec area:** Campaign statistics and completion.

Every recipient mutating the same campaign row creates a D1 hot row. Counter equality is not a reliable completion signal under retries. `statsTotal` is shown as “Sent” despite including failed and suppressed recipients. `statsClicks` increments once per person per URL and can exceed the recipient count.

**Required correction:**

- Make `campaign_recipients` and `campaign_events` authoritative.
- Derive statistics on read or roll them up asynchronously.
- Separate `targeted`, `delivered`, `suppressed`, `failed`, `uniqueOpeners`, `uniqueClickers`, and `uniquePersonLinkClicks`.
- Use `delivered` as the engagement-rate denominator.
- Determine campaign completion from recipient terminal states, not mutable equality counters.

### 6. Subscribe rate limits do not count attempts

**Spec area:** Public subscribe abuse controls.

Counting `list_members.createdAt` cannot detect repeated confirmation sends because membership submission is an upsert. The IP limiter has the same issue for repeated submissions against one membership.

**Required correction:**

- Add an expiring `subscribe_attempts` ledger or dedicated rate-limit store.
- Key attempts by form, normalized email hash, and `CF-Connecting-IP`.
- Define retention and cleanup.
- Define request body-size limits.
- Define behavior for missing `Origin` and `Referer` headers.
- Apply route-specific CORS rather than relying on the app-wide wildcard policy.
- Consider Turnstile as an optional stronger anti-automation control.

### 7. Scheduling promises minute precision but executes hourly

**Spec area:** Campaign scheduling.

A campaign scheduled at 12:01 may not run until 13:00. The two-hour catch-up cutoff can silently abandon scheduled campaigns after a longer outage.

**Required correction:**

- Either advertise an hourly-window scheduling SLA, or use delayed Queue messages/a more frequent cron for minute-level execution.
- Never silently discard overdue campaigns.
- Leave them scheduled or move them into a visible `overdue`/`stalled` state requiring operator action.
- Test delayed cron execution and outages longer than two hours.

### 8. Campaign content is not snapshotted

**Spec area:** Campaign/template relationship.

A scheduled campaign references a mutable template by slug. Editing or deleting the template before dispatch changes what recipients receive, despite sent/scheduled campaigns being described as immutable.

**Required correction:** snapshot the following when a campaign leaves `draft`:

- Subject
- Rendered HTML and text base
- Sender identity
- Template revision or source snapshot
- User-defined variables/configuration

The queue consumer must render recipient-specific reserved variables against the immutable snapshot, not reread the mutable template.

### 9. Tracking tokens expose destination URLs and lack expiry

**Spec area:** Click tracking.

HMAC protects integrity, not confidentiality. Embedding full destination URLs can expose signed/passwordless query parameters through logs, browser history, and copied links. Reusing `UNSUBSCRIBE_SECRET` couples unrelated token domains.

**Required correction:**

- Store links server-side and sign an opaque `campaignLinkId`.
- Derive separate domain keys from the root secret or use distinct versioned secrets for subscribe, unsubscribe, open, and click tokens.
- Add token versioning and retention/expiry semantics.
- Permit only `http:` and `https:` redirect destinations.
- Add an explicit no-track marker/classification for unsubscribe and sensitive links.
- Do not identify unsubscribe links by checking for `{{unsubscribe_url}}` after interpolation; the placeholder no longer exists then.

### 10. Authorization requirements contradict each other

**Spec area:** Authorization matrix and Boundaries.

The matrix permits scoped members to create/edit lists and campaign drafts, while Boundaries says per-inbox campaign RBAC is deferred to v2.

**Recommended v1 rule:**

- Admins: unrestricted.
- Scoped members and member API keys: list/campaign reads and draft writes only for allowed `fromAddress` values.
- Send, schedule, cancel, and retry: admin or admin API key only.
- Subscribe-form administration: admin only.

Require route-level tests for sessions and API keys across allowed and forbidden inboxes.

### 11. Shared queue reuse can regress sequence delivery

**Spec area:** Queue architecture and Future Considerations.

A 10,000-recipient campaign can delay time-sensitive sequence traffic on the shared queue, conflicting with the requirement to preserve existing behavior.

**Required v1 mitigations if the shared queue remains:**

- Rate-limit fan-out pages.
- Use bounded `sendBatch()` calls.
- Explicitly acknowledge each processed message.
- Add a dead-letter queue or equivalent durable failure ledger.
- Monitor backlog age, delayed messages, and failures.
- Add a load test proving acceptable sequence latency during campaign fan-out.

A dedicated campaign queue remains the cleaner future isolation boundary.

### 12. Data lifecycle, consent, and unsubscribe recovery are underspecified

**Spec area:** Deletion, imports, unsubscribe, and privacy.

Hard-deleting lists conflicts with campaign audit history. Removing a member destroys consent provenance. IP addresses and engagement events have no retention policy. Old v2 tokens could re-subscribe recipients indefinitely.

**Required correction:**

- Archive lists that have campaigns rather than deleting them.
- Preserve membership/consent history with states instead of destructive removal.
- Store consent source, consent timestamp, import job, policy/version, and unsubscribe reason.
- Define retention periods for IP addresses, subscribe attempts, tracking events, and campaign ledger rows.
- Permit one-click undo only during a short window; later re-subscription must use a fresh opt-in flow.
- Define data export and erasure behavior.

## Additional Corrections

### Platform and repository accuracy

- The frontend uses React 19, not React 18.
- Tailwind is v4.
- Existing transactional sends do not receive unsubscribe tokens; `sendWithSuppressionCheck` omits `List-Unsubscribe` when `transactional === true`.
- `sendWithSuppressionCheck` currently creates v1 unsubscribe tokens internally. Add a campaign-specific token/context boundary so tracking and v2 unsubscribe behavior cannot leak into sequences, transactional sends, or template tests.

### CSV import/export

Define:

- Maximum bytes and rows
- UTF-8/BOM handling
- RFC 4180 quoting behavior
- Duplicate-email behavior within the same file
- Asynchronous progress and row-level error reporting
- Cancellation/restart semantics
- Formula-injection-safe exports (prefix cells beginning with `=`, `+`, `-`, or `@`)
- Consent provenance for imported contacts

A robust CSV parser may justify the spec’s “ask first before adding a dependency” path.

### Provider capacity and deliverability

Before entering `sending`, preflight the active provider’s known limits and configuration. Define behavior for provider rate limits, quotas, transient failures, permanent rejects, and unsupported provider idempotency.

The 10,000-member product cap does not imply that the selected provider can deliver 10,000 messages safely or legally.

### Campaign state machine

Add an explicit transition table for:

- `draft -> scheduled`
- `draft -> preparing`
- `scheduled -> preparing`
- `scheduled -> cancelled`
- `preparing -> sending`
- `preparing/sending -> stalled`
- `sending -> sent`
- `stalled -> sending` through retry

For every action, specify allowed caller role, idempotent replay behavior, and HTTP response for invalid states.

### Compliance and privacy

Define configuration and validation for:

- Sender identity and postal address/footer requirements
- Consent records and lawful-basis export
- Data erasure
- Retention controls
- Tracking disclosure and optional tracking disablement
- Regional requirements before enabling marketing sends

Open/click/IP data is personal data in many jurisdictions.

## Required Test Additions

Add mandatory tests for:

- Duplicate Queue redelivery
- Crash after provider success but before D1 finalization
- Outbox-backed transient retry and retry exhaustion
- Resumable fan-out cursor behavior
- Partial Queue `sendBatch()` failure
- D1 overloaded/transient errors
- Repeat open deduplication with `url = NULL`
- Unique clickers versus per-link click counts
- Template mutation after scheduling
- Provider-capacity preflight rejection
- Missing/mismatched `Origin` and `Referer`
- Subscribe abuse against an existing membership
- Oversized/malformed CSV and formula-safe export
- v1 global versus v2 per-list unsubscribe UI/API behavior
- Expired undo and fresh re-opt-in
- Campaign load while a sequence message is queued
- Every campaign state transition and forbidden transition

## Recommended Resolution Order

1. Decide `contacts` versus extending `people`.
2. Adopt the outbox as the campaign delivery authority.
3. Redesign fan-out and CSV import as resumable jobs.
4. Correct event uniqueness and statistics semantics.
5. Add content snapshots and a complete campaign state machine.
6. Resolve authorization contradictions.
7. Specify abuse prevention, token separation, privacy, and data retention.
8. Define shared-queue safeguards and provider-capacity behavior.
9. Update tests and success criteria before implementation begins.

## Current Cloudflare Constraints Used in This Review

Validated against Cloudflare documentation dated 2026-04-21:

- D1: 50 queries per Worker invocation on Free, 1,000 on Paid.
- D1: 100 maximum bound parameters per query.
- D1: single-threaded processing per database; overloaded errors are possible.
- Queues: at-least-once delivery with explicit per-message `ack()`/`retry()`.
- Queues: maximum consumer batch size 100.
- Queues: maximum `sendBatch()` size 100 messages or 256 KB total.
- Queues: default retries 3; failed messages are deleted unless a DLQ is configured.
- Queues: 15-minute consumer wall-clock limit.
- Queue messages: 128 KB maximum each.

---

## Second-Pass Review After Spec Revision

**Reviewed:** 2026-07-21  
**Revision status:** The spec incorporated the original 4 critical and 8 high-priority findings. This second pass checked whether those resolutions are implementable against the current repository, especially `worker/src/lib/outbox.ts`, `worker/src/db/outbox-emails.schema.ts`, `worker/src/lib/send.ts`, `worker/src/lib/sequence-processor.ts`, `worker/src/routers/send-router.ts`, and `migrations/README.md`.

**Verdict:** **Request changes.** The revised design is substantially stronger, but three critical and five high-priority implementation blockers remain. These are new findings introduced or exposed by the proposed resolutions; they do not invalidate the original review.

### New Critical Findings

#### 13. The current outbox cannot provide the claimed campaign crash recovery

**Spec area:** Campaign fan-out step 3, campaign-recipient state machine, and resolved Decision 7.

The revised spec says that calling the existing `sendViaOutbox(...)` makes a crash after provider acceptance but before campaign bookkeeping self-heal. The current helper does not provide that guarantee:

- `sendViaOutbox` deletes the outbox row immediately after provider success.
- The caller writes `sent_emails` and updates its owning record only after the helper returns.
- A crash after the outbox row is deleted but before campaign bookkeeping completes leaves no durable evidence of provider acceptance.
- `outbox_emails` has `sequenceEmailId` but no campaign-recipient correlation.
- `attemptOutboxRow` resolves `sent_emails` and optional sequence state only; it cannot resolve `campaign_recipients`.
- The sender abstraction has no provider-idempotency field. A stable `campaign_recipients.idempotencyKey` cannot be passed to providers without extending the interface and each supported provider.

This means the spec still has an ambiguous-delivery window and can resend after a crash.

**Required correction:**

- Extend `outbox_emails` with nullable `campaignRecipientId` and a unique index for non-null campaign recipient ids.
- Add an outbox state that represents “provider accepted, campaign bookkeeping pending”; do not delete a successful campaign outbox row until `sent_emails`, contact/person linking, and `campaign_recipients` terminalization complete.
- Teach outbox reconciliation to resolve campaign-recipient state as well as sequence state.
- Persist the campaign-specific unsubscribe URL/context required for retries (see Finding #14).
- Extend `SendEmailParams` with a provider-idempotency concept only where the provider genuinely supports it; document support per provider.
- If a provider call has an ambiguous outcome and the provider cannot confirm via idempotency or lookup, move the recipient to `unknown` and require manual reconciliation. Never auto-resend an ambiguous outcome.
- Update tests to crash precisely after provider success but before each bookkeeping step.

#### 14. Campaign sends still receive v1 global-unsubscribe links

**Spec area:** Per-list unsubscribe, campaign rendering, and the requirement to call `sendWithSuppressionCheck` with `transactional: false`.

The current `sendWithSuppressionCheck` implementation always creates its own v1 unsubscribe token for non-transactional sends. It then:

- interpolates or appends that v1 URL to the body;
- sets `List-Unsubscribe` to the v1 URL; and
- stores only the pre-helper body in the outbox, causing retries to regenerate a v1 token again.

Pre-rendering a v2 URL into campaign HTML does not fix this: the helper checks whether its newly generated v1 URL is present and appends a second unsubscribe footer when it is not. The resulting campaign can contain a v2 per-list body link but a v1 global footer/header.

**Required correction:**

- Add an explicit unsubscribe context to `SendInput`, such as a precomputed `unsubscribeUrl` or a typed token payload/version.
- When supplied, `sendWithSuppressionCheck` must use that URL for placeholder interpolation, fallback footer, `List-Unsubscribe`, and `List-Unsubscribe-Post`.
- Persist the same context or exact URL in `outbox_emails` so retries reproduce the campaign’s v2 behavior instead of falling back to v1.
- Keep the existing default v1 behavior unchanged for legacy non-transactional sends that do not provide campaign context.
- Add integration tests asserting that a campaign has exactly one unsubscribe URL and that body, HTML/text fallback, and headers all carry the same v2 token.

#### 15. Coordinator replay safety and recipient claiming remain racy

**Spec area:** Campaign fan-out coordinator and per-recipient queue handler.

Advancing the fan-out cursor after `sendBatch()` cannot make publication exactly-once. A coordinator may publish a page successfully and crash before advancing the cursor; retrying republishes the same page. That is expected with at-least-once systems and must be harmless.

Two additional issues remain:

- A unique constraint does not make a plain insert a no-op. Every `campaign_recipients` insert in a retried D1 batch must explicitly use conflict-ignore semantics.
- The proposed recipient handler reads status and then sets `processing`. Duplicate queue messages can both pass that read and call the provider.

**Required correction:**

- Use `onConflictDoNothing()` for every `campaign_recipients` insert in the coordinator batch.
- Treat queue publication as repeatable/ambiguous by design; do not claim cursor ordering makes it exactly-once.
- Atomically claim a recipient with a conditional write, for example:

```sql
UPDATE campaign_recipients
SET status = 'processing', attempts = attempts + 1
WHERE id = ? AND status = 'queued'
RETURNING id;
```

- Only the handler that receives the returned row may create/claim the outbox operation and call the provider.
- Enforce one unique campaign outbox row per `campaignRecipientId`.
- Define separate atomic claim rules for retryable states; do not let `failed`, `retrying`, or `processing` all enter the same send path through a read-then-write check.
- Add tests with concurrent duplicate queue messages and a crash after successful `sendBatch()` but before cursor advancement.

### New High-Priority Findings

#### 16. CSV import jobs have no durable storage or valid resume cursor

**Spec area:** `campaign_jobs` and asynchronous CSV import.

The revised spec says the upload is streamed “to storage,” but it does not define:

- the existing R2 binding as the storage target;
- an object key stored on the job;
- object ownership and cleanup;
- how queue invocations retrieve the upload;
- a parser-safe cursor; or
- a `cancelled` job state, despite exposing cancellation.

A CSV row-number cursor also requires reparsing from byte zero on every invocation. That becomes quadratic across many pages and is unsafe for multiline RFC 4180 records unless parser state or safe boundaries are persisted.

**Required correction:**

- Add `storageKey` to the import job, using an R2 object such as `imports/{jobId}.csv`.
- Add `cancelled` to the job-status enum and check it before processing/re-enqueuing every page.
- Define object cleanup after completion, cancellation, and terminal failure, with a short recovery retention window.
- Prefer parsing once into normalized R2 chunks or staged D1 rows, then process those durable chunks by cursor.
- If byte-range resumption is used instead, persist parser-safe byte offsets plus CSV parser state; row number alone is insufficient.
- Define how a cancelled/failed import can be inspected before its source object is deleted.

#### 17. Failed recipients are terminal and retryable at the same time

**Spec area:** Campaign completion query, status transition table, and stalled retry.

The completion query treats `failed` as terminal and can move a campaign to `sent`. The only retry route is `stalled -> sending`, while the retry description says failed recipients are re-enqueued. Once all recipients are terminal, a campaign containing failures becomes `sent`, so the advertised retry route is no longer available.

**Required correction:** choose one explicit model:

- Add `completed_with_failures` and permit `POST /retry` from that state; or
- Split recipient failures into `retryable_failed` and `permanent_failed`, and exclude retryable failures from campaign completion.

Recommended model:

- Campaign terminal states: `sent` (all delivered/suppressed) and `completed_with_failures` (at least one permanent failure).
- `POST /retry` is valid from `stalled` and `completed_with_failures`, but only for recipients explicitly classified as retryable.
- Permanent provider rejects remain terminal and are never retried automatically.
- The UI must display partial completion rather than labeling every terminal campaign “sent.”

#### 18. Unsubscribe attribution is not atomic or exactly-once

**Spec area:** v2 unsubscribe handler and `statsUnsubscribes`.

The proposed flow performs an “already unsubscribed?” read, membership update, and campaign-counter increment as separate logical steps. Concurrent one-click and browser requests can both pass the read and double-increment. A crash after membership update but before the counter increment undercounts.

**Required correction:**

- Add an unsubscribe-attribution ledger with a unique key such as `(campaignId, listMemberId)`.
- Verify that the token’s campaign belongs to the token’s list and that the member belongs to that list.
- Insert the unique attribution and update membership in one D1 batch/transactional unit.
- Derive or asynchronously roll up `statsUnsubscribes` from the attribution ledger instead of incrementing a mutable campaign counter directly.
- Repeat requests become safe no-ops through the unique attribution constraint.
- Define how later unsubscribes from a different campaign on an already-unsubscribed membership are treated; recommended: no new attribution after the first state transition.

#### 19. Migration numbering and workflow contradict repository conventions

**Spec area:** Codebase Validation, Commands, Project Structure, and migration note.

The revised spec now lists four migrations (`0031`–`0034`) but its validation section still says `0031`–`0033`. It also instructs implementation to run `yarn db:generate`, while `migrations/README.md` documents that Drizzle generation is currently broken because of an upstream snapshot collision. Migrations from `0021` onward are manually authored with a `_journal.json` entry.

There is also an ordering issue: `list_members.importJobId` references `campaign_jobs`, but `campaign_jobs` is introduced in a later campaigns migration.

**Required correction:**

- Update every migration reference to `0031`–`0034`.
- Remove `yarn db:generate` from this feature’s required workflow unless the existing snapshot collision is repaired first.
- Require hand-authored SQL plus an appended `migrations/meta/_journal.json` entry; do not add a snapshot file.
- Move the generic jobs table into an earlier migration before `list_members`, rename it to a domain-neutral name such as `async_jobs`, or remove the FK and document why.
- Validate migration application through `yarn db:migrate:dev`, a clean test database, type-checking, and tests.

#### 20. The coordinator’s 100-row D1 rationale is incorrect

**Spec area:** Fan-out coordinator page size and Cloudflare-limit explanation.

The D1 “100” limit is the maximum number of bound parameters per query, not a 100-statement batch limit. A 100-statement batch plus surrounding reads/updates also exceeds the Workers Free limit of 50 D1 queries per invocation.

Cloudflare Queue `sendBatch()` accepts up to 100 messages, but the producer entries must use the Queue API’s batch-entry shape. A rejected `sendBatch()` does not provide a reliable per-message success list, so “partial Queue batch failure” should be treated as ambiguous publication and resolved through recipient idempotency.

**Required correction:**

- State whether newsletter fan-out is Workers Paid-only.
- If Free is supported, select a page size from the complete invocation query budget, including job reads, recipient selection, inserts, cursor update, and campaign updates; a conservative page is likely 25–40 rather than 100.
- If Paid-only, 100-row pages may remain, but the spec must explain that this is an application chunk size aligned with Queue limits, not a D1 batch-statement limit.
- Show or reference the correct `sendBatch([{ body: message }, ...])` shape.
- Replace the “partial sendBatch failure” test with rejected/ambiguous publication followed by safe page replay.

### New Medium-Priority Findings

#### 21. Click totals and unique clickers cannot differ under the proposed event schema

**Spec area:** Click-event uniqueness and `GET /api/campaigns/:id/links`.

The partial unique index permits one click row per campaign/contact/link. Therefore, for a given URL, row count equals unique clicker count. The documented response with `clicks: 12` and `uniqueClickers: 9` cannot be produced from that schema.

**Required correction:** choose one metric model:

- **Unique-only v1 (recommended):** rename `clicks` to `uniqueClicks`, remove `uniqueClickers`, and document one counted click per contact/link; or
- **Raw + unique:** store raw click occurrences in an append-only event table and maintain a separate unique contact-link ledger for unique-clicker counts.

The unique-only model is simpler, cheaper on D1, and consistent with the existing dedup goal.

#### 22. Contact-to-person linking cites the wrong implementation precedent

**Spec area:** `contacts` linking rule and resolved Decision 6.

`sequence-processor.ts` does not create people during dispatch; sequence enrollment creates them earlier. The current race-safe find-or-create pattern is in `send-router.ts`, where required fields such as `lastEmailAt` are populated and the row is refetched after conflict-ignore insertion.

**Required correction:**

- Specify a shared race-safe `findOrCreatePersonByEmail` helper based on the existing send-router pattern.
- Define `lastEmailAt` for a first campaign delivery as the successful provider-delivery timestamp.
- Define whether and how `totalCount` changes for campaign sends.
- Ensure outbox reconciliation can invoke the same linking helper after delayed success.
- Make contact linking, `sent_emails` creation/update, and recipient terminalization part of the post-provider bookkeeping unit described in Finding #13.

#### 23. The v1 unsubscribe acceptance criterion is inaccurate

**Spec area:** Per-list unsubscribe acceptance criteria.

The spec says v1 tokens come from PR #95 transactional sends. The current `sendWithSuppressionCheck` deliberately omits unsubscribe handling when `transactional === true`.

**Required correction:** replace the criterion with:

> Existing v1 tokens from legacy non-transactional/marketing sends continue to perform global suppression without change.

#### 24. Privacy and retention remain deferred rather than future-proof

**Spec area:** Privacy & Retention.

Indefinite retention of IP addresses and engagement events, with no implemented erasure/export path, is a material operational and legal risk. The spec also claims admins can answer requests through “existing admin tooling,” but current tooling does not yet know about the new contacts/list/event tables.

**Required correction:**

- Define configurable retention values in v1, even if defaults are conservative.
- Suggested defaults: raw submitted IP 30 days, subscribe-attempt ledger 24 hours, engagement events 13 months, delivery/consent audit retained until list/contact erasure policy applies.
- Add a scheduled retention cleanup pass with bounded batches.
- Define an authenticated admin export/erasure operation or explicitly document a verified SQL/CLI operational procedure; do not cite nonexistent UI tooling.
- Clarify which records must be retained for suppression/consent evidence after erasure and whether emails are hashed or deleted.

## Second-Pass Resolution Order

Resolve these new findings in this order before implementation:

1. Redesign the outbox/campaign-recipient handshake and ambiguous-delivery behavior (Finding #13).
2. Add the campaign v2 unsubscribe override/context through initial send and outbox retry (Finding #14).
3. Specify atomic recipient claims and replay-safe coordinator behavior (Finding #15).
4. Complete the durable R2 import-job model and cancellation lifecycle (Finding #16).
5. Resolve campaign failure terminal states and retry transitions (Finding #17).
6. Add atomic unsubscribe attribution (Finding #18).
7. Correct migrations and generic job-table ordering (Finding #19).
8. Decide Free-versus-Paid support and set coordinator page size accordingly (Finding #20).
9. Simplify or expand click metrics consistently (Finding #21).
10. Correct contact/person linking and retention/erasure details (Findings #22–#24).

## Updated Implementation Gate

The following must be true before Phase 1 begins:

- [ ] The spec no longer claims the current `sendViaOutbox` helper already provides campaign crash recovery.
- [ ] The outbox schema and reconciliation contract include `campaignRecipientId` and post-provider bookkeeping.
- [ ] Campaign v2 unsubscribe context is persisted and reproduced on retries.
- [ ] Recipient claiming is a conditional atomic write, not a read-then-write check.
- [ ] Coordinator publication is explicitly replayable and every insert is conflict-safe.
- [ ] CSV jobs identify their R2 object/chunks and include cancellation/cleanup states.
- [ ] Campaign terminal failure and retry semantics are internally consistent.
- [ ] Unsubscribe attribution is backed by a unique ledger.
- [ ] Migration numbering/workflow matches `migrations/README.md`.
- [ ] Workers Free/Paid support and fan-out page size are explicit.
- [ ] Click metric names match what the schema can compute.
- [ ] Contact linking and privacy retention have implementable workflows.

## What the Revised Spec Successfully Resolved

The second pass found no remaining blocker in these original corrections:

- Dedicated `contacts` identity rather than bulk-creating `people`
- Partial unique indexes for open and click deduplication
- Immutable campaign content snapshots
- Explicit member/admin authorization rules
- Hourly scheduling SLA and visible overdue state
- Opaque server-side campaign links instead of destination URLs in tokens
- Subscribe-attempt ledger and route-specific abuse controls
- Consent provenance and archive-over-delete semantics
- Campaign completion derived from recipient state rather than aggregate-counter equality
- Resumable fan-out as the correct architectural direction
