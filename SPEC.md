# Spec: Newsletter Module

## Objective

Add newsletter/list-management capabilities to saasmail so operators can:

1. Manage **subscriber lists** (create lists, add/remove members, CSV import/export)
2. Collect subscribers via an **embeddable subscribe form** with optional double opt-in
3. Let recipients **unsubscribe per list** (not just globally) via a one-click link
4. Send **broadcast campaigns** (draft → schedule or send-now → delivered) with open/click tracking

**Target users:** saasmail admins who use the tool for both transactional email and marketing sends and currently have no built-in list or broadcast capability.

**Success looks like:** An admin can create a list, embed a signup form, import existing contacts, draft a campaign from an existing template, schedule it, and see delivery + engagement stats — all without leaving saasmail.

**Prerequisite (satisfied):** PR #95 (suppression list + `sendWithSuppressionCheck` + HMAC unsubscribe tokens) is **already merged into `main`**. The primitives this spec builds on now live at `worker/src/lib/suppressions.ts` (`isSuppressed`), `worker/src/lib/send.ts` (`sendWithSuppressionCheck`, per-recipient token + `List-Unsubscribe` injection on marketing sends), `worker/src/lib/unsubscribe-token.ts` (`signToken`/`verifyToken`), and `worker/src/routers/unsubscribe-router.ts`. See **Codebase Validation** below for the deltas this introduced against the original draft of this spec.

**Adversarial review (satisfied):** [`SPEC_ADVERSARIAL_REVIEW.md`](SPEC_ADVERSARIAL_REVIEW.md) (2026-07-21) raised 4 critical and 8 high-priority findings against the original draft — delivery idempotency, unsafe single-request fan-out, event-dedup NULL semantics, and the `people` vs. subscriber-identity model, among others. A **second-pass review** then checked the first revision's resolutions against the actual repository (`worker/src/lib/outbox.ts`, `worker/src/routers/send-router.ts`, `migrations/README.md`) and found 3 new critical and 8 new high/medium findings (#13–#24) — mostly implementation blockers exposed by the first revision's own fixes (the outbox doesn't yet correlate to campaign recipients, `sendWithSuppressionCheck` always mints its own v1 token, migrations are hand-authored not `drizzle-kit generate`d, etc.). Every finding from both passes is resolved directly in this revision. Findings are cited inline as `(Finding #n)`.

---

## Codebase Validation (2026-07)

This spec was validated against `main` after several months of upstream drift. Corrections applied:

- **PR #95 is merged** — the prerequisite is satisfied; the file paths above are current.
- **Migrations renumbered** — the tree already contains migrations through `0030_outbox_emails.sql`, so the new migrations are `0031`–`0034` (was `0027`–`0029` in the original draft; corrected once more per Finding #19 after the first revision's Codebase Validation note and Project Structure disagreed on whether it was `0031`–`0033` or `0031`–`0034`).
- **Migrations are hand-authored, not `drizzle-kit generate`d (Finding #19)** — `migrations/README.md` documents that `drizzle-kit generate` currently errors on an upstream `0019`/`0020` snapshot collision predating this feature. Every migration from `0021` onward — and therefore every migration this spec adds — is a hand-written `.sql` file plus a manually appended `migrations/meta/_journal.json` entry (`idx`, `version: "6"`, `when`, `tag`, `breakpoints: true`). **Do not run `yarn db:generate` as part of this feature's workflow**; validate exclusively through `yarn db:migrate:dev` against a clean local D1, followed by `yarn tsc --noEmit` and `yarn test`.
- **Commands corrected** — there is no `yarn worker:dev` / `yarn build:worker`. The Worker is served by `@cloudflare/vite-plugin` inside `yarn dev`; local migrations use `yarn db:migrate:dev`.
- **Token payload shape** — `unsubscribe-token.ts` signs `{ e, v: 1 }` (the email is the `e` field, lowercased). `verifyToken` currently hard-rejects any `v !== 1`, so v2 support requires branching in both `signToken` and `verifyToken` — see §3.
- **`sendWithSuppressionCheck` always mints its own v1 unsubscribe token (Finding #14)** — for non-transactional sends it unconditionally calls `signToken(recipient.email, env.UNSUBSCRIBE_SECRET)` and uses that URL for placeholder interpolation, the footer fallback, and both `List-Unsubscribe` headers. Campaign sends need their own precomputed v2 URL used in all of those places instead — see §3 and the Fan-out mechanism in §4.
- **Contact/person linking precedent (Finding #22)** — the existing race-safe find-or-create pattern lives in `worker/src/routers/send-router.ts` (select by email → `insert(people).values({..., lastEmailAt: now}).onConflictDoNothing({ target: people.email })` → re-select), not in `sequence-processor.ts` (which only reads an already-existing `personId` from the enrollment row). Campaign contact-linking must reuse this exact pattern, extracted into a shared `findOrCreatePersonByEmail` helper.
- **R2 binding** — the existing `env.R2` binding (used today for `sent_emails`/`attachments` blobs, see `worker/src/lib/delete-email.ts`) is the storage target for CSV import uploads (Finding #16); no new binding is required.
- **Queue reuse** — the only queue binding is `EMAIL_QUEUE` (`saasmail-sequence-emails`, `max_batch_size: 10`, `max_retries: 3`) with a message typed `SequenceEmailMessage`. Campaign fan-out reuses this queue via a discriminated-union message; `handleQueueBatch` branches on message type. A second queue is possible but is a wrangler infra change (Boundaries → "Ask first").
- **Cron reuse** — the hourly trigger (`0 * * * *`) is wired in `index.ts`'s `scheduled()`, which runs `handleScheduled` then `processOutbox`. Campaign scheduled-send + stalled-recovery hook into this same handler.
- **Frontend data-fetching** — `@tanstack/react-query` is installed and `QueryClientProvider` wraps the app, but every existing page (e.g. `AdminUsersPage`) still uses `useState` + `useEffect` + imperative `fetch`. New pages follow that imperative pattern.
- **Public routing** — session/passkey middleware is scoped to `app.use("/api/*", …)`. Public token routes therefore mount outside `/api` (the `unsubscribe-router` is dual-mounted at `/api/unsubscribe` and `/unsubscribe`) or are added to `isUnauthenticatedPath`. New public routers (`/subscribe`, `/track`) follow the non-`/api` precedent.

---

## Tech Stack

No new dependencies unless unavoidable.

| Layer | Technology |
|---|---|
| Runtime | Cloudflare Workers + Hono + `@hono/zod-openapi` |
| Database | Cloudflare D1 (SQLite via Drizzle ORM) |
| Queue | Cloudflare Queues (campaign fan-out) |
| Cron | Cloudflare Cron Trigger — hourly, already wired |
| Frontend | React 19 + Tailwind CSS v4 + Radix Dialog (existing stack) |
| Testing | Vitest (unit + integration), Playwright (e2e) |
| ORM | Drizzle ORM — schema-first, migrations via `drizzle-kit` |

---

## Commands

```bash
# Development — single Vite process; @cloudflare/vite-plugin runs the Worker too
yarn dev                          # Vite dev server + Worker (no separate backend cmd)

# Build — Vite build emits the client bundle and the Worker
yarn build

# Type-check (run before every commit)
yarn tsc --noEmit

# Tests
yarn test                         # Vitest unit + integration (vitest.config.test.ts)
yarn test:e2e                     # wipe e2e DB + Playwright

# Database
yarn db:migrate:dev               # wrangler d1 migrations apply --local (hand-authored SQL — see Codebase Validation; do NOT run drizzle-kit generate)
yarn db:seed:dev                  # seed dev database

# Secrets
wrangler secret put UNSUBSCRIBE_SECRET   # provided by PR #95 (already in main)
```

---

## Project Structure

New files are marked with `(new)`. Existing files that will be modified are marked `(modified)`.

```
worker/src/
  db/
    async-jobs.schema.ts           (new)  — async_jobs (resumable fan-out/import cursor; domain-neutral
                                          per Finding #19, referenced by list_members before campaigns exist)
    contacts.schema.ts             (new)  — contacts table (subscriber identity; not `people`)
    lists.schema.ts                (new)  — lists table
    list-members.schema.ts         (new)  — list_members table
    subscribe-forms.schema.ts      (new)  — subscribe_forms table
    subscribe-attempts.schema.ts   (new)  — subscribe_attempts (abuse-rate ledger)
    campaigns.schema.ts            (new)  — campaigns table
    campaign-events.schema.ts      (new)  — campaign_events (opens + clicks, partial unique indexes)
    campaign-recipients.schema.ts  (new)  — campaign_recipients (delivery ledger)
    campaign-links.schema.ts       (new)  — campaign_links (opaque click-token URL store)
    campaign-unsubscribe-attributions.schema.ts (new) — atomic per-campaign unsubscribe ledger
    outbox-emails.schema.ts        (modified) — add `campaignRecipientId` correlation (Finding #13)
    schema.ts                      (modified) — re-export new tables
  lib/
    subscribe-token.ts             (new)  — HMAC tokens for double opt-in confirm (own domain key)
    campaign-sender.ts             (new)  — resumable fan-out coordinator (cursor-paged, outbox-backed)
    list-import.ts                 (new)  — resumable CSV import job (cursor-paged)
    track-token.ts                 (new)  — HMAC tokens for open/click tracking (own domain key)
    send.ts                        (modified) — extend sendWithSuppressionCheck to
                                              inject tracking pixels + rewrite links
    unsubscribe-token.ts           (modified) — add list_id to v2 token payload
  routers/
    lists-router.ts                (new)  — CRUD lists + member management + async import/export
    subscribe-forms-router.ts      (new)  — CRUD subscribe forms
    campaigns-router.ts            (new)  — CRUD campaigns + send/schedule
    public-subscribe-router.ts     (new)  — public POST /subscribe/:form_id (no auth)
    public-track-router.ts         (new)  — public GET /track/open/:t /track/click/:t
    unsubscribe-router.ts          (modified) — handle per-list unsubscribe in v2 tokens
  index.ts                         (modified) — mount new routers

src/
  pages/
    ListsPage.tsx                  (new)
    ListDetailPage.tsx             (new)
    CampaignsPage.tsx              (new)
    CampaignDetailPage.tsx         (new)
    SubscribeFormsPage.tsx         (new)
    SubscribeFormBuilderPage.tsx   (new)
  components/
    CampaignStatsCard.tsx          (new)
    ListMembersTable.tsx           (new)
    FormSnippet.tsx                (new)   — copy-paste embed code
  lib/
    api.ts                         (modified) — add fetch helpers for new routes

migrations/
  0031_newsletter_async_jobs.sql   (new)  — async_jobs (must precede list_members: list_members.importJobId
                                          references it — Finding #19 ordering fix)
  0032_newsletter_contacts.sql     (new)  — contacts
  0033_newsletter_lists.sql        (new)  — lists + list_members
  0034_newsletter_forms.sql        (new)  — subscribe_forms + subscribe_attempts
  0035_newsletter_campaigns.sql    (new)  — campaigns + campaign_events (partial unique indexes) +
                                          campaign_recipients + campaign_links +
                                          campaign_unsubscribe_attributions + sent_emails(campaignId)
  0036_outbox_campaign_recipient.sql (new) — outbox_emails.campaignRecipientId + unique index (Finding #13)
```

> **Migration numbering:** `main` already ships migrations through `0030_outbox_emails.sql`; every migration above is **hand-authored SQL with a manually appended `migrations/meta/_journal.json` entry** — `drizzle-kit generate` is broken on this repo (see Codebase Validation, Finding #19) and is not part of this feature's workflow. Confirm the next free prefix against `migrations/meta/_journal.json` before committing (they must not collide with existing files or with each other if landed out of order). File counts above are illustrative — `campaign_events`'s partial unique indexes and the `outbox_emails` alteration must be raw SQL regardless, since Drizzle's schema DSL cannot express a `WHERE` clause on a unique index or a column addition to an existing hand-authored table.

---

## Database Schema

> Every table below is the **corrected** version — see inline `(Finding #n)` citations to [`SPEC_ADVERSARIAL_REVIEW.md`](SPEC_ADVERSARIAL_REVIEW.md), including its second-pass findings (#13+).

### `contacts` (new — resolves Finding #4)

Newsletter subscriber identity, decoupled from `people` (the existing inbox/CRM correspondent, which requires `lastEmailAt notNull` and drives conversation views). Bulk-importing thousands of subscribers into `contacts` never pollutes `people` or the inbox.

```ts
{
  id: text primaryKey,
  email: text notNull unique,
  name: text,
  personId: text,                     // FK people.id — NULL until real message history exists
  createdAt: integer notNull,
  updatedAt: integer notNull,
}
```

**Linking rule (corrected — Finding #22):** `personId` stays `NULL` through import, form submission, and confirmation. It is populated **lazily on the first successful campaign send**, via a shared `findOrCreatePersonByEmail(db, email, now)` helper that is a straight extraction of the existing race-safe pattern already used in `worker/src/routers/send-router.ts` — select by email; if absent, `insert(people).values({ id: nanoid(), email, name: null, lastEmailAt: now, unreadCount: 0, totalCount: 0, createdAt: now, updatedAt: now }).onConflictDoNothing({ target: people.email })`; then re-select to get the winning row's id (handles the concurrent-insert race). This is **not** the same precedent as `sequence-processor.ts`, which only reads an already-existing `personId` off the enrollment row and never creates one — the first draft cited the wrong file. `lastEmailAt` for a first campaign delivery is the successful provider-delivery timestamp (same meaning `sendViaOutbox`/`send-router.ts` already give it), not the campaign's `sentAt`. `totalCount` is incremented the same way an existing transactional/sequence send would increment it (i.e. treat a campaign send exactly like any other outbound send for `people` bookkeeping purposes — no new counter semantics). The same helper must be callable from **both** the initial `campaign_send` handler and outbox retry reconciliation (Finding #13), so a person created by a delayed retry is linked identically to one created by the inline path.

`sent_emails.personId` is already nullable in the existing schema, so no migration is required there — only the lazy-link write path (via the shared helper) is new.

### `lists`
```ts
{
  id: text primaryKey,
  name: text notNull,
  description: text,
  fromAddress: text notNull,          // sender identity (FK to sender_identities)
  doubleOptIn: integer notNull default 0,
  confirmationTemplateSlug: text,     // template used for opt-in confirmation email
  archivedAt: integer,                // set instead of deleting once a list has campaign history (Finding #12)
  createdAt: integer notNull,
  updatedAt: integer notNull,
}
```

### `list_members` (references `contacts`, adds consent provenance — Finding #12)
```ts
{
  id: text primaryKey,
  listId: text notNull,               // FK lists.id
  contactId: text notNull,            // FK contacts.id (not personId — see contacts table above)
  email: text notNull,                // denormalized for fast suppression lookup
  status: text notNull default 'pending',  // pending | subscribed | unsubscribed
  source: text notNull,               // form | api | import
  formId: text,                       // FK subscribe_forms.id — null if source != 'form'
  submittedIp: text,                  // IP at form submission time (rate-limit audit)
  consentSource: text notNull,        // form | api | import — provenance for compliance/export
  consentAt: integer,                 // when consent was captured (submit time / import job time)
  importJobId: text,                  // FK async_jobs.id — set when source = 'import' (renamed from
                                       // campaign_jobs; see async_jobs below — Finding #19)
  subscribedAt: integer,
  confirmedAt: integer,               // double opt-in confirmation timestamp
  unsubscribedAt: integer,
  unsubscribeReason: text,            // optional, captured from one-click/preference actions
  createdAt: integer notNull,
  // unique(listId, contactId)
}
```

Removing a member is a **status change** (`unsubscribed`), never a row delete — this preserves consent/provenance history (Finding #12). A hard delete is only available via a separate, explicitly-audited erasure endpoint (see Privacy & Retention below).

### `subscribe_forms`
```ts
{
  id: text primaryKey,
  listId: text notNull,               // FK lists.id
  name: text notNull,
  showNameField: integer notNull default 1,
  nameRequired: integer notNull default 0,
  successMessage: text notNull default 'Thanks for subscribing!',
  redirectUrl: text,                  // optional redirect after submit
  allowedOrigins: text,               // optional comma-separated origins; if set, rejects others (fail closed — see §2)
  createdAt: integer notNull,
  updatedAt: integer notNull,
}
```

### `subscribe_attempts` (new — resolves Finding #6)

An expiring rate-limit ledger. Counting `list_members.createdAt` cannot detect repeated attempts against an existing membership because submission is an upsert; this table counts every attempt independently of whether it changed a row.

```ts
{
  id: text primaryKey,
  formId: text notNull,               // FK subscribe_forms.id
  emailHash: text notNull,            // SHA-256(lowercased email) — avoid raw email in a high-write ledger
  ip: text notNull,                   // CF-Connecting-IP
  attemptType: text notNull,          // submission | confirmation_resend
  createdAt: integer notNull,
}
// index (formId, emailHash, createdAt), index (ip, createdAt)
```

**Retention:** rows older than 24 hours are deleted by the existing hourly cron pass — the ledger only needs to answer "how many attempts in the last hour," so nothing is retained longer than the widest rate-limit window plus a safety margin.

### `campaigns` (stats model corrected — Finding #5; snapshot fields added — Finding #8; resumable cursor — Finding #2; failure/completion states corrected — Finding #17)
```ts
{
  id: text primaryKey,
  name: text notNull,
  subject: text notNull,              // draft-editable only; frozen into subjectSnapshot on leaving draft
  templateSlug: text notNull,         // source template reference, used while status = 'draft'
  fromAddress: text notNull,
  listId: text notNull,               // FK lists.id
  status: text notNull default 'draft',  // draft | scheduled | overdue | preparing | sending | sent |
                                       // completed_with_failures | cancelled | stalled
  scheduledAt: integer,               // unix epoch; null = send immediately on trigger

  // --- content snapshot (Finding #8): set once, when status leaves 'draft'; immutable after ---
  contentSnapshotAt: integer,
  subjectSnapshot: text,
  htmlSnapshot: text,                 // rendered base HTML (pre per-recipient reserved variables)
  textSnapshot: text,
  fromAddressSnapshot: text,
  templateRevisionId: text,           // opaque pointer to the template source at snapshot time
  unsubscribeDomainKeyVersion: integer notNull default 1,  // which token-domain key generation signed
                                       // this campaign's v2 links (Finding #14/#9) — lets a future key
                                       // rotation still verify tokens issued by in-flight campaigns

  // --- resumable fan-out (Finding #2) ---
  fanOutCursor: text,                 // last processed list_members.id; null when fan-out hasn't started
  fanOutJobId: text,                  // FK async_jobs.id (renamed from campaign_jobs — Finding #19)

  sentAt: integer,

  // --- stats: statsTargeted is authoritative (set once at fan-out start); everything else, INCLUDING
  // statsUnsubscribes, is an advisory cache refreshed asynchronously by the hourly cron rollup or
  // computed live on read — NEVER read for correctness decisions such as completion (Finding #5).
  // Completion is derived from campaign_recipients terminal-state counts; see "Fan-out send
  // mechanism" step 3. statsUnsubscribes is no longer a directly-incremented transactional counter
  // (that was itself racy — Finding #18); it is derived from the campaign_unsubscribe_attributions
  // ledger below, same treatment as every other stat.
  statsTargeted: integer notNull default 0,
  statsDelivered: integer notNull default 0,
  statsSuppressed: integer notNull default 0,
  statsRetryableFailed: integer notNull default 0,   // renamed from statsFailed (Finding #17)
  statsPermanentFailed: integer notNull default 0,   // renamed from statsFailed (Finding #17)
  statsUniqueOpeners: integer notNull default 0,
  statsUniqueClicks: integer notNull default 0,      // renamed from statsUniqueClickers (Finding #21 —
                                       // the event schema can only ever produce one click row per
                                       // contact per link, so "clicks" and "unique clickers" are the
                                       // same number; there is exactly one metric, not two)
  statsUnsubscribes: integer notNull default 0,

  createdAt: integer notNull,
  updatedAt: integer notNull,
}
```

### `campaign_events` (partial unique indexes — resolves Finding #3; unique-click model — resolves Finding #21; references `contacts` + `campaign_links`)

The original single composite `unique(campaignId, personId, eventType, url)` fails for opens because SQLite allows multiple rows when a unique-index component is `NULL`, and open rows have `url = NULL`. Two partial unique indexes replace it — one per event type, each on the columns that are always non-null for that type.

**Unique-only click model (Finding #21):** the click partial unique index is `(campaign_id, contact_id, campaign_link_id)` — at most **one** click row can ever exist per contact per link per campaign. This means "click count" and "unique clicker count" are mathematically the same number under this schema; the spec no longer claims to produce two different numbers (`clicks: 12` vs. `uniqueClickers: 9` from the first revision was not achievable and has been removed). If raw (non-deduplicated) click occurrence counts are wanted later, that requires a second append-only event table — Future Considerations, not v1.

```ts
{
  id: text primaryKey,
  campaignId: text notNull,
  contactId: text notNull,
  email: text notNull,
  eventType: text notNull,            // open | click
  campaignLinkId: text,               // FK campaign_links.id — null for opens (Finding #9: no raw URL here)
  occurredAt: integer notNull,
}
```

```sql
-- hand-written in the campaigns migration; Drizzle's schema DSL cannot express a WHERE clause
-- on a unique index, so this is raw SQL, not generated from the Drizzle table definition.
CREATE UNIQUE INDEX campaign_events_open_unique
  ON campaign_events (campaign_id, contact_id)
  WHERE event_type = 'open';

CREATE UNIQUE INDEX campaign_events_click_unique
  ON campaign_events (campaign_id, contact_id, campaign_link_id)
  WHERE event_type = 'click';
```

### `campaign_links` (new — resolves Finding #9)

Click tokens must not carry the destination URL: HMAC protects integrity, not confidentiality, and full URLs (which may themselves carry signed/passwordless query parameters) would leak through logs, browser history, and copy-pasted links. Destination URLs are stored server-side and referenced by an opaque id.

```ts
{
  id: text primaryKey,
  campaignId: text notNull,           // FK campaigns.id
  url: text notNull,                  // validated http(s):// only at write time
  createdAt: integer notNull,
  // unique(campaignId, url) — the same URL reused by multiple recipients maps to one row
}
```

### `campaign_recipients` (references `contacts`; adds idempotency + crash-recovery states — resolves Finding #1; atomic claim — resolves Finding #15; split failure states — resolves Finding #17)

Per-recipient delivery ledger. Enables accurate stalled-retry targeting, an auditable record of who was sent (or skipped), and — critically — the state machine that makes delivery **at-least-once with duplicate suppression** rather than a racy pre-send check.

```ts
{
  id: text primaryKey,
  campaignId: text notNull,           // FK campaigns.id
  contactId: text notNull,            // FK contacts.id
  email: text notNull,
  status: text notNull default 'queued',  // queued | processing | sent | suppressed | retrying |
                                       // retryable_failed | permanent_failed | unknown
  idempotencyKey: text notNull,       // stable `${campaignId}:${contactId}`; passed to the provider where it supports one
  outboxId: text,                     // set while a send attempt is in flight via worker/src/lib/outbox.ts
  sentEmailId: text,                  // FK sent_emails.id — null until transport succeeds
  attempts: integer notNull default 0,
  lastError: text,
  queuedAt: integer notNull,
  processedAt: integer,
  // unique(campaignId, contactId)
}
```

**Insert semantics (Finding #15):** the coordinator's page insert must use `db.insert(campaignRecipients).values([...page]).onConflictDoNothing({ target: [campaignRecipients.campaignId, campaignRecipients.contactId] })` — a unique index alone does not make a retried plain `INSERT` succeed as a no-op; it makes the *statement* fail unless conflict resolution is specified. Without `onConflictDoNothing`, a replayed coordinator page throws on every retry.

**Atomic claim (Finding #15):** the per-recipient `campaign_send` handler must not read `status` and then separately write `processing` — two duplicate queue deliveries can both pass a read-then-write check before either writes. The claim is one conditional `UPDATE`:

```sql
UPDATE campaign_recipients
SET status = 'processing', attempts = attempts + 1
WHERE id = ? AND status IN ('queued', 'retrying', 'retryable_failed')
RETURNING id;
```

Only the invocation that gets a row back from `RETURNING` may create the outbox row and call the provider; every other concurrent/duplicate delivery of the same message sees zero rows returned and acks without sending. `retryable_failed` is included in the claimable set because `POST /retry` re-enqueues those rows — the same atomic claim covers both the original send path and manual retry.

**States (corrected — Finding #17):** `queued` (enumerated by fan-out, not yet attempted) → `processing` (claimed, outbox row written, provider call in flight) → one of:
- `sent` / `suppressed` — terminal, successful
- `retrying` — transient provider failure, outbox will redeliver automatically via the existing hourly retry processor (exactly like sequence emails)
- `retryable_failed` — the outbox exhausted `MAX_OUTBOX_ATTEMPTS` retries on a **transient** classification (per `worker/src/lib/email-sender/classify.ts`); terminal to automatic retry, but eligible for a manual `POST /retry`
- `permanent_failed` — the provider returned a non-transient rejection (e.g. invalid recipient); terminal, **never** retried, automatically or manually
- `unknown` — a crash was detected mid-attempt and the outcome could not be confirmed (see Fan-out mechanism step 3); requires operator reconciliation before any further action, and is **not** eligible for automatic completion, automatic retry, or manual `POST /retry` until reconciled

A campaign's completion check (Fan-out mechanism step 3) treats `sent`/`suppressed`/`permanent_failed` as terminal-for-completion-purposes and `queued`/`processing`/`retrying`/`retryable_failed`/`unknown` as still-in-flight — see the campaign state machine in §4 for how this maps to `sent` vs. `completed_with_failures`.

### `campaign_unsubscribe_attributions` (new — resolves Finding #18)

Unsubscribe attribution (which campaign gets credited with a `list_members` unsubscribe) was previously a read-then-increment on `campaigns.statsUnsubscribes`, which is racy under concurrent one-click + browser requests and undercounts on a crash between the membership update and the counter increment. This table makes attribution an idempotent, uniquely-keyed insert instead of a mutable counter increment.

```ts
{
  id: text primaryKey,
  campaignId: text notNull,           // FK campaigns.id
  listMemberId: text notNull,         // FK list_members.id
  occurredAt: integer notNull,
  // unique(campaignId, listMemberId)
}
```

**Unsubscribe handler (revised):** verify the v2 token → verify the token's `campaign_id` actually belongs to the token's `list_id` (reject otherwise — a cross-campaign/cross-list token is invalid, not just unusual) → look up the `list_members` row for `(listId, token's contactId)` → in one D1 batch: `INSERT INTO campaign_unsubscribe_attributions (...) ON CONFLICT (campaign_id, list_member_id) DO NOTHING` **and** `UPDATE list_members SET status = 'unsubscribed', unsubscribed_at = ? WHERE id = ? AND status != 'unsubscribed'`. Both statements are safe to repeat: the attribution insert becomes a no-op on replay, and the membership update's `WHERE status != 'unsubscribed'` guard makes it a no-op once the member is already unsubscribed. `campaigns.statsUnsubscribes` is derived from `COUNT(*) FROM campaign_unsubscribe_attributions WHERE campaign_id = ?` — computed live on the campaign detail page read (same treatment as the links/timeseries endpoints), not incremented directly.

### `async_jobs` (renamed from `campaign_jobs` — resolves Finding #19; adds R2 storage + cancellation — resolves Finding #16)

A durable, resumable job record. Both campaign fan-out and CSV import become cursor-paged jobs instead of one all-in-one-request operation — required because a 10,000-recipient fan-out cannot safely run inside one HTTP request (D1 caps queries per invocation, and Cloudflare Queues caps `sendBatch()` at 100 messages / 256 KB). Named domain-neutrally (not `campaign_jobs`) because `list_members.importJobId` must reference it and the CSV-import migration necessarily lands **before** the campaigns migration in the numbering — a `campaign_`-prefixed table referenced from a pre-campaigns migration was a self-contradictory ordering in the first revision.

```ts
{
  id: text primaryKey,
  jobType: text notNull,               // campaign_fan_out | list_import
  refId: text notNull,                 // campaignId or listId
  status: text notNull default 'running',  // running | completed | failed | cancelled
  cursor: text,                        // last processed list_members.id (fan-out); see storageKey below for import
  storageKey: text,                    // list_import only — R2 object key on the existing `env.R2` binding,
                                        // e.g. `imports/{jobId}.csv`; NULL for campaign_fan_out jobs
  totalRows: integer,                  // list_import only — total CSV rows, for progress %
  processedRows: integer notNull default 0,
  importedCount: integer notNull default 0,
  skippedCount: integer notNull default 0,
  errorSummary: text,                  // JSON array of {row, reason}, capped (e.g. first 50)
  createdAt: integer notNull,
  updatedAt: integer notNull,
}
```

**CSV import durability (Finding #16):** the upload is written once to `env.R2` at `storageKey` before the job row is created. The first coordinator invocation parses the R2 object **once** into normalized staged rows (either additional small R2 chunk objects or directly into `list_members`-adjacent staging rows keyed by row number) rather than re-parsing from byte zero on every page — a plain CSV row-number cursor would require full re-parse per page and is unsafe across multiline RFC 4180 records unless a parser-safe boundary is persisted. `cursor` after staging refers to the staged-row cursor, not a raw byte offset. `status = 'cancelled'` is checked before every re-enqueue of the next coordinator page, and before the terminal cleanup step. The R2 object at `storageKey` is deleted after the job reaches `completed`, `cancelled`, or `failed`, with a short (24h) recovery-retention window before deletion so a cancelled/failed import can still be inspected.

### `outbox_emails` extension (resolves Finding #13)

The existing write-ahead outbox (`worker/src/db/outbox-emails.schema.ts`) deletes its row immediately on provider success, before the caller's own bookkeeping (its `sent_emails` write, and for campaigns, `campaign_recipients` terminalization and `contacts.personId` linking) has run. A crash in that window leaves no durable evidence that the provider already accepted the message, which is exactly the ambiguous-delivery gap Finding #1 was meant to close. Two changes are required to the existing table (hand-authored migration, addColumn-only per Boundaries):

```ts
  campaignRecipientId: text,   // nullable; FK campaign_recipients.id — set for campaign sends,
                                // null for sequence/transactional sends (mirrors sequenceEmailId)
  // unique(campaignRecipientId) WHERE campaignRecipientId IS NOT NULL — at most one in-flight
  // outbox row per recipient, enforced the same way the partial unique indexes above are (raw SQL)
```

**Resolution semantics (revised):** `sendViaOutbox` must not delete a **campaign** outbox row purely on provider-call success. Instead, on provider success it transitions the row to a `bookkeeping_pending` status (a new value alongside the existing `pending`/`failed`) and returns control to the caller; the caller (the `campaign_send` handler) then writes `sent_emails`, links `contacts.personId` via `findOrCreatePersonByEmail`, and terminalizes `campaign_recipients.status = 'sent'` — only after all of that succeeds does the caller delete the outbox row. If the caller crashes with the row still `bookkeeping_pending`, the existing hourly `processOutbox()`/`attemptOutboxRow()` sweep resolves it **not** by re-calling the provider (that would duplicate the send) but by re-running just the bookkeeping steps against the already-confirmed `send.result`, using `campaignRecipientId` to locate the right `campaign_recipients` row — this is the "reconcile, don't resend" path the recipient-handler idempotency check (in `campaign_recipients`, above) already assumes exists. Sequence and transactional sends are unaffected: they have no post-outbox bookkeeping step beyond the existing `sent_emails` update, so `bookkeeping_pending` is only ever used when `campaignRecipientId` is set.

### `sent_emails` extension
The existing `sent_emails` table gains one nullable column in the campaigns migration:

```ts
  campaignId: text,   // FK campaigns.id — null for non-campaign sends
```

`sent_emails.personId` is already nullable in the current schema — no change needed there. This ensures every campaign send appears in the person's existing email timeline with no new query logic, preserving saasmail's person-first product promise, once `contacts.personId` has been lazily linked via `findOrCreatePersonByEmail` (see `contacts` above).

---

## Feature Specifications


### 1. Contact List Management

**API — authenticated (admin + member scoped to allowed inboxes):**

| Method | Path | Description |
|---|---|---|
| GET | `/api/lists` | List all lists (paginated) |
| POST | `/api/lists` | Create list |
| GET | `/api/lists/:id` | Get list detail + member stats |
| PATCH | `/api/lists/:id` | Update list settings |
| DELETE | `/api/lists/:id` | Archive list (see below — never a hard delete once campaigns exist) |
| GET | `/api/lists/:id/members` | List members (paginated, filterable by status) |
| POST | `/api/lists/:id/members` | Add single member (email + name) |
| DELETE | `/api/lists/:id/members/:memberId` | Unsubscribe member (status change, not a row delete — Finding #12) |
| POST | `/api/lists/:id/members/import` | Start async CSV import job (multipart) — returns 202 `{ jobId }` |
| GET | `/api/lists/:id/members/import/:jobId` | Import job progress/result |
| DELETE | `/api/lists/:id/members/import/:jobId` | Cancel a running import job |
| GET | `/api/lists/:id/members/export` | CSV export (query `?status=subscribed`), streamed |

**`DELETE /api/lists/:id` semantics (Finding #12):** if the list has zero campaigns, hard-delete (cascades members). If the list has any campaign history, set `archivedAt` instead — archived lists are hidden from the default list view, cannot receive new campaigns or form submissions, but remain readable for campaign audit history. Returns 200 either way; the response body indicates which path was taken.

**CSV import — resumable job, not a single request (Finding #2); durable R2-backed storage (Finding #16):**
- `POST /api/lists/:id/members/import` streams the uploaded file to `env.R2` at `storageKey: imports/{jobId}.csv` (the existing R2 binding — no new binding required), creates an `async_jobs` row (`jobType: 'list_import'`, `status: 'running'`, `storageKey` set), enqueues a coordinator message, and returns immediately with 202 `{ jobId }`
- The **first** coordinator invocation parses the R2 object once into staged rows (row-number cursor thereafter refers to staged rows, not a raw byte offset — a byte-offset cursor is unsafe across multiline RFC 4180 records unless parser state is persisted, which staging avoids); subsequent invocations page through the staged rows, matching campaign fan-out's cursor-paging shape (§4)
- Every re-enqueue of the next coordinator page first checks `async_jobs.status != 'cancelled'` and stops if so
- Required column: `email`; optional: `name`
- **Limits:** max 10 MB file size, max 10,000 rows (matches the list size cap), UTF-8 with or without BOM (BOM is stripped), RFC 4180 quoting/escaping
- **Duplicate emails within the same file:** first occurrence wins; later duplicate rows are counted in `skippedCount` with reason `duplicate_in_file`
- Skip rows with invalid email format; every skip is recorded in `errorSummary` (capped at the first 50, with a total `skippedCount`)
- Bypasses double opt-in — imported members land as `subscribed`, with `consentSource: 'import'`, `consentAt: <job start time>`, `importJobId` set
- Upsert: if the contact already exists in the list, update `name` if provided but do not change `status`
- Cancelling a running job (`DELETE .../import/:jobId`) sets `async_jobs.status = 'cancelled'`, which stops the next coordinator invocation from re-enqueuing further pages; rows already imported are not rolled back
- **R2 cleanup:** the object at `storageKey` is deleted once the job reaches `completed`, `cancelled`, or `failed`, after a 24h recovery-retention window so a cancelled/failed import can still be inspected before deletion

**CSV export:**
- Streamed response (not buffered in memory) for large lists
- **Formula-injection-safe:** any cell value beginning with `=`, `+`, `-`, or `@` is prefixed with a leading `'` so spreadsheet apps never evaluate it as a formula

**Acceptance criteria:**
- [ ] Admin can create, rename, and archive/delete a list
- [ ] Admin can add a contact by email (creates a `contacts` row if not exists — never a `people` row directly)
- [ ] Importing a 1,000-row CSV completes via job polling without any single request exceeding platform limits
- [ ] Importing a 10,000-row CSV completes via resumed coordinator pages and reports accurate `importedCount`/`skippedCount`
- [ ] A cancelled import job stops enqueuing further pages and its R2 object is cleaned up after the retention window
- [ ] A multiline-quoted CSV field survives a page boundary intact (staged-row cursor, not a raw byte offset)
- [ ] Export returns correct CSV for the requested status filter, with formula-injection-safe cell prefixing
- [ ] Deleting a list with active campaigns archives it (200) instead of deleting; deleting a list with zero campaigns hard-deletes it (200)

---

### 2. Subscribe Forms

**API — admin only:**

| Method | Path | Description |
|---|---|---|
| GET | `/api/subscribe-forms` | List forms |
| POST | `/api/subscribe-forms` | Create form |
| GET | `/api/subscribe-forms/:id` | Get form + embed snippet |
| PATCH | `/api/subscribe-forms/:id` | Update form settings |
| DELETE | `/api/subscribe-forms/:id` | Delete form |

**Public endpoint (no auth):**

| Method | Path | Description |
|---|---|---|
| POST | `/subscribe/:form_id` | Submit subscription |
| GET | `/subscribe/confirm/:token` | Confirm double opt-in |

**Subscribe flow (double opt-in enabled):**
1. Public `POST /subscribe/:form_id` → validate request body size (max 4 KB) and email + name → check abuse controls below → upsert `contacts` row (never `people`) → insert `list_members` with `status: pending`, `consentSource: 'form'`, `consentAt: now` → send confirmation email (uses `confirmationTemplateSlug`, falling back to the built-in default — see Decisions) with HMAC-signed confirm token (own domain key, payload includes `exp: now + 48h`) → record a `subscribe_attempts` row (`attemptType: 'submission'`) → return 200 `{ status: "pending" }`
2. Recipient clicks link → `GET /subscribe/confirm/:token` → verify HMAC and check `exp` (return 410 Gone if expired so the subscriber knows to re-subscribe) → set `list_members.status = 'subscribed'`, `confirmedAt: now` → redirect to `redirectUrl` or show success page

**Subscribe flow (single opt-in):**
1. `POST /subscribe/:form_id` → upsert `contacts` → insert `list_members` with `status: subscribed`, `consentSource: 'form'`, `consentAt: now` → record a `subscribe_attempts` row → return 200 `{ status: "subscribed" }`

**Embed snippet:**
The admin UI generates a copy-paste HTML snippet:
```html
<form action="https://your-saasmail.workers.dev/subscribe/FORM_ID" method="POST">
  <input type="email" name="email" required placeholder="your@email.com" />
  <!-- if showNameField -->
  <input type="text" name="name" placeholder="Your name" />
  <input type="text" name="_hp" tabindex="-1" autocomplete="off" style="position:absolute;left:-9999px" aria-hidden="true" />
  <button type="submit">Subscribe</button>
</form>
```

**Acceptance criteria:**
- [ ] Submitting a form with double opt-in sends a confirmation email and sets status `pending`
- [ ] Clicking the confirmation link sets status `subscribed`
- [ ] Submitting with an already-subscribed email returns 200 (idempotent)
- [ ] Submitting with an invalid email returns 422
- [ ] Confirmation token replay after use returns 200 (idempotent, not an error)
- [ ] Form embed snippet is displayed in the admin UI with a copy button

**Abuse controls (public endpoint — resolves Finding #6):**
- **Honeypot:** hidden `_hp` field (see snippet above). Server silently returns 200 if non-empty, without writing any row, to avoid leaking bot detection.
- **Request body size limit:** 4 KB max; oversized bodies return 413.
- **Submission rate limit:** max 10 `subscribe_attempts` rows with `attemptType: 'submission'` per IP per 1-hour window — counts every attempt, not just ones that changed a `list_members` row (fixes the upsert-blind-spot in the original draft).
- **Confirmation resend rate limit:** max 2 `subscribe_attempts` rows with `attemptType: 'confirmation_resend'` per `(formId, emailHash)` per 1-hour window — this also protects repeated submissions against an *existing* pending membership, which the original `list_members.createdAt`-count approach could not detect.
- **Allowed origins (fail closed):** if `subscribe_forms.allowedOrigins` is non-null, the request is rejected (403) unless `Origin` matches an allowed value; a missing `Origin`/`Referer` header is treated as a non-match (rejected), not silently allowed. If `allowedOrigins` is null, any origin (including none, e.g. non-browser API submission) is accepted.
- **CORS:** the public subscribe route uses its own route-scoped CORS policy (echoing only `allowedOrigins` when set, `*` otherwise) rather than the app-wide CORS policy used by authenticated `/api/*` routes.
- **Generic errors:** all 403/422 responses from this public endpoint use a generic message; do not reveal which check failed.
- **Optional stronger control:** Turnstile may be added per-form later (Boundaries → "Ask first"); not required for v1.

---

### 3. Unsubscribe (Per-List)

**Extension of PR #95's HMAC token:**

PR #95 signs the payload `{ e: email, v: 1 }` (the email lives in the `e` field, lowercased) in `worker/src/lib/unsubscribe-token.ts`. Campaign sends use `{ v: 2, e: email, list_id, campaign_id }` (v2 tokens). Including `campaign_id` allows unsubscribes to be attributed to the correct campaign.

> **Required change:** `verifyToken` currently returns `null` for any `v !== 1`, and `signToken(email, secret)` only emits v1. Extend both to branch on version — `verifyToken` must return `{ email, listId?, campaignId? }` while staying backward-compatible with existing v1 tokens (Boundaries → "Ask first" covers the token-format change).

**Token domain separation (resolves part of Finding #9):** subscribe-confirm, unsubscribe, open-tracking, and click-tracking tokens are four distinct domains and must not share one secret. Derive four separate keys via HMAC-based key derivation from `UNSUBSCRIBE_SECRET` (e.g. `HKDF(secret, info: "subscribe-confirm" | "unsubscribe" | "track-open" | "track-click")`), or provision four distinct wrangler secrets if HKDF is not already available in the codebase (Boundaries → "Ask first" — this is a new secret-derivation utility, not a schema change). This prevents a token issued for one purpose (e.g. an open-tracking pixel URL, which can leak via image caches/proxies) from being replayable against an unrelated domain (e.g. unsubscribe).

**`sendWithSuppressionCheck` must accept a precomputed unsubscribe context (resolves Finding #14):** the existing helper unconditionally mints its own v1 token (`signToken(recipient.email, env.UNSUBSCRIBE_SECRET)`) for every non-transactional send and uses that URL for placeholder interpolation, the footer fallback, and `List-Unsubscribe`/`List-Unsubscribe-Post`. Pre-rendering a v2 URL into the campaign HTML body does **not** override this — the helper still checks whether *its own* v1 URL string is present, and appends a second footer/header pair when it isn't, so a campaign email would end up with a v2 body link **and** a v1 global-suppression footer/header simultaneously.

Required change to `SendInput`/`sendWithSuppressionCheck`:
- Add an optional `unsubscribeContext?: { url: string }` (or a typed token payload) to `SendInput`.
- When provided, the helper uses that exact URL everywhere it currently uses its internally-generated v1 URL — placeholder interpolation, footer fallback, `List-Unsubscribe`, `List-Unsubscribe-Post` — and does **not** call `signToken` internally.
- When omitted (every existing call site: transactional sends, sequence sends, template tests), behavior is byte-for-byte unchanged — this keeps legacy non-transactional/marketing sends on v1 global suppression with zero risk of regression.
- `outbox_emails` persists the same `unsubscribeContext` (or the exact rendered URL) alongside `bodyHtml`/`bodyText`/`headers` so that an outbox-driven retry reproduces the campaign's v2 behavior instead of falling back to generating a fresh v1 token on retry.
- Add integration tests asserting a campaign send has **exactly one** unsubscribe URL, and that the body placeholder, HTML/text footer fallback, and both `List-Unsubscribe*` headers all carry that same v2 token — including on an outbox-retried send.

**Unsubscribe handler (extended in `unsubscribe-router.ts`; atomic attribution — resolves Finding #18):**
- v1 token (no `list_id`) → writes to global `suppressions` table (existing PR #95 behavior, unchanged)
- v2 token (has `list_id`) → verify the token's `campaign_id` actually belongs to the token's `list_id` (reject with a generic error otherwise) → in one D1 batch: insert into `campaign_unsubscribe_attributions` (`unique(campaignId, listMemberId)`, conflict-ignored) **and** `UPDATE list_members SET status = 'unsubscribed', unsubscribed_at = ? WHERE id = ? AND status != 'unsubscribed'`; does **not** write to global `suppressions`. Both statements are idempotent no-ops on replay — there is no separate "already unsubscribed?" read-then-write race (Finding #18). `campaigns.statsUnsubscribes` is derived live from `COUNT(*) FROM campaign_unsubscribe_attributions` on read, consistent with every other stat (Finding #5) — it is never incremented directly.

**`List-Unsubscribe` header on campaign sends:**
The header URL uses a v2 token, passed through `sendWithSuppressionCheck`'s new `unsubscribeContext` (see above) rather than being generated a second time. The `/unsubscribe` page (from PR #95) handles both versions transparently.

**Acceptance criteria:**
- [ ] Clicking an unsubscribe link from a campaign email sets `list_members.status = 'unsubscribed'`
- [ ] One-click POST from Gmail/Fastmail triggers the same status update (RFC 8058)
- [ ] The unsubscribed member is excluded from all future sends to that list
- [ ] Re-subscribe button on the unsubscribe page sets status back to `subscribed`, only within a 7-day undo window from `unsubscribedAt` (see Privacy & Retention) — after that, re-subscribing requires a fresh opt-in submission through the public form
- [ ] Existing v1 tokens from legacy non-transactional/marketing sends continue to perform global suppression without change (corrected — Finding #23; the original criterion incorrectly claimed transactional sends carry v1 tokens, but `sendWithSuppressionCheck` deliberately omits unsubscribe handling entirely when `transactional === true`)
- [ ] A campaign email's body placeholder, HTML/text footer, `List-Unsubscribe`, and `List-Unsubscribe-Post` all carry the identical v2 token — including after an outbox-driven retry (Finding #14)
- [ ] Two concurrent unsubscribe requests (e.g. one-click POST + a manual browser click) against the same token attribute exactly once to `campaign_unsubscribe_attributions` and never double-count (Finding #18)
- [ ] A token signed for one domain (e.g. open-tracking) is rejected when replayed against another domain's endpoint (e.g. unsubscribe)
- [ ] A v2 token whose `campaign_id` does not belong to its `list_id` is rejected

---

### 4. Campaign Management

**API — authenticated:**

| Method | Path | Description |
|---|---|---|
| GET | `/api/campaigns` | List campaigns (paginated) |
| POST | `/api/campaigns` | Create campaign (draft) |
| GET | `/api/campaigns/:id` | Get campaign detail + stats |
| PATCH | `/api/campaigns/:id` | Update campaign (draft only) |
| DELETE | `/api/campaigns/:id` | Delete campaign (draft only) |
| POST | `/api/campaigns/:id/send` | Trigger immediate send (also confirms an `overdue` campaign) |
| POST | `/api/campaigns/:id/schedule` | Schedule for future datetime |
| POST | `/api/campaigns/:id/cancel` | Cancel scheduled campaign |
| POST | `/api/campaigns/:id/retry` | Re-enqueue a stalled/`completed_with_failures` campaign's retryable recipients |
| GET | `/api/campaigns/:id/stats/timeseries` | Hourly open + click counts (last 24 h from send) |
| GET | `/api/campaigns/:id/links` | Per-URL unique click count and click rate |

**Platform requirement (resolves Finding #20):** newsletter campaign sending requires **Workers Paid**. A single coordinator invocation issues on the order of 100+ D1 queries (the recipient page insert alone is up to 100 individual statements in one `db.batch()`, plus job/campaign reads and cursor updates) — this fits comfortably inside Workers Paid's 1,000-queries-per-invocation budget but would blow through Workers Free's 50-queries-per-invocation budget with a 100-row page. v1 does not support Workers Free for newsletter sending; the send endpoint documents this as a hard requirement rather than silently degrading. (If Free support is ever required, the fix is a smaller page size — roughly 25–40 rows — sized to that budget, not an architecture change.)

#### Campaign state machine (resolves Finding #7's ambiguity + adds the missing transition table; adds `completed_with_failures` — Finding #17)

| From | To | Trigger | Caller | Notes |
|---|---|---|---|---|
| `draft` | `scheduled` | `POST /schedule` | admin | requires future `scheduledAt` |
| `draft` | `preparing` | `POST /send` | admin | immediate send |
| `scheduled` | `preparing` | cron (`scheduledAt <= now`) or `POST /send` | admin/cron | |
| `scheduled` | `cancelled` | `POST /cancel` | admin | |
| `scheduled` | `overdue` | cron (`scheduledAt` more than 24h in the past, fan-out never started) | cron | requires explicit admin confirmation — never silently discarded or silently fired (Finding #7) |
| `overdue` | `preparing` | `POST /send` | admin | explicit confirmation to fire a stale scheduled campaign |
| `overdue` | `cancelled` | `POST /cancel` | admin | |
| `preparing` | `sending` | fan-out job's first page committed | system | |
| `preparing`/`sending` | `stalled` | cron (`updated_at` stale > 24h) | cron | |
| `sending` | `sent` | all recipients terminal, none `permanent_failed` (see completion check, step 3) | system | |
| `sending` | `completed_with_failures` | all recipients terminal, at least one `permanent_failed` (see completion check, step 3) | system | corrected model (Finding #17) — a campaign with any permanent rejection is no longer mislabeled `sent` |
| `stalled`/`completed_with_failures` | `sending` | `POST /retry` | admin | re-enqueues only `campaign_recipients.status IN ('queued', 'retrying', 'retryable_failed')` via the atomic claim (see step 3); `permanent_failed` and `unknown` rows are excluded and never auto-resent (Finding #1, #17) |
| any other pair | — | — | — | not listed = invalid; return 409 Conflict |

`PATCH`/`DELETE` are only valid while `status = 'draft'`; any other status returns 409 Conflict. The UI must display `completed_with_failures` distinctly from `sent` — a campaign is never labeled "Sent" if it contains permanent failures (Finding #17).

#### Fan-out send mechanism — resumable, outbox-backed, atomically claimed (resolves Findings #1, #2, #13, #14, #15, #17, #20, #22)

1. `POST /api/campaigns/:id/send` (or the cron trigger for `scheduled`/`overdue` campaigns):
   - **Provider capacity preflight:** compare the list's subscribed-member count against the active provider's configured daily/rate limit (new optional `PROVIDER_DAILY_SEND_LIMIT` binding/env var) plus how much has already been sent today across all campaigns/sequences/transactional mail; return 422 if this send would clearly exceed a known hard limit. If no limit is configured, skip this check (best-effort, not a hard requirement for providers without published quotas).
   - Set `status = 'preparing'`
   - **Content snapshot (Finding #8):** render the template once against list-level context (not yet per-recipient) and freeze `subjectSnapshot`, `htmlSnapshot`, `textSnapshot`, `fromAddressSnapshot`, `templateRevisionId`, `contentSnapshotAt = now`. From this point the campaign's delivered content is immutable — editing or deleting the source template afterward has no effect on this campaign.
   - Create one `async_jobs` row (`jobType: 'campaign_fan_out'`, `cursor: null`, `status: 'running'`), set `campaigns.fanOutJobId`
   - Enqueue **one** coordinator message on the existing `EMAIL_QUEUE` binding: `{ type: 'campaign_fan_out', campaign_id, job_id }`
2. **Coordinator message handler** (each invocation processes one bounded page — this is what makes a 10,000-recipient campaign safe, per Finding #2; page size and platform requirement corrected per Finding #20):
   - On the first invocation: `SELECT COUNT(*)` of subscribed `list_members` for the list and set `campaigns.statsTargeted`; set `status = 'sending'`
   - Read `async_jobs.cursor` → select the next page of up to 100 subscribed `list_members` with `id > cursor`, ordered by `id`
   - Insert this page's `campaign_recipients` rows (`status: 'queued'`, `idempotencyKey: "${campaignId}:${contactId}"`) in **one `db.batch([...])`** call using `.onConflictDoNothing({ target: [campaignRecipients.campaignId, campaignRecipients.contactId] })` on every insert (Finding #15 — a unique index alone does not make a replayed plain `INSERT` a no-op; it makes it throw). The 100-row page size is an **application-level chunk size chosen to align with Cloudflare Queues' `sendBatch()` 100-message/256 KB limit** — it is not a D1 "100 statements per batch" limit (no such limit exists; D1's per-query cap is 100 *bound parameters*, a different constraint). See the Platform requirement note above for why this page size requires Workers Paid.
   - `EMAIL_QUEUE.sendBatch()` one message per row in this page, using the Queues producer batch-entry shape: `EMAIL_QUEUE.sendBatch(page.map(r => ({ body: { type: 'campaign_send', campaign_id: campaignId, campaign_recipient_id: r.id } })))` (≤ 100 entries / 256 KB, matching Cloudflare Queues' `sendBatch()` limit)
   - Advance `async_jobs.cursor` to the last id in the page and increment `processedRows` — **only after** the batch insert and `sendBatch()` both succeed
   - **Replay safety (Finding #15):** `sendBatch()` can fail or return an ambiguous partial result — Cloudflare Queues does not provide a reliable per-message success list for a rejected batch. Treat any non-success outcome as **ambiguous publication, not partial success**: do not advance the cursor, and let the coordinator message's own queue-level retry replay the entire page. This is safe specifically *because* the recipient insert is conflict-ignored (idempotent) and the per-recipient handler's atomic claim (step 3) makes a duplicate `campaign_send` message a no-op if that recipient was already claimed — replaying a whole page is never harmful, merely redundant.
   - If the page was full (100 rows): re-enqueue another coordinator message for the next page
   - If the page was short (< 100 rows): set `async_jobs.status = 'completed'` — fan-out **enumeration** is done; this does not mean delivery is done (see completion check in step 3)
3. **Per-recipient send message handler** (`campaign_send`), reusing `worker/src/lib/outbox.ts` with the campaign-recipient correlation added in Finding #13:
   - **Atomic claim (Finding #15) — replaces the old read-then-write idempotency check:**
     ```sql
     UPDATE campaign_recipients
     SET status = 'processing', attempts = attempts + 1
     WHERE id = ? AND status IN ('queued', 'retrying', 'retryable_failed')
     RETURNING id;
     ```
     If zero rows are returned, another delivery of this message (or a previous attempt) already claimed or terminalized this recipient — ack and skip, no provider call. Only the invocation that receives a row proceeds.
   - If the row was already `processing` with an existing `outboxId` (a genuinely concurrent claim, not just a duplicate message — should be rare given the atomic claim above, but possible if a previous worker instance is still mid-flight), check whether that `outboxId`'s row is `bookkeeping_pending` or gone with a matching `sentEmailId` on `sent_emails`: if so, reconcile this recipient to `sent` and skip; otherwise treat it the same as any other claimed row.
   - Generate `sentEmailId`, call `sendViaOutbox(...)` (same helper sequence sends use, extended per Finding #13 to accept `campaignRecipientId` and to hold the row `bookkeeping_pending` — not delete it — immediately after provider success) with:
     - the recipient's rendered content: reserved variables (`{{unsubscribe_url}}`, `{{subscriber_name}}`, `{{subscriber_email}}`) rendered, and open-tracking pixel + click-tracking link rewrites injected, against the campaign's **snapshotted** `htmlSnapshot`/`textSnapshot` — never re-read the mutable `templateSlug`
     - `unsubscribeContext: { url: <this recipient's v2 unsubscribe URL> }` (Finding #14) — so `sendWithSuppressionCheck` uses this exact URL for the body, footer fallback, and both `List-Unsubscribe*` headers instead of minting its own v1 token
   - **Post-provider bookkeeping (Finding #13) — runs only after `sendViaOutbox` confirms provider success, using the `bookkeeping_pending` outbox row as the durable record that this step must complete before the row is deleted:**
     - If `contacts.personId` is null, call the shared `findOrCreatePersonByEmail` helper (Finding #22 — the race-safe `send-router.ts` pattern, not the `sequence-processor.ts` one) and set `contacts.personId`
     - Write `sent_emails` (`personId`, `campaignId`, `fromAddress`, `toAddress`, `subject`, `sentAt`, `createdAt`, and the other NOT NULL columns)
     - Set `campaign_recipients.status = 'sent'`, `sentEmailId`
     - Delete the outbox row only now that all of the above succeeded
   - On outbox outcome `suppressed`: `campaign_recipients.status = 'suppressed'` (no bookkeeping-pending window needed — no provider call was made)
   - On outbox outcome `retrying` (transient, `attempts < MAX_OUTBOX_ATTEMPTS`): `campaign_recipients.status = 'retrying'` (the existing hourly outbox processor redelivers it, same as sequence emails)
   - On outbox outcome `failed`: classify using the same transient/permanent distinction the outbox/sender already compute (`worker/src/lib/email-sender/classify.ts`) — transient-but-exhausted → `campaign_recipients.status = 'retryable_failed'` (admin can `POST /retry`); non-transient → `campaign_recipients.status = 'permanent_failed'` (never retried, automatically or manually)
   - **Crash reconciliation (Finding #13):** if the caller crashes after `sendViaOutbox` confirms provider success but before the bookkeeping above completes, the row is left `bookkeeping_pending`. The existing hourly `processOutbox()`/`attemptOutboxRow()` sweep must detect `bookkeeping_pending` rows with a non-null `campaignRecipientId` and **re-run only the bookkeeping steps** (never re-call the provider) using the already-confirmed result — this is what makes crash recovery self-healing instead of ambiguous-delivery.
   - **Completion check (replaces the racy counter-equality check — Finding #5; corrected for split failure states — Finding #17):** after every terminal write, run one conditional update per outcome:
     ```sql
     -- clean completion: no permanent failures
     UPDATE campaigns SET status = 'sent', sent_at = ?
     WHERE id = ? AND status = 'sending'
       AND fan_out_job_id IN (SELECT id FROM async_jobs WHERE status = 'completed')
       AND NOT EXISTS (
         SELECT 1 FROM campaign_recipients
         WHERE campaign_id = ? AND status NOT IN ('sent','suppressed','permanent_failed')
       )
       AND NOT EXISTS (
         SELECT 1 FROM campaign_recipients WHERE campaign_id = ? AND status = 'permanent_failed'
       );

     -- completion with at least one permanent failure
     UPDATE campaigns SET status = 'completed_with_failures', sent_at = ?
     WHERE id = ? AND status = 'sending'
       AND fan_out_job_id IN (SELECT id FROM async_jobs WHERE status = 'completed')
       AND NOT EXISTS (
         SELECT 1 FROM campaign_recipients
         WHERE campaign_id = ? AND status NOT IN ('sent','suppressed','permanent_failed')
       )
       AND EXISTS (
         SELECT 1 FROM campaign_recipients WHERE campaign_id = ? AND status = 'permanent_failed'
       );
     ```
     `queued`/`processing`/`retrying`/`retryable_failed`/`unknown` all block completion (still "in flight" or awaiting manual action). This is safe under concurrent execution — only one writer can flip `status` away from `'sending'` — and does not depend on mutable counters ever reaching an exact equality.
4. **Hourly Cron trigger** (`0 * * * *`, already wired in `index.ts` → `scheduled()`, which runs `handleScheduled` then `processOutbox`): add a campaign pass that, in order:
   - Fires `scheduled` campaigns where `scheduledAt <= now` (see scheduling SLA below)
   - Moves `scheduled` campaigns more than 24h overdue to `overdue` (never fires them automatically, never silently drops them — Finding #7)
   - Sweeps `preparing`/`sending` campaigns with `updated_at < now - 24h` to `stalled`
   - Reconciles any `bookkeeping_pending` outbox rows with a `campaignRecipientId` (Finding #13 crash recovery, described above)
   - Refreshes the **advisory** `statsDelivered`/`statsSuppressed`/`statsRetryableFailed`/`statsPermanentFailed`/`statsUniqueOpeners`/`statsUniqueClicks` cache columns from `campaign_recipients`/`campaign_events` for campaigns updated in the last 48h (read-only source of truth; never used for the completion decision in step 3); `statsUnsubscribes` is computed live from `campaign_unsubscribe_attributions` on read, not cached here (Finding #18)
   - Deletes `subscribe_attempts` rows older than 24h

**Scheduling SLA (resolves Finding #7):** v1's documented granularity is the **hourly cron window** — a campaign scheduled for 12:01 sends at the next hourly tick, up to ~59 minutes later. This is a stated trade-off, not a bug, given "no new dependencies" constrains us from adding delayed Queue messages or a sub-hourly cron in v1. A campaign is **never silently abandoned**: anything under 24h overdue still fires at the next tick; anything over 24h overdue moves to the visible `overdue` status and requires an explicit admin `POST /send` to confirm before it fires.

**Stalled recovery:** see the state machine table above — `POST /api/campaigns/:id/retry` is valid from `stalled` **and** `completed_with_failures` (Finding #17) and re-enqueues recipients with `status IN ('queued', 'retrying', 'retryable_failed')` only, via the same atomic claim used by the original send path. `permanent_failed` and `unknown` recipients are surfaced in the admin UI as needing manual reconciliation and are never included in any retry, automatic or manual.

**List size cap:** `POST /api/campaigns/:id/send` returns 422 if the target list has >10,000 subscribed members. The same cap is enforced on `POST /api/lists/:id/members/import`. This caps fan-out at 100 coordinator pages of 100 recipients each.

**Shared-queue safeguards (resolves Finding #11):** v1 reuses the existing `EMAIL_QUEUE` binding (`saasmail-sequence-emails`, `max_batch_size: 10`, `max_retries: 3`) for both `campaign_fan_out`/`campaign_send` and existing `SequenceEmailMessage` traffic. To keep a large campaign blast from starving time-sensitive sequence/transactional delivery on the shared consumer:
- Fan-out pages are enqueued one coordinator message at a time (not all 100 pages at once), which naturally rate-limits how fast `campaign_send` messages enter the shared queue relative to other traffic
- Each `campaign_send`/coordinator message is explicitly acked or retried by `handleQueueBatch`'s `type` branch — no implicit acking
- Add a load test (see Required Test Additions) proving acceptable sequence-message latency while a campaign fan-out is actively enqueuing
- A dedicated `CAMPAIGN_QUEUE` binding remains the cleaner long-term isolation boundary (Future Considerations, unchanged — still a wrangler infra change requiring "Ask first")

**Open tracking:**
- The open-tracking token domain is derived separately from the unsubscribe/click/confirm domains (see §3 "Token domain separation")
- A `<img src="{{BASE_URL}}/track/open/TOKEN" width="1" height="1" style="display:none" />` is appended to the rendered HTML body after the per-recipient render pass
- `TOKEN` = HMAC-signed `{v:1, campaign_id, contact_id}` using the open-tracking domain key
- `GET /track/open/:token` (public, no auth): verify token → return a base64-encoded 1×1 transparent GIF **immediately** with `Cache-Control: no-store, must-revalidate` and `Pragma: no-cache` headers → upsert `campaign_events` (dedup via the partial unique index in Finding #3) via **`ctx.waitUntil()`** so the analytics write never delays the pixel response

**Click tracking (opaque tokens — resolves Finding #9):**
- All `<a href>` links in the HTML body (except `{{unsubscribe_url}}`, matched **before** variable interpolation via a reserved-placeholder marker, not by string-matching the interpolated URL afterward) are rewritten to `{{BASE_URL}}/track/click/TOKEN` using Cloudflare's native **`HTMLRewriter`** API (streaming, Rust-backed parser) to keep per-subscriber CPU time low; do not use string-replace or a DOM parser
- Each unique destination URL is upserted into `campaign_links` (validated as `http:`/`https:` only — other schemes are rejected and the link is left unrewritten) and its `id` becomes the `campaignLinkId`
- `TOKEN` = HMAC-signed `{v:1, campaign_id, contact_id, campaign_link_id}` using the click-tracking domain key — **the destination URL is never inside the token**
- `GET /track/click/:token` (public): verify → look up `campaign_links.url` by `campaign_link_id` → upsert event (dedup via the partial unique index in Finding #3) → 302 redirect to the looked-up URL

**Tracking accuracy caveat:**
Open and click counts are **best-effort engagement signals, not ground truth:**
- Apple Mail Privacy Protection (MPP) pre-fetches tracking pixels — open counts will overcount significantly for consumer-facing lists.
- Some email clients and corporate proxies pre-fetch links, inflating click counts.
- The pixel endpoint returns `Cache-Control: no-store, must-revalidate` and `Pragma: no-cache` (specified above); this minimises proxy caching but cannot prevent MPP.
- The admin UI labels these as **"~opens"** and **"~clicks"** (approximate) to set operator expectations.

**Campaign stats view (`CampaignDetailPage`):**

The detail page renders three sections (matching the Keila statistics view):

1. **Stats grid** — 6 metric tiles:
   - Sent (`statsTargeted` targeted, `statsDelivered` delivered — both shown; "Sent" alone no longer conflates targeted with delivered, Finding #5); if the campaign is `completed_with_failures`, the tile also shows `statsPermanentFailed` and links to the failed-recipients list
   - Opened (`statsUniqueOpeners`, shown as `~N  X.X%` of `statsDelivered`)
   - Clicked (`statsUniqueClicks`, shown as `~N  X.X%` of `statsDelivered`) — a single metric; "clicks" and "unique clickers" are the same number under the one-row-per-contact-per-link schema (Finding #21)
   - Unsubscribed (`statsUnsubscribes`, computed live from `campaign_unsubscribe_attributions`, shown as `N  X.X%` of `statsDelivered`)
   - Bounces — displays `—` in v1 (no webhook infrastructure yet)
   - Complaints — displays `—` in v1
2. **24-Hour Performance chart** — line chart with two series (opens, clicks) bucketed by hour. Data from `GET /api/campaigns/:id/stats/timeseries`. If the campaign is still `sending`, the chart refreshes every 30 s.
3. **Links table** — columns: URL, Clicks (unique), Click rate. Data from `GET /api/campaigns/:id/links`, sorted by clicks desc. Empty state shown when no links have been clicked yet.

**`GET /api/campaigns/:id/stats/timeseries` response:**
```json
{ "data": [{ "hour": 1716480000, "opens": 5, "clicks": 2 }] }
```
Returns 24 hourly buckets anchored to send time, computed live from `campaign_events` (not the advisory cache). Hours with no events are included with zero counts.

**`GET /api/campaigns/:id/links` response (single unique-click metric — corrected, Finding #21):**
```json
{ "data": [{ "url": "https://example.com", "clicks": 12, "clickRate": 0.04 }] }
```
`clicks` is the count of distinct `(contact, link)` rows for this URL — equivalently "unique clickers," since the partial unique index on `campaign_events` makes those the same number. There is no separate raw-occurrence count in v1 (see `campaign_events` schema note). `clickRate = clicks / statsDelivered` (delivered, not targeted — targeted includes suppressed/failed recipients who never received the email, Finding #5). Sorted by `clicks` desc.

**Acceptance criteria:**
- [ ] Admin can create a draft campaign, select a list and template, and preview rendered output
- [ ] Sending to a 500-member list completes fan-out via coordinator pages without any single request exceeding platform limits (Workers Paid)
- [ ] Sending to a 10,000-member list completes via 100 resumed coordinator pages
- [ ] Each subscriber receives a unique unsubscribe link (v2 HMAC token, unsubscribe domain key), consistently across body, footer, and both `List-Unsubscribe*` headers, including on retry (Finding #14)
- [ ] Each subscriber receives a unique tracking pixel and unique opaque click-tracking URLs (no destination URL inside any token)
- [ ] Suppressed addresses are excluded and counted in `statsSuppressed`
- [ ] Opening an email increments the derived open count exactly once per contact per campaign, even under duplicate pixel requests
- [ ] Clicking a link increments the derived click count exactly once per contact per link per campaign
- [ ] A campaign scheduled in the past fires at the next hourly tick if under 24h overdue; moves to `overdue` (not silently discarded) if over 24h overdue
- [ ] Editing or deleting a campaign in any status other than `draft` returns 409 Conflict
- [ ] Each send creates a `sent_emails` row with `campaignId`; the send appears in the recipient's person timeline once `contacts.personId` is lazily linked via `findOrCreatePersonByEmail`
- [ ] The campaign detail page renders the stats grid, 24-hour performance chart, and links table
- [ ] Unsubscribing via a campaign email attributes exactly once to `campaign_unsubscribe_attributions`, even under concurrent duplicate requests (Finding #18)
- [ ] `GET /api/campaigns/:id/stats/timeseries` returns 24 hourly buckets (zero-filled for empty hours)
- [ ] `GET /api/campaigns/:id/links` returns per-URL unique click counts, sorted by clicks desc
- [ ] A duplicate Queue delivery of the same `campaign_send` message never produces two provider calls or two `sent_emails` rows (verified via the atomic claim, not a read-then-write check — Finding #15)
- [ ] A crash after provider success but before bookkeeping (`sent_emails`/`campaign_recipients`/`contacts.personId`) completes self-heals to `sent` on the next hourly reconciliation sweep instead of duplicating the send (Finding #13)
- [ ] A campaign with a mix of delivered and permanently-rejected recipients ends in `completed_with_failures`, not `sent` (Finding #17)
- [ ] `POST /retry` on a `completed_with_failures` campaign re-enqueues only `retryable_failed`/`queued`/`retrying` recipients, never `permanent_failed` or `unknown`
- [ ] An ambiguous/failed `sendBatch()` call causes the whole page to be safely replayed rather than being treated as a partial success (Finding #15, #20)
- [ ] A load test shows acceptable sequence-message latency on the shared queue while a campaign fan-out is actively enqueuing (Finding #11)

---

## Authorization Matrix

**Contradiction resolved (Finding #10):** the matrix below and the Boundaries section previously disagreed about whether scoped members can touch lists/campaigns at all. The v1 rule is: scoped members and member API keys get **read + draft-write** access for lists/campaigns tied to their allowed `fromAddress` values; **send/schedule/cancel/retry are always admin-only**. What's deferred to v2 is *finer-grained per-list* RBAC beyond the existing `fromAddress` scoping (e.g. per-list permissions independent of inbox) — not the base scoping itself.

Scoping rule: lists and campaigns are scoped to a `fromAddress` (sender identity). A member with access to the inbox tied to that `fromAddress` can read and write lists and campaigns for that identity. Admins have unrestricted access. Send / schedule / cancel / retry operations are **admin-only** to prevent accidental dispatch.

| Operation | Admin | Member (scoped) | API Key (admin) | API Key (member) | Public |
|---|---|---|---|---|---|
| Create / edit / delete lists | ✅ | ✅ allowed `fromAddress` only | ✅ | ✅ scoped | ❌ |
| Import / export members | ✅ | ✅ scoped | ✅ | ✅ scoped | ❌ |
| View campaign stats | ✅ | ✅ scoped | ✅ | ✅ scoped | ❌ |
| Create / edit campaigns (draft) | ✅ | ✅ scoped | ✅ | ✅ scoped | ❌ |
| Send / schedule / cancel / retry campaigns | ✅ only | ❌ | ✅ only | ❌ | ❌ |
| Create / edit / delete subscribe forms | ✅ | ❌ admin-only | ✅ | ❌ | ❌ |
| Submit subscribe form | ❌ | ❌ | ❌ | ❌ | ✅ |
| Confirm double opt-in | ❌ | ❌ | ❌ | ❌ | ✅ HMAC token |
| Open pixel / click redirect | ❌ | ❌ | ❌ | ❌ | ✅ HMAC token |
| Unsubscribe | ❌ | ❌ | ❌ | ❌ | ✅ HMAC token |

**API key access:** API keys are per-user (existing model). Lists and campaign endpoints honour the key owner's role and inbox permissions exactly as session-based auth does. No new key scope types are required for v1.

---

## Code Style

Follow existing patterns in the codebase exactly.

**Router pattern (Hono + Zod OpenAPI):**
```ts
// worker/src/routers/lists-router.ts
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { json200Response } from "../lib/helpers";
import type { Variables } from "../variables";

export const listsRouter = new OpenAPIHono<{
  Bindings: CloudflareBindings;
  Variables: Variables;
}>();

const ListSchema = z.object({
  id: z.string(),
  name: z.string(),
  fromAddress: z.string(),
  doubleOptIn: z.boolean(),
  createdAt: z.number(),
});

const listListsRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Lists"],
  description: "List all subscriber lists.",
  responses: {
    ...json200Response(z.array(ListSchema), "Paginated lists"),
  },
});

listsRouter.openapi(listListsRoute, async (c) => {
  const db = c.get("db");
  // ...
  return c.json({ data, total, page, limit }, 200);
});
```

**Schema pattern (Drizzle):**
```ts
// worker/src/db/lists.schema.ts
import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core";

export const lists = sqliteTable("lists", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  fromAddress: text("from_address").notNull(),
  doubleOptIn: integer("double_opt_in").notNull().default(0),
  confirmationTemplateSlug: text("confirmation_template_slug"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});
```

**Reserved template variables** (auto-injected on campaign and confirmation sends; blocked as user-defined variable names):
- `{{unsubscribe_url}}` — per-recipient signed unsubscribe link
- `{{subscriber_name}}` — recipient's name from `contacts.name` (empty string if null; not `people.name` — see the `contacts` table)
- `{{subscriber_email}}` — recipient's email address
- `{{confirm_url}}` — double opt-in confirmation link (confirmation emails only)

**Key conventions:**
- IDs: `nanoid()` (already used everywhere)
- Timestamps: Unix epoch integers (not ISO strings)
- JSON columns: `text("col")` with manual `JSON.parse`/`JSON.stringify`
- Pagination: two patterns exist — offset `{ data, total, page, limit }` (e.g. `people-router`) and cursor `{ items, nextCursor }` (e.g. `suppressions-router`, from PR #95). Pick one per resource and stay consistent; cursor is preferred for large member/event lists
- Route files export a named `*Router` const; mounted in `index.ts`
- All public (no-auth) routes are in dedicated router files, not mixed with authed routes. Session/passkey middleware is scoped to `app.use("/api/*", …)`, so public routers mount outside `/api` (the `unsubscribe-router` is dual-mounted at `/api/unsubscribe` and `/unsubscribe`) or are added to `isUnauthenticatedPath`; `/subscribe` and `/track` follow the non-`/api` precedent
- Frontend: `@tanstack/react-query` is installed and its provider wraps the app, but existing pages use `useState` + `useEffect` + imperative `fetch` (see `AdminUsersPage`) — match that imperative pattern; do not introduce `useQuery`/`useMutation` for new pages
- UI components: Radix Dialog for modals, existing Tailwind color tokens (`bg-bg-muted`, `text-text-secondary`, etc.)

---

## Testing Strategy

**Framework:** Vitest for unit + integration; Playwright for e2e.

**Unit tests** (`worker/src/__tests__/`):
- HMAC token helpers: round-trip, tampered sig, wrong secret, malformed input, expired token (48 h TTL on confirm tokens), cross-domain rejection (a token signed for one domain — e.g. open-tracking — must fail verification against another domain's key)
- `findOrCreatePersonByEmail`: concurrent-insert race (two callers creating the same email simultaneously both resolve to one `people` row via `onConflictDoNothing` + re-select), correct `lastEmailAt`/`totalCount` semantics for a first campaign delivery (Finding #22)
- `campaign-sender.ts`: correct member enumeration, suppressed-member exclusion, `campaign_recipients` rows pre-populated as `queued` via conflict-ignored insert, cursor advances only after batch insert + `sendBatch()` succeed, retried coordinator message is a safe no-op, ambiguous/failed `sendBatch()` leaves the cursor unmoved so the whole page safely replays (Finding #15, #20)
- Atomic recipient claim: `UPDATE ... WHERE status IN (...) RETURNING` returns exactly one row under two concurrent claim attempts on the same recipient (Finding #15)
- `list-import.ts`: RFC 4180 quoting/escaping, BOM stripping, duplicate-email-in-file handling, formula-injection-safe export prefixing, staged-row cursor survives a multiline field spanning a page boundary (Finding #16)
- `track-token.ts`: round-trip, dedup logic, opaque `campaignLinkId` (no URL inside the token)
- Outbox transient/permanent classification mapping to `campaign_recipients.status` (`retryable_failed` vs. `permanent_failed` — Finding #17)

**Integration tests** (`worker/src/__tests__/`):
- Lists CRUD with admin + member auth
- List member add/remove (status change)/import (async job)/export
- Subscribe form submission (single opt-in + double opt-in full flow)
- Confirmation token: valid, tampered, replayed
- Campaign CRUD, send trigger, schedule/cancel/retry (from both `stalled` and `completed_with_failures`)
- Coordinator message: resumable cursor behavior across multiple invocations; ambiguous/failed `sendBatch()` triggers a safe full-page replay rather than being treated as partial success (Finding #15, #20 — replaces the "partial sendBatch failure" test from the first pass, which described an unavailable API shape)
- Queue consumer: `campaign_recipients` queued → processing → sent/suppressed/retrying/retryable_failed/permanent_failed/unknown transitions via the atomic claim; `sent_emails.campaignId` populated on success; completion check flips `campaigns.status` to `sent` or `completed_with_failures` exactly once (Finding #17)
- **Duplicate Queue redelivery** of the same `campaign_send` message never produces two provider calls or two `sent_emails` rows, verified via the atomic `UPDATE ... RETURNING` claim, not a read-then-write check (Finding #15)
- **Crash simulation (Finding #13):** a `campaign_recipients` row left `processing` with its outbox row `bookkeeping_pending` (provider already confirmed success) reconciles to `sent` on the next hourly sweep by re-running bookkeeping only — never re-calling the provider
- Outbox-backed transient retry and retry exhaustion for campaign sends (reusing the existing outbox test harness), confirming exhaustion lands on `retryable_failed`, not a re-used generic `failed`
- D1 overloaded/transient error handling during fan-out batch insert
- Repeat-open dedup with the partial unique index (`campaignLinkId` NULL for opens)
- Click event schema enforces one row per `(campaign, contact, link)` — "clicks" and "unique clickers" are provably the same number (Finding #21)
- Template mutation after a campaign leaves `draft` has no effect on the already-snapshotted content
- Provider-capacity preflight rejection when `PROVIDER_DAILY_SEND_LIMIT` is configured and would be exceeded
- Missing/mismatched `Origin`/`Referer` on the public subscribe endpoint (fail closed)
- Subscribe abuse against an existing (already-pending) membership via the `subscribe_attempts` ledger
- Oversized/malformed CSV import and formula-safe export
- v1 global vs. v2 per-list unsubscribe behavior; a v2 token whose `campaign_id` doesn't belong to its `list_id` is rejected
- **Campaign v2 unsubscribe context (Finding #14):** a campaign send's body placeholder, HTML/text footer fallback, and both `List-Unsubscribe*` headers all carry the identical v2 token, including after an outbox-driven retry (not a freshly-minted v1 token)
- **Atomic unsubscribe attribution (Finding #18):** two concurrent unsubscribe requests (simulating one-click POST + manual browser click) against the same token attribute exactly once in `campaign_unsubscribe_attributions` and never double-count `statsUnsubscribes`
- Expired re-subscribe undo window vs. fresh re-opt-in via the public form
- Every campaign state-machine transition, including forbidden transitions returning 409, and including the `sending → sent` vs. `sending → completed_with_failures` branch (Finding #17)
- Campaign fan-out load test: acceptable sequence-message latency on the shared `EMAIL_QUEUE` while a campaign fan-out is actively enqueuing
- Open tracking: first open increments the derived count; replay does not
- Click tracking: redirect via `campaignLinkId` lookup, dedup
- `GET /api/campaigns/:id/stats/timeseries`: 24 hourly buckets, zero-filled, correct open/click counts
- `GET /api/campaigns/:id/links`: per-URL unique click counts, click rate calculation, sorted desc (single metric — Finding #21)
- Migration workflow: `yarn db:migrate:dev` applies every new hand-authored migration cleanly against a fresh local D1 without invoking `drizzle-kit generate` (Finding #19)

**e2e tests** (`e2e/specs/`):
- `lists.spec.ts` — create list, import CSV via async job polling, view members
- `campaigns.spec.ts` — draft → send → verify stats
- `subscribe-form.spec.ts` — embed form submit → verify member appears in list

**Coverage requirement:** All new route handlers and lib utilities must have integration tests. No new router file ships without tests.

---

## Privacy & Retention (resolves Finding #12; retention defaults and export/erasure corrected — Finding #24)

- **No hard deletes of consent history:** removing a list member is a `status` change (`unsubscribed`), never a row delete. `lists` with campaign history are archived (`archivedAt`), never hard-deleted (see §1).
- **Consent provenance:** every `list_members` row records `consentSource`, `consentAt`, and (for imports) `importJobId`, so an export of "why do we have this email" is always answerable.
- **Retention windows (concrete defaults, configurable via env — Finding #24 required these be defined rather than "indefinite"):**
  - `subscribe_attempts`: 24 hours (cleaned up by the hourly cron pass)
  - `list_members.submittedIp`: 30 days, then nulled out by the hourly cron pass (the membership row itself is retained; only the raw IP is cleared)
  - Re-subscribe undo window after unsubscribe: 7 days (`unsubscribedAt` + 7d) — after that, re-subscribing requires a fresh opt-in through the public form, not a one-click undo
  - `campaign_events` (opens/clicks): 13 months, then deleted by a bounded-batch cron pass (long enough to cover a year-over-year engagement comparison, matching common industry defaults)
  - Delivery/consent audit rows (`campaign_recipients`, `campaign_unsubscribe_attributions`, `list_members`, `sent_emails`) are retained until the owning list/contact is explicitly erased (see below) — these are the evidence trail for suppression/consent, not itself in scope for a rolling TTL
  - All of the above are bounded-batch cron cleanup passes (matching the existing `subscribe_attempts` sweep's shape), so no single cron tick attempts an unbounded delete
- **Data export/erasure (corrected — Finding #24):** the first revision's claim that "admins can already answer requests through existing admin tooling" was inaccurate — no existing tool in this codebase queries `contacts`/`list_members`/`campaign_events`. v1 ships two authenticated, admin-only operations instead of relying on ad hoc SQL:
  - `GET /api/contacts/:email/export` — returns every `contacts`, `list_members` (across all lists), and `campaign_events` row for that email as JSON, for subject-access requests
  - `POST /api/contacts/:email/erase` — hashes/removes the email from `contacts`/`list_members`/`campaign_events`/`subscribe_attempts` while preserving the *shape* of delivery-audit rows needed for suppression evidence (the row stays, the email is replaced with a one-way hash) — mirrors how `people`/`sent_emails` erasure would need to work if ever implemented there, and is scoped narrowly to the newsletter tables added by this feature
  - Both are admin-only (Authorization Matrix), audited (log the operator + timestamp), and out of scope for member/API-key access
- **Tracking disclosure:** the admin-facing campaign stats UI labels opens/clicks as approximate ("~opens"/"~clicks") per the Tracking accuracy caveat in §4. A recipient-facing tracking disclosure (e.g. in the default email footer) is out of scope for v1; regional legal requirements for marketing-consent disclosure should be reviewed by the operator before enabling tracked sends in a given jurisdiction.

---

## Boundaries

**Always:**
- Run `yarn tsc --noEmit` before committing — zero type errors
- Run `yarn test` before committing — all tests must pass
- Use `nanoid()` for new IDs
- Use `sendWithSuppressionCheck` (from PR #95) for every send — never call the transport directly
- Set `transactional: false` on campaign sends so `List-Unsubscribe` headers are injected by PR #95
- Pass an explicit `unsubscribeContext` into `sendWithSuppressionCheck` for every campaign send so it uses the campaign's v2 token everywhere instead of minting its own v1 token (Finding #14)
- Reuse `worker/src/lib/outbox.ts` (`sendViaOutbox`) for every campaign send — never call the transport or `sendWithSuppressionCheck` directly from the queue consumer (Finding #1)
- Use the atomic `UPDATE ... WHERE status IN (...) RETURNING` claim before any campaign send attempt — never a read-then-write status check (Finding #15)
- Use `.onConflictDoNothing(...)` on every `campaign_recipients` insert in the fan-out coordinator (Finding #15)
- Hold a campaign's outbox row `bookkeeping_pending` (not delete it) between provider success and the completion of `sent_emails`/`campaign_recipients`/`contacts.personId` bookkeeping (Finding #13)
- Use the shared `findOrCreatePersonByEmail` helper (extracted from `send-router.ts`'s existing pattern) for contact-to-person linking — never re-implement the find-or-create race handling (Finding #22)
- Dedup tracking events at the DB level via the partial unique indexes, not just in application logic (Finding #3)
- Create a `sent_emails` row (with `campaignId`) for every successful campaign send — campaigns must appear in the person timeline
- Return 409 Conflict when modifying a campaign outside `draft` status
- Store consent provenance (`consentSource`, `consentAt`, `importJobId`) on every `list_members` row (Finding #12)
- Use opaque `campaignLinkId` tokens for click tracking — never embed a destination URL inside a signed token (Finding #9)
- Validate `campaign_links.url` is `http:`/`https:` only before ever redirecting to it
- Advance `async_jobs.cursor` only after the corresponding batch insert + `sendBatch()` have both succeeded (Finding #2, #15)
- Attribute an unsubscribe via the `campaign_unsubscribe_attributions` unique-insert, never a read-then-increment on `campaigns.statsUnsubscribes` (Finding #18)
- Validate every new migration applies cleanly via `yarn db:migrate:dev` against a clean local D1, with a hand-appended `migrations/meta/_journal.json` entry (Finding #19)

**Ask first:**
- Adding any new npm/yarn dependency
- Changing the D1 schema in a way that requires a non-trivial migration (column drops, renames)
- Adding open tracking or click tracking to non-campaign sends (transactional)
- Changing the HMAC token format for existing v1 tokens (must remain backward compatible)
- Adding an HKDF/multi-secret key-derivation utility for token domain separation (Finding #9), if one doesn't already exist in the codebase
- Adding finer-grained per-list RBAC beyond the existing `fromAddress`-based inbox scoping already defined in the Authorization Matrix (deferred to v2 — see Finding #10's resolution note above the matrix)
- Bounce/complaint webhook integration to auto-update `list_members.status` (deferred to v2; target behaviour: hard bounce → `unsubscribed` + global suppression, complaint → global suppression)
- Preference center UI on the unsubscribe page (deferred to v2)
- `mailto:` form in `List-Unsubscribe` header (deferred to v2 per PR #95)
- Dedicated campaign queue (deferred to v2 — see Future Considerations)
- Introducing a `PROVIDER_DAILY_SEND_LIMIT` preflight config value/binding
- Reducing the fan-out page size to support Workers Free (Future Considerations — v1 requires Workers Paid, Finding #20)
- Repairing the upstream `0019`/`0020` drizzle-kit snapshot collision to re-enable `yarn db:generate` (out of scope for this feature; Finding #19)

**Never:**
- Commit `UNSUBSCRIBE_SECRET` or any secret to the repo
- Skip the suppression check on campaign sends
- Allow campaign sends to proceed if status is already `sending`, `sent`, or `completed_with_failures` (prevent double-send)
- Skip rate-limit or honeypot checks on the public subscribe endpoint
- Serve tracking pixels or redirect endpoints behind auth (they must be public)
- Rewrite `{{unsubscribe_url}}` links during click-tracking link rewriting
- Drop or rename existing columns in migrations (add only; use Drizzle addColumn pattern)
- Run `yarn db:generate` as part of this feature's workflow — migrations are hand-authored (Finding #19)
- Auto-resend a `campaign_recipients` row whose status is `unknown` or `permanent_failed` — the former requires manual reconciliation, the latter is never retried (Finding #1, #17)
- Store a raw destination URL inside a signed click-tracking token (Finding #9)
- Hard-delete a `list_members` row or a `lists` row that has campaign history — archive/status-change instead (Finding #12)
- Re-read the mutable `templateSlug`/template record when rendering a campaign that has already left `draft` — always render from the frozen snapshot (Finding #8)
- Re-call the provider during outbox reconciliation of a `bookkeeping_pending` row — only re-run the bookkeeping steps against the already-confirmed result (Finding #13)

---

## Implementation Order

Dependencies flow top to bottom. Do not begin a phase until the previous phase's tests are green.

```
Phase 1 — Foundation (no UI yet)
  └── DB schemas + migrations, in dependency order (Finding #19):
       async_jobs → contacts → lists + list_members → subscribe_forms + subscribe_attempts →
       campaigns + campaign_events [+ partial unique indexes] + campaign_recipients +
       campaign_links + campaign_unsubscribe_attributions + sent_emails.campaignId →
       outbox_emails.campaignRecipientId [+ unique index, bookkeeping_pending status]
  └── lib/find-or-create-person.ts — extract the existing send-router.ts race-safe pattern into a
       shared helper (Finding #22); update send-router.ts to call the extracted helper too
  └── lib/subscribe-token.ts (own domain key)
  └── lib/track-token.ts (open + click domain keys; opaque campaignLinkId payload)
  └── Extend lib/unsubscribe-token.ts for v2 (list_id) + domain-key separation
  └── Extend lib/send.ts's SendInput with unsubscribeContext (Finding #14)
  └── Extend lib/outbox.ts with campaignRecipientId correlation + bookkeeping_pending handling
       (Finding #13)
  └── Unit tests for all token libs (including cross-domain rejection) and find-or-create-person.ts

Phase 2 — List Management
  └── lists-router.ts (CRUD + member endpoints, archive-on-delete-with-campaigns)
  └── lib/list-import.ts (resumable CSV import job: R2-backed storage, staged-row cursor,
       cancellable — Finding #16)
  └── CSV export (streamed, formula-injection-safe)
  └── Integration tests

Phase 3 — Subscribe Forms
  └── subscribe-forms-router.ts (admin CRUD)
  └── public-subscribe-router.ts (POST /subscribe/:form_id, GET /subscribe/confirm/:token)
  └── subscribe_attempts-backed rate limiting + honeypot + fail-closed origin check
  └── Integration tests (single opt-in + double opt-in flows, abuse controls)

Phase 4 — Campaigns
  └── campaigns-router.ts (CRUD + send + schedule + cancel + retry)
  └── campaign-sender.ts (resumable fan-out coordinator: content snapshot, cursor-paged enqueue,
       conflict-ignored inserts, ambiguous-sendBatch-safe replay — Finding #15, #20)
  └── Extend queue consumer in index.ts for campaign_fan_out + campaign_send message types;
       campaign_send uses the atomic claim + reuses lib/outbox.ts's campaign-aware path
  └── Extend lib/send.ts (or a campaign-specific render path) for tracking pixel injection +
       opaque-token link rewriting
  └── public-track-router.ts (open pixel + click redirect via campaign_links lookup)
  └── campaigns-router.ts: add /stats/timeseries and /links sub-routes
  └── Hourly cron pass: scheduled→preparing trigger, scheduled→overdue sweep, stalled sweep,
       bookkeeping_pending reconciliation sweep (Finding #13), advisory stats rollup,
       subscribe_attempts/submittedIp/campaign_events retention cleanup (Finding #24)
  └── Integration + unit tests, including duplicate-delivery, crash-recovery, and
       completed_with_failures simulations
  └── Extend unsubscribe-router.ts for v2 token → atomic campaign_unsubscribe_attributions insert
       + list_members update (Finding #18)

Phase 5 — Frontend
  └── ListsPage, ListDetailPage, ListMembersTable (with import job progress UI)
  └── SubscribeFormsPage, SubscribeFormBuilderPage, FormSnippet
  └── CampaignsPage, CampaignDetailPage, CampaignStatsCard (targeted vs. delivered,
       overdue/stalled/completed_with_failures banners)
  └── Nav links in existing sidebar
  └── PersonDetail: add "List memberships" section (list name + status per list the person belongs to)
  └── PersonDetail: campaign sends surface in existing timeline automatically (sent_emails rows
       with campaignId rendered by the existing thread view; add a "campaign" badge to distinguish)
  └── Admin-only contact export/erasure UI (Finding #24)
  └── e2e tests
```

---

## Success Criteria

The feature is complete when:

- [ ] All phases above have passing unit + integration tests, including the duplicate-delivery, crash-recovery (`bookkeeping_pending` reconciliation), atomic-claim, and resumable-cursor tests from Testing Strategy
- [ ] `yarn tsc --noEmit` is clean
- [ ] Every migration in this feature applies via `yarn db:migrate:dev` against a clean local D1 without invoking `yarn db:generate` (Finding #19)
- [ ] An admin can complete this full flow without errors, on a Workers Paid environment (Finding #20):
  1. Create a list with double opt-in enabled
  2. Create a subscribe form for that list
  3. Submit the public form → receive confirmation email → click confirm → member appears as `subscribed`
  4. Import a CSV of 100 contacts into the same list (via the async job, polling to completion)
  5. Create a campaign targeting that list using an existing template
  6. Schedule the campaign → cancel → reschedule → send immediately
  7. Verify delivery stats (targeted vs. delivered), open count, and click count are correct in the UI
  8. Click the unsubscribe link from the campaign email → member status changes to `unsubscribed`, with `statsUnsubscribes` correctly attributed via `campaign_unsubscribe_attributions`
  9. Re-subscribe within the undo window → member status returns to `subscribed`
  10. Attempt to send the campaign again → receive 409 Conflict
  11. Simulate one permanently-rejected recipient in a send → campaign ends in `completed_with_failures`, not `sent`, and `POST /retry` correctly excludes it

---

## Decisions (resolved)

1. **Max list size:** Hard cap of **10,000 members per list** for v1, enforced at the API layer (return 422 if a send would exceed this). Fits saasmail's SaaS-team philosophy — beyond 10k you are in mass-marketing territory (Mailchimp's domain). Maps to a maximum of 100 Cloudflare Queue batch calls of 100 messages each.

2. **Template variable injection — hybrid approach:** `{{unsubscribe_url}}`, `{{subscriber_name}}`, and `{{subscriber_email}}` are **reserved variables** automatically injected during the per-subscriber render pass alongside any user-defined template variables. This means template authors can place `{{unsubscribe_url}}` anywhere in their template body (consistent with the existing `{{variable}}` convention). The tracking pixel (`<img>` tag) is still auto-appended as a post-process after rendering since it should not be manually placed by template authors. Reserved variable names are documented and blocked from being used as user-defined template variables.

3. **Default confirmation template:** Ship a **hardcoded built-in default** confirmation email in the worker code (plain HTML string constant). The list's `confirmationTemplateSlug` field is optional — when set, it overrides the default by rendering the named `email_templates` record instead. This matches Keila's behaviour: a default exists out of the box; admins can optionally customise it per-list. Double opt-in can therefore be enabled on any list without any template setup.

4. **Sent campaigns are immutable:** A campaign's `list_id`, `templateSlug`, `subject`, and `fromAddress` cannot be changed once `status` leaves `draft`. The API returns 409 Conflict on any PATCH to those fields when `status != 'draft'`. Enforced concretely via the content snapshot (Finding #8): the rendered `htmlSnapshot`/`textSnapshot`/`subjectSnapshot`/`fromAddressSnapshot` are frozen at snapshot time and are what actually gets sent, regardless of what the PATCH guard alone would allow.

5. **Stalled campaign recovery:** The hourly Cron trigger checks for campaigns where `status IN ('preparing', 'sending')` AND `updated_at < now() - 24 hours`. These are marked `status = 'stalled'` (a terminal status, distinct from `sent`/`completed_with_failures`). The advisory stats cache retains its partial values so the operator can see how many were delivered before the stall. The admin UI surfaces `stalled` (and `completed_with_failures`) campaigns with a warning banner and a "Retry" button (`POST /retry`) that re-enqueues only recipients with `campaign_recipients.status IN ('queued', 'retrying', 'retryable_failed')` via the atomic claim, preventing double-sends; `permanent_failed`/`unknown` recipients are flagged separately for manual review, never auto-retried. This avoids the silent "stuck forever" bug documented in [Keila issue #464](https://github.com/pentacent/keila/issues/464).

6. **Contacts vs. `people` (Finding #4, precedent corrected — Finding #22):** newsletter subscriber identity lives in a dedicated `contacts` table, not `people`. `contacts.personId` is populated lazily on the first successful campaign send, via a shared `findOrCreatePersonByEmail` helper extracted from the existing race-safe pattern in `worker/src/routers/send-router.ts` (select → `onConflictDoNothing` insert → re-select) — not from `sequence-processor.ts`, which only reads an already-existing `personId`. Import and form submission never touch `people` or pollute inbox/conversation views.

7. **Delivery idempotency & fan-out (Findings #1–#2, hardened — Finding #13, #15):** the existing write-ahead outbox (`worker/src/lib/outbox.ts`) is the delivery authority for campaign sends, extended with a `campaignRecipientId` correlation and a `bookkeeping_pending` status so a campaign outbox row survives from provider-success until the campaign's own `sent_emails`/`campaign_recipients`/`contacts.personId` bookkeeping completes — closing the crash window the first revision left open. Fan-out and CSV import are both modeled as resumable, cursor-paged jobs (`async_jobs`) rather than a single all-in-one-request operation, bounded by D1's per-invocation query budget and Cloudflare Queues' 100-message/256 KB `sendBatch()` limit. Every insert into `campaign_recipients` is conflict-ignored, and every per-recipient claim is an atomic conditional `UPDATE ... RETURNING`, not a read-then-write check. Delivery is **at-least-once with duplicate suppression**, not exactly-once.

8. **Statistics model (Finding #5, unsubscribe counter corrected — Finding #18):** `campaign_recipients`, `campaign_events`, and `campaign_unsubscribe_attributions` are the authoritative sources of truth. Only `statsTargeted` (set once at fan-out start) is a directly-written counter on the `campaigns` row. Every other stats column — including `statsUnsubscribes`, which the first revision incorrectly treated as a safe direct increment — is either an advisory cache refreshed asynchronously by the hourly cron rollup, or computed live on read from the authoritative ledger tables. Campaign completion is derived from a live `campaign_recipients` terminal-state check, never from counter equality.

9. **Click tracking tokens (Finding #9):** click tokens carry an opaque `campaignLinkId`, never a raw destination URL. Destination URLs are stored server-side in `campaign_links` and validated as `http:`/`https:` only. Subscribe-confirm, unsubscribe, open-tracking, and click-tracking tokens use separate domain-derived keys so a token leaked from one context (e.g. a pre-fetched open pixel) cannot be replayed against another.

10. **Scheduling SLA (Finding #7):** the hourly cron window is the documented v1 scheduling granularity. Scheduled campaigns more than 24h overdue move to a visible `overdue` status requiring explicit admin confirmation (`POST /send`) rather than being silently fired or silently discarded.

11. **Data lifecycle (Finding #12, retention defaults + export/erasure corrected — Finding #24):** lists with campaign history are archived, not hard-deleted. Removing a list member is a status change (`unsubscribed`) that preserves consent provenance, not a row delete. Concrete retention windows (30d IP, 24h abuse ledger, 13mo engagement events, 7d undo) and two authenticated admin-only export/erasure endpoints replace the first revision's "existing admin tooling" claim, which cited tooling that doesn't query these tables. See Privacy & Retention.

12. **Campaign v2 unsubscribe context (Finding #14):** `sendWithSuppressionCheck`'s `SendInput` gains an optional `unsubscribeContext`; when supplied (always, for campaign sends), it is used for every unsubscribe surface (body, footer fallback, both `List-Unsubscribe*` headers) instead of the helper's internally-generated v1 token. Every other call site is unaffected — omitting the field preserves today's exact v1 behavior.

13. **Campaign terminal/retry state model (Finding #17):** `campaign_recipients` failures split into `retryable_failed` (transient, retries exhausted, admin can manually retry) and `permanent_failed` (non-transient provider rejection, never retried). Campaigns split their terminal state into `sent` (no permanent failures) and `completed_with_failures` (at least one). `POST /retry` is valid from both `stalled` and `completed_with_failures`.

14. **Async job model for fan-out and import (Finding #16, #19):** the resumable-job table is named `async_jobs`, not `campaign_jobs`, and lands in the **first** migration (before `contacts`/`lists`) because `list_members.importJobId` must reference it and CSV import's migration necessarily precedes the campaigns migration. CSV import specifically stages its source file in the existing `env.R2` binding and parses it once into a durable staged-row cursor rather than re-parsing a raw byte offset on every page.

15. **Platform requirement and fan-out page size (Finding #20):** newsletter campaign sending requires **Workers Paid**. The 100-recipient coordinator page size is an application-level chunk chosen to align with Cloudflare Queues' `sendBatch()` limit (100 messages/256 KB) — not a D1 "100 statements per batch" limit, which does not exist (D1's actual per-query cap is 100 *bound parameters*). A rejected/ambiguous `sendBatch()` call is treated as unresolved publication and safely replayed at the page level, never as a partial success requiring per-message reconciliation.

16. **Click metric model (Finding #21):** the `campaign_events` click partial unique index enforces one row per `(campaign, contact, link)`, so "click count" and "unique clicker count" are the same number by construction. v1 exposes a single `clicks` metric per link; a separate raw (non-deduplicated) occurrence count is Future Considerations, requiring a second append-only event table.

---

## Second-Pass Implementation Gate

Every item below must be true before Phase 1 begins (mirrors `SPEC_ADVERSARIAL_REVIEW.md`'s "Updated Implementation Gate"):

- [x] The spec no longer claims the current `sendViaOutbox` helper already provides campaign crash recovery — it now specifies the `campaignRecipientId` correlation + `bookkeeping_pending` extension required to actually provide it (Finding #13)
- [x] The outbox schema and reconciliation contract include `campaignRecipientId` and post-provider bookkeeping (Finding #13)
- [x] Campaign v2 unsubscribe context is persisted and reproduced on retries (Finding #14)
- [x] Recipient claiming is a conditional atomic write (`UPDATE ... RETURNING`), not a read-then-write check (Finding #15)
- [x] Coordinator publication is explicitly replayable and every insert is conflict-safe (`onConflictDoNothing`) (Finding #15)
- [x] CSV jobs identify their R2 object/chunks (`async_jobs.storageKey`) and include `cancelled`/cleanup states (Finding #16)
- [x] Campaign terminal failure and retry semantics are internally consistent (`sent` vs. `completed_with_failures`; `retryable_failed` vs. `permanent_failed`) (Finding #17)
- [x] Unsubscribe attribution is backed by a unique ledger (`campaign_unsubscribe_attributions`) (Finding #18)
- [x] Migration numbering/workflow matches `migrations/README.md` (hand-authored SQL, no `drizzle-kit generate`, `async_jobs` ordered before `contacts`/`lists`) (Finding #19)
- [x] Workers Free/Paid support and fan-out page size are explicit (Paid required; 100-row pages justified against Queues, not a misattributed D1 limit) (Finding #20)
- [x] Click metric names match what the schema can compute (single `clicks`/unique-click metric) (Finding #21)
- [x] Contact linking (`findOrCreatePersonByEmail`, correct precedent) and privacy retention (concrete windows + admin export/erasure endpoints) have implementable workflows (Finding #22–#24)

---

## Future Considerations

Not in scope for v1 — captured here so the trade-offs aren't re-discovered later.

- **Dedicated campaign queue.** v1 reuses the existing `EMAIL_QUEUE` binding (`saasmail-sequence-emails`) for campaign fan-out via a discriminated-union message. This is the lowest-friction path and keeps all outbound sending on one consumer. The trade-off: a large campaign blast (up to 10k messages) shares consumer throughput and the `max_retries: 3` budget with sequence and transactional sends, so a blast could delay time-sensitive sequence/transactional delivery. A **separate `CAMPAIGN_QUEUE` binding** would isolate that traffic and allow independent `max_batch_size` / `max_retries` / concurrency tuning. It is a wrangler config change (new `queues.producers` + `queues.consumers` entry) plus a second consumer branch, not a code-architecture change — so it can be adopted later without reworking the fan-out logic. Revisit if campaign volume grows or if sequence/transactional latency regressions are observed under load.
- **Sub-hourly scheduling precision.** Delayed Cloudflare Queue messages or a sub-hourly cron trigger would tighten the scheduling SLA below the current ~59-minute window. Deferred because it's a wrangler infra change and the hourly window is an acceptable v1 trade-off (Finding #7).
- **Self-service (non-admin) data export/erasure.** v1 ships admin-only export/erasure endpoints (Finding #24); a subscriber-initiated self-service flow is deferred.
- **Turnstile on public subscribe forms.** An optional stronger anti-automation control beyond the honeypot + rate-limit ledger (Finding #6).
- **Workers Free support for newsletter sending.** Would require shrinking the fan-out coordinator's page size to roughly 25–40 recipients to stay inside Free's 50-queries-per-invocation budget (Finding #20); not pursued in v1 since Workers Paid is now a stated requirement.
- **Raw (non-deduplicated) click occurrence tracking.** Would require a second append-only event table alongside the unique-click `campaign_events` model, since the current partial unique index structurally caps clicks at one row per contact per link (Finding #21).
- **Repairing the upstream `0019`/`0020` `drizzle-kit` snapshot collision.** Not this feature's responsibility, but would re-enable `yarn db:generate` for all future schema work, not just this one (Finding #19).

