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

- [ ] **0.4 Decide the branching base** — _blocking, needs a human answer_
  - Acceptance: either the spec PR is merged to `main` and slices branch from `main`, or we agree
    slice branches cut from `spec/newsletter-revalidation`
  - Verify: n/a — a decision, recorded here
  - Files: none

---

## Slice A — Lists + members CRUD + export

- [ ] **A.1 `async_jobs` + `contacts` schemas and migration**
  - Acceptance: both tables defined per spec §Database Schema and re-exported from `schema.ts`;
    migration generated, **not** hand-written
  - Verify: `yarn db:generate` then `yarn db:migrate:dev` against fresh D1; `yarn tsc --noEmit`
  - Files: `worker/src/db/async-jobs.schema.ts`, `worker/src/db/contacts.schema.ts`,
    `worker/src/db/schema.ts`, `migrations/00XX_*.sql` + its `meta/` snapshot & journal entry
  - Note: re-read `migrations/meta/_journal.json` for the next free `idx` first (plan R5)

- [ ] **A.2 `lists` + `list_members` schemas and migration**
  - Acceptance: tables per spec, including `unique(listId, contactId)` and the consent-provenance
    columns; `importJobId` FK resolves to `async_jobs`
  - Verify: `yarn db:generate` → `yarn db:migrate:dev`; `yarn tsc --noEmit`
  - Files: `worker/src/db/lists.schema.ts`, `worker/src/db/list-members.schema.ts`,
    `worker/src/db/schema.ts`, `migrations/00XX_*.sql` + snapshot/journal

- [ ] **A.3 `findPersonIdByEmail` read-only helper (TDD)**
  - Acceptance: returns an existing person's id; returns `null` for an unknown address **and
    writes no `people` row** (spec Decision 23)
  - Verify: `yarn test worker/src/__tests__/find-person.test.ts` — write the failing test first
  - Files: `worker/src/lib/find-person.ts`, `worker/src/__tests__/find-person.test.ts`

- [ ] **A.4 `lists-router` — list CRUD**
  - Acceptance: GET/POST/GET:id/PATCH/DELETE per spec §1, with the archive-vs-hard-delete rule
    (archive when campaign history exists, hard-delete when none); Zod OpenAPI schemas so `/doc`
    stays accurate; admin + inbox-scoped member auth per the Authorization Matrix
  - Verify: integration tests covering both delete paths and a scoped-member rejection
  - Files: `worker/src/routers/lists-router.ts`, `worker/src/index.ts`,
    `worker/src/__tests__/lists-router.test.ts`

- [ ] **A.5 Member endpoints — add, list, unsubscribe**
  - Acceptance: add creates a `contacts` row (never a `people` row); remove is a **status change**
    to `unsubscribed`, never a row delete; list is paginated and status-filterable; the 10,000-member
    cap is enforced on add
  - Verify: integration tests, including one asserting `SELECT COUNT(*) FROM people` is unchanged
    across member adds
  - Files: `worker/src/routers/lists-router.ts`, `worker/src/__tests__/lists-router.test.ts`

- [ ] **A.6 CSV export — streamed and formula-injection-safe**
  - Acceptance: streams rather than buffering; any cell beginning `=`, `+`, `-`, `@` is prefixed
    with `'`; honours `?status=`
  - Verify: unit test on the escaping helper + an integration test on the route
  - Files: `worker/src/routers/lists-router.ts`, `worker/src/lib/csv.ts`,
    `worker/src/__tests__/csv.test.ts`

- [ ] **A.7 Checkpoint** — `yarn tsc --noEmit && yarn test && yarn format:check`

---

## Slice B — CSV import (async job)

- [ ] **B.1 Queue message discriminated union + legacy fallback (TDD, plan R3)**
  - Acceptance: `handleQueueBatch` branches on `type`; a message with **no** `type` is processed as
    a sequence email (deploy-window safety), not dropped or infinitely retried
  - Verify: a test that feeds an untyped legacy message and asserts sequence handling
  - Files: `worker/src/lib/sequence-processor.ts`, `worker/src/index.ts`,
    `worker/src/__tests__/queue-routing.test.ts`

- [ ] **B.2 R2 upload + `async_jobs` row + 202 response**
  - Acceptance: `POST /api/lists/:id/members/import` streams to `env.R2` at `imports/{jobId}.csv`,
    creates the job row, enqueues one coordinator message, returns 202 `{ jobId }`
  - Verify: integration test asserting the R2 object and job row exist and nothing was parsed inline
  - Files: `worker/src/routers/lists-router.ts`, `worker/src/lib/list-import.ts`,
    `worker/src/__tests__/list-import.test.ts`

- [ ] **B.3 Cursor-paged coordinator with RFC 4180 staging**
  - Acceptance: first invocation stages the R2 object into row-addressable records; later pages use
    a **staged-row** cursor (not a byte offset), so a multiline quoted field survives a page
    boundary; `status = 'cancelled'` stops re-enqueue
  - Verify: 10,000-row import test + an explicit multiline-quoted-field-across-page-boundary test
  - Files: `worker/src/lib/list-import.ts`, `worker/src/__tests__/list-import.test.ts`

- [ ] **B.4 Import semantics — dedup, skips, caps, cleanup**
  - Acceptance: first occurrence of a duplicate email wins (`duplicate_in_file` in `skippedCount`);
    invalid emails skipped with reasons capped at 50; imports land `subscribed` with
    `consentSource: 'import'`; 10MB/10k limits; R2 object deleted after a 24h retention window
  - Verify: integration tests per rule
  - Files: `worker/src/lib/list-import.ts`, `worker/src/__tests__/list-import.test.ts`

- [ ] **B.5 Job progress + cancel endpoints**
  - Acceptance: `GET .../import/:jobId` reports progress; `DELETE` cancels
  - Verify: integration test polling a job to completion, and one cancelling mid-run
  - Files: `worker/src/routers/lists-router.ts`, `worker/src/__tests__/lists-router.test.ts`

- [ ] **B.6 Checkpoint** — typecheck, test, format

---

## Slice C — Subscribe forms _(stub — expand when reached)_

Schemas (`subscribe_forms`, `subscribe_attempts`) → `subscribe-token.ts` (own domain key, 48h
`exp`) → admin CRUD router → public `POST /subscribe/:form_id` + `GET /subscribe/confirm/:token`
→ abuse controls (honeypot, 4KB body cap, rate limits, fail-closed origin check, generic errors)
→ ingestion-side control-character stripping on `contacts.name`.

## Slice D — Campaign core _(stub — expand when reached)_

Campaign tables + `sent_emails.campaignId` → **outbox extension first** (`campaignRecipientId`,
`bookkeeping_pending`, reconciliation-before-claim, R1 regression tests) → resolve R2 (recompute
the v2 unsubscribe URL in `attemptOutboxRow`) → `SendInput.unsubscribeContext` → content snapshot
(incl. `html-to-text.ts` for `textSnapshot`) → cursor-paged fan-out coordinator → per-recipient
handler with the atomic claim → completion check → hourly cron pass → load test (R6).

## Slice E — Tracking _(stub)_

`campaign_links`, `campaign_events` + the two partial unique indexes (raw SQL via
`yarn db:generate --custom`) → `track-token.ts` → HTMLRewriter link rewriting (HTML part only) →
public pixel + click routes → stats endpoints.

## Slice F — Per-list unsubscribe _(stub)_

`unsubscribe-token.ts` v2 branch (v1 must keep verifying) →
`campaign_unsubscribe_attributions` → unsubscribe handler batch (attribution insert + guarded
membership update) → cross-campaign/cross-list token rejection.

## Slice G — Frontend _(stub)_

`ListsPage`, `ListDetailPage`, `ListMembersTable`, `SubscribeFormsPage`,
`SubscribeFormBuilderPage`, `FormSnippet`, `CampaignsPage`, `CampaignDetailPage`,
`CampaignStatsCard`, sidebar nav, PersonDetail list-memberships section. Imperative
`useState`/`useEffect` + `fetch`, matching `AdminUsersPage` — no `useQuery`.

## Slice H — WebMCP read tools _(stub)_

Extend `createReadTools` in `src/webmcp/tools/read.ts`: `list_newsletter_lists`,
`get_newsletter_list`, `list_campaigns`, `get_campaign_stats`. **No action tools** (spec
Decision 27).

## Slice I — Docs and release _(stub)_

`docs/newsletters.md` linked from `docs/README.md`; `CHANGELOG.md` `## [Unreleased]` entry;
`PROVIDER_DAILY_SEND_LIMIT` documented in `wrangler.jsonc.example`; request a semver label.
