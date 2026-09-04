# Newsletter Module — Tasks

Ordered by dependency. See [`plan.md`](./plan.md) for slices and risks, [`SPEC.md`](../SPEC.md) for
the contract.

Slices **0–B are expanded** (near-term, detail is trustworthy). Slices **C–I are stubs** —
expanded when reached, so their detail is not written speculatively against code that does not
exist yet.

---

## Slice 0 — Environment bootstrap ✅ complete

- [x] **0.1 Install yarn, then dependencies**
  - `yarn` and `corepack` were both absent (nvm node v26.7.0 ships npm only).
    Installed globally: `npm install -g yarn` → yarn 1.22.22.
  - `yarn install --frozen-lockfile` → done in 314s, `node_modules/` present.

- [x] **0.2 Test harness config + green baseline**
  - `cp wrangler.jsonc.ci wrangler.jsonc && mkdir -p dist/client` (both gitignored).
  - **Baseline: 80/80 files, 788 passed, 1 skipped, 0 failed.**
  - ⚠️ **Use `yarn test --maxWorkers=4` locally.** Bare `yarn test` fails ~21 files with 5s
    timeouts on this machine — 18 cores and no worker cap in `vitest.config.test.ts` means the
    Cloudflare pool starts a `workerd` per test file and they starve each other. The failures are
    nondeterministic (21 then 23 across runs) and every file passes alone. Capping workers is also
    _faster_ (40.7s vs 45.6s). This is machine-specific; do **not** change the committed vitest
    config to work around it.

- [x] **0.3 Local D1 + `db:generate` verified**
  - `yarn db:migrate:dev` applied all 35 migrations (0000–0034) cleanly; `.wrangler/state/v3/d1`
    now exists.
  - `yarn db:generate` runs clean → _"No schema changes, nothing to migrate"_, no snapshot errors,
    no journal diff. **Empirically confirms the spec's corrected migration workflow** — the
    0019/0020 collision is repaired and generate is the right tool.
  - The `.ci` config worked for both (same `database_name: saasmail-db`), so plan R4's config
    tension did not materialise — `.ci` covers tests _and_ migrations. Leave it in place.

- [x] **0.4 Branching base — decided**
  - `origin` is the fork `mrkpatchaa/saasmail`; there is no `upstream` remote and no certainty the
    spec PR is ever taken upstream, so blocking on a merge was not viable. Slice branches are cut
    from `spec/newsletter-revalidation` and the spec travels with the code. Current branch:
    `feat/newsletter-lists`. Rebase later if upstream ever lands the spec.

---

## Slice A — Lists + members CRUD + export ✅ complete (481b4ad)

- [x] **A.1 `async_jobs` + `contacts` schemas and migration**
  - Acceptance: both tables defined per spec §Database Schema and re-exported from `schema.ts`;
    migration generated, **not** hand-written
  - Verify: `yarn db:generate` then `yarn db:migrate:dev` against fresh D1; `yarn tsc --noEmit`
  - Files: `worker/src/db/async-jobs.schema.ts`, `worker/src/db/contacts.schema.ts`,
    `worker/src/db/schema.ts`, `migrations/00XX_*.sql` + its `meta/` snapshot & journal entry
  - Note: re-read `migrations/meta/_journal.json` for the next free `idx` first (plan R5)

- [x] **A.2 `lists` + `list_members` schemas and migration**
  - Acceptance: tables per spec, including `unique(listId, contactId)` and the consent-provenance
    columns; `importJobId` FK resolves to `async_jobs`
  - Verify: `yarn db:generate` → `yarn db:migrate:dev`; `yarn tsc --noEmit`
  - Files: `worker/src/db/lists.schema.ts`, `worker/src/db/list-members.schema.ts`,
    `worker/src/db/schema.ts`, `migrations/00XX_*.sql` + snapshot/journal

- [x] **A.3 `findPersonIdByEmail` read-only helper (TDD)**
  - Acceptance: returns an existing person's id; returns `null` for an unknown address **and
    writes no `people` row** (spec Decision 23)
  - Verify: `yarn test worker/src/__tests__/find-person.test.ts` — write the failing test first
  - Files: `worker/src/lib/find-person.ts`, `worker/src/__tests__/find-person.test.ts`

- [x] **A.4 `lists-router` — list CRUD**
  - Acceptance: GET/POST/GET:id/PATCH/DELETE per spec §1, with the archive-vs-hard-delete rule
    (archive when campaign history exists, hard-delete when none); Zod OpenAPI schemas so `/doc`
    stays accurate; admin + inbox-scoped member auth per the Authorization Matrix
  - Verify: integration tests covering both delete paths and a scoped-member rejection
  - Files: `worker/src/routers/lists-router.ts`, `worker/src/index.ts`,
    `worker/src/__tests__/lists-router.test.ts`

- [x] **A.5 Member endpoints — add, list, unsubscribe**
  - Acceptance: add creates a `contacts` row (never a `people` row); remove is a **status change**
    to `unsubscribed`, never a row delete; list is paginated and status-filterable; the 10,000-member
    cap is enforced on add
  - Verify: integration tests, including one asserting `SELECT COUNT(*) FROM people` is unchanged
    across member adds
  - Files: `worker/src/routers/lists-router.ts`, `worker/src/__tests__/lists-router.test.ts`

- [x] **A.6 CSV export — streamed and formula-injection-safe**
  - Acceptance: streams rather than buffering; any cell beginning `=`, `+`, `-`, `@` is prefixed
    with `'`; honours `?status=`
  - Verify: unit test on the escaping helper + an integration test on the route
  - Files: `worker/src/routers/lists-router.ts`, `worker/src/lib/csv.ts`,
    `worker/src/__tests__/csv.test.ts`

- [x] **A.7 Checkpoint** — tsc clean, `yarn test --maxWorkers=4` 83 files / 824 passed / 0 failed,
      prettier clean. Two harness gotchas found: `applyMigrations` is a hardcoded DDL list (not a
      reader of `migrations/`) and `cleanDb` a hardcoded DELETE list, so **every new table must be
      added to both** or it will not exist in tests and will leak rows between them.

---

## Slice B — CSV import (async job) ✅ complete (0089778)

- [x] **B.1 Queue message discriminated union + legacy fallback (TDD, plan R3)**
  - Acceptance: `handleQueueBatch` branches on `type`; a message with **no** `type` is processed as
    a sequence email (deploy-window safety), not dropped or infinitely retried
  - Verify: a test that feeds an untyped legacy message and asserts sequence handling
  - Files: `worker/src/lib/sequence-processor.ts`, `worker/src/index.ts`,
    `worker/src/__tests__/queue-routing.test.ts`

- [x] **B.2 R2 upload + `async_jobs` row + 202 response**
  - Acceptance: `POST /api/lists/:id/members/import` streams to `env.R2` at `imports/{jobId}.csv`,
    creates the job row, enqueues one coordinator message, returns 202 `{ jobId }`
  - Verify: integration test asserting the R2 object and job row exist and nothing was parsed inline
  - Files: `worker/src/routers/lists-router.ts`, `worker/src/lib/list-import.ts`,
    `worker/src/__tests__/list-import.test.ts`

- [x] **B.3 Cursor-paged coordinator with RFC 4180 staging**
  - Acceptance: first invocation stages the R2 object into row-addressable records; later pages use
    a **staged-row** cursor (not a byte offset), so a multiline quoted field survives a page
    boundary; `status = 'cancelled'` stops re-enqueue
  - Verify: 10,000-row import test + an explicit multiline-quoted-field-across-page-boundary test
  - Files: `worker/src/lib/list-import.ts`, `worker/src/__tests__/list-import.test.ts`

- [x] **B.4 Import semantics — dedup, skips, caps, cleanup**
  - Acceptance: first occurrence of a duplicate email wins (`duplicate_in_file` in `skippedCount`);
    invalid emails skipped with reasons capped at 50; imports land `subscribed` with
    `consentSource: 'import'`; 10MB/10k limits; R2 object deleted after a 24h retention window
  - Verify: integration tests per rule
  - Files: `worker/src/lib/list-import.ts`, `worker/src/__tests__/list-import.test.ts`

- [x] **B.5 Job progress + cancel endpoints**
  - Acceptance: `GET .../import/:jobId` reports progress; `DELETE` cancels
  - Verify: integration test polling a job to completion, and one cancelling mid-run
  - Files: `worker/src/routers/lists-router.ts`, `worker/src/__tests__/lists-router.test.ts`

- [x] **B.6 Checkpoint** — typecheck, test, format

---

## Slice C — Subscribe forms ✅ complete (04d086a)

- [x] **C.1 `subscribe_forms` + `subscribe_attempts` schemas and migration**
  - Acceptance: tables per spec §Database Schema; `subscribe_attempts` stores `emailHash`
    (SHA-256 of the lowercased address), never the raw address, since it is a high-write ledger
  - Verify: `yarn db:generate` → `yarn db:migrate:dev`; add both to `applyMigrations` **and**
    `cleanDb` in `__tests__/helpers.ts`
  - Files: 2 schema files, `db/index.ts`, `db/schema.ts`, `__tests__/helpers.ts`, migration

- [x] **C.2 `subscribe-token.ts` — HMAC confirm tokens (TDD)**
  - Acceptance: signs `{v, formId, contactId, exp}` with a key derived for the _subscribe-confirm_
    domain; round-trips; rejects a tampered signature, a wrong key, a malformed token, and an
    expired one; a token signed for another domain fails verification here
  - Verify: unit tests written first
  - Files: `lib/subscribe-token.ts`, `__tests__/subscribe-token.test.ts`
  - Note: domain separation is shared with the unsubscribe/tracking tokens — decide the key
    derivation helper here since this is the first of the four domains to land.

- [x] **C.3 Admin CRUD for forms**
  - Acceptance: `/api/subscribe-forms` list/create/read/update/delete, admin-only per the
    Authorization Matrix; `GET /:id` returns the embed snippet
  - Verify: integration tests including a member being refused
  - Files: `routers/subscribe-forms-router.ts`, `index.ts`, tests

- [x] **C.4 Public `POST /subscribe/:form_id` + `GET /subscribe/confirm/:token`**
  - Acceptance: mounts **outside** `/api` (session middleware is scoped to `/api/*`); single and
    double opt-in flows; idempotent re-submit; 422 on invalid email; confirm is idempotent and
    410s on an expired token
  - Verify: integration tests for both flows
  - Files: `routers/public-subscribe-router.ts`, `index.ts`, tests

- [x] **C.5 Abuse controls**
  - Acceptance: honeypot `_hp` returns 200 without writing; 4 KB body cap → 413; 10
    submissions/IP/hour and 2 confirmation resends per (form, emailHash)/hour via
    `subscribe_attempts`; `allowedOrigins` fails **closed** (missing Origin is a non-match);
    all rejections share one generic message; the 10,000-member cap is enforced here too
  - Verify: integration tests per control, including one proving the attempts ledger catches a
    repeat submission against an _existing_ pending membership (which a `list_members` count cannot)
  - Files: `routers/public-subscribe-router.ts`, `lib/subscribe-abuse.ts`, tests

- [x] **C.6 Confirmation email**
  - Acceptance: sends via the existing send path using `confirmationTemplateSlug`, falling back to
    a built-in default HTML constant so double opt-in works with no template setup
  - Verify: integration test asserting a send was attempted with the confirm URL in the body
  - Files: `lib/subscribe-confirmation.ts`, `routers/public-subscribe-router.ts`, tests

- [x] **C.7 Checkpoint** — tsc, `yarn test --maxWorkers=4`, format

## Slice D — Campaign core ✅ complete (d8530ec, b1fa909, f06b41f)

Campaign tables + `sent_emails.campaignId` → **outbox extension first** (`campaignRecipientId`,
`bookkeeping_pending`, reconciliation-before-claim, R1 regression tests) → resolve R2 (recompute
the v2 unsubscribe URL in `attemptOutboxRow`) → `SendInput.unsubscribeContext` → content snapshot
(incl. `html-to-text.ts` for `textSnapshot`) → cursor-paged fan-out coordinator → per-recipient
handler with the atomic claim → completion check → hourly cron pass → load test (R6).

## Slice E — Tracking ✅ complete (039a1cc)

`campaign_links`, `campaign_events` + the two partial unique indexes (raw SQL via
`yarn db:generate --custom`) → `track-token.ts` → HTMLRewriter link rewriting (HTML part only) →
public pixel + click routes → stats endpoints.

## Slice F — Per-list unsubscribe ✅ complete (db2a07c)

`unsubscribe-token.ts` v2 branch (v1 must keep verifying) →
`campaign_unsubscribe_attributions` → unsubscribe handler batch (attribution insert + guarded
membership update) → cross-campaign/cross-list token rejection.

## Slice J — Privacy, retention and backfill ✅ complete

Not in the original slice list — found while re-reading the spec's Privacy &
Retention section against the code. Three of its requirements had no
implementation at all, and two library comments referred to an "hourly
backfill" that did not exist.

- [x] **J.1 `list_members.submittedIp` 30-day sweep** — bounded batch, the
      membership row is kept (it is the consent record); only the IP is cleared
- [x] **J.2 `campaign_events` 13-month sweep** — bounded batch; an unbounded
      DELETE over thirteen months of events is the statement that times out and
      then never succeeds on any later tick either
- [x] **J.3 `contacts.personId` backfill** — links subscribers who have since
      become correspondents; never creates a `people` row (Decision 23)
- [x] **J.4 `GET /api/contacts/:email/export`** — subject-access, admin only
- [x] **J.5 `POST /api/contacts/:email/erase`** — keyed-HMAC pseudonym, not a
      bare digest: email addresses are low-entropy, so a plain SHA-256 is
      reversible with a dictionary and would not be erasure at all. Rows are
      kept and rewritten — they are the evidence a suppression happened
- [x] **J.6 Cron wiring test** — a sweep that is never called from the entry
      point is indistinguishable from one that was never written, and the
      worker typecheck does not cover that call path

## Slice G — Frontend ✅ complete

- [x] **G.1 ListsPage + ListDetailPage + ListMembersTable** (import job progress)
- [x] **G.2 SubscribeFormsPage + SubscribeFormBuilderPage + FormSnippet**
- [x] **G.3 CampaignsPage + CampaignDetailPage + CampaignStatsCard**
      (targeted vs delivered; overdue/stalled/completed_with_failures banners;
      24h chart; links table; "~opens"/"~clicks" labels per the accuracy caveat)
- [x] **G.4 Sidebar nav links**
- [x] **G.5 PersonDetail — list memberships section + campaign badge in timeline**
- [x] **G.6 Admin contact export/erasure UI** (backed by slice J)
- [x] **G.7 e2e tests**

`ListsPage`, `ListDetailPage`, `ListMembersTable`, `SubscribeFormsPage`,
`SubscribeFormBuilderPage`, `FormSnippet`, `CampaignsPage`, `CampaignDetailPage`,
`CampaignStatsCard`, sidebar nav, PersonDetail list-memberships section. Imperative
`useState`/`useEffect` + `fetch`, matching `AdminUsersPage` — no `useQuery`.

## Slice H — WebMCP read tools ✅ complete

- [x] **H.1** `list_newsletter_lists`, `get_newsletter_list`, `list_campaigns`,
      `get_campaign_stats` — read only (Decision 27: no action tools in v1)

Extend `createReadTools` in `src/webmcp/tools/read.ts`: `list_newsletter_lists`,
`get_newsletter_list`, `list_campaigns`, `get_campaign_stats`. **No action tools** (spec
Decision 27).

## Slice I — Docs and release

- [x] **I.1** `docs/newsletters.md`, linked from `docs/README.md`
- [x] **I.2** `CHANGELOG.md` `## [Unreleased]` entry
- [x] **I.3** `PROVIDER_DAILY_SEND_LIMIT` in `wrangler.jsonc.example`
- [ ] **I.4** PR semver label — applied by a maintainer when the PR is opened (AGENTS.md); nothing to do in the branch

`docs/newsletters.md` linked from `docs/README.md`; `CHANGELOG.md` `## [Unreleased]` entry;
`PROVIDER_DAILY_SEND_LIMIT` documented in `wrangler.jsonc.example`; request a semver label.
