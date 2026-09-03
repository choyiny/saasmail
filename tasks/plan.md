# Implementation Plan: Newsletter Module

Derived from [`SPEC.md`](../SPEC.md) (revalidated 2026-09-03, commit `a9b258c`).
This plan does not restate the spec — it decides **order, risk, and verification points**.

## Scope check

The spec bundles capabilities that are independently testable (lists, subscribe forms, campaigns,
tracking, WebMCP). Its **Implementation Order** section already fixes module boundaries and a build
order, so it serves as the capability map; this plan refines those six phases into nine
independently verifiable slices and does not renumber or re-scope them.

## Dependency graph

```
                    async_jobs ──────────────┐
                        │                    │
   contacts ────────────┼───────────┐        │
       │                │           │        │
       ▼                ▼           ▼        ▼
   lists + list_members (A) ──► subscribe_forms (C)
       │                              (+ subscribe_attempts)
       │                    │
       ├────► CSV import (B)│  [needs async_jobs + R2 + queue union]
       │                    │
       ▼                    ▼
   campaigns + campaign_recipients (D)  ◄── outbox_emails.campaignRecipientId
       │                                     + bookkeeping_pending
       ├────► campaign_links + campaign_events (E: tracking)
       ├────► campaign_unsubscribe_attributions (F: unsubscribe v2)
       │
       ▼
   Frontend (G) ──► WebMCP read tools (H) ──► docs + CHANGELOG (I)
```

Hard ordering constraints:

- `async_jobs` must land before `list_members` (`importJobId` FK) and before `campaigns`
  (`fanOutJobId` FK).
- `contacts` before `list_members`, `campaign_recipients`, `campaign_events`.
- The outbox extension must land before the campaign send path can terminalize a recipient.

## Build order (nine slices)

| #   | Slice                                            | Depends on | Ships independently? |
| --- | ------------------------------------------------ | ---------- | -------------------- |
| 0   | Environment bootstrap                            | —          | n/a (prerequisite)   |
| A   | Lists + members CRUD + export                    | 0          | yes                  |
| B   | CSV import (async job, R2, queue union)          | A          | yes                  |
| C   | Subscribe forms + public submit/confirm          | A          | yes                  |
| D   | Campaign core: schema, fan-out, outbox extension | A          | yes                  |
| E   | Open/click tracking                              | D          | yes                  |
| F   | Per-list unsubscribe (v2 token + attribution)    | D          | yes                  |
| G   | Frontend pages                                   | A–F        | yes, per page        |
| H   | WebMCP read tools                                | A, D       | yes                  |
| I   | `docs/newsletters.md` + CHANGELOG                | all        | required to merge    |

**Parallelizable:** B, C, and D are independent once A lands (different tables, different routers).
E and F are independent of each other once D lands. G can start per-page as each API lands.

**Strictly sequential:** 0 → A → {B, C, D} → {E, F} → G/H → I.

## Risks

**R1 — The outbox `bookkeeping_pending` change touches live transactional and sequence delivery.
(highest risk)**
`attemptOutboxRow` claims rows with `WHERE status = 'pending'` and unconditionally calls
`sendWithSuppressionCheck`. A `bookkeeping_pending` row must **never** reach that call — it would
re-send a message the provider already accepted. Mitigation: reconciliation is a separate branch
that runs _before_ the claim and returns early; add a regression test asserting a
`bookkeeping_pending` row makes zero provider calls. Land the outbox change with sequence/
transactional regression tests green before any campaign code depends on it.

**R2 — Unsubscribe URL reverts to v1 on outbox retry. (spec gap found while planning)**
`sendWithSuppressionCheck` overwrites `List-Unsubscribe` with a freshly minted **v1** token
(`send.ts:156`). The outbox stores `headers`, but the retry path re-runs
`sendWithSuppressionCheck`, so a campaign retry would silently downgrade the recipient's v2
per-list link to a v1 global one — violating the spec's "including on retry" acceptance criterion.
The spec specifies `unsubscribeContext` for the _inline_ send but never says how the retry path
reproduces it. **Decision needed in slice D:** recompute the v2 URL inside `attemptOutboxRow` from
`campaignRecipientId` (preferred — no new storage, single source of truth) rather than persisting
the URL on the outbox row. Recorded here so it is not rediscovered mid-implementation.

**R3 — Queue discriminated union changes an existing consumer.**
`handleQueueBatch` is typed `MessageBatch<SequenceEmailMessage>` with no `type` field. Messages
in flight at deploy carry no `type`. Mitigation: treat absent `type` as a sequence message; test
that path explicitly before adding campaign message types.

**R4 — ~~`yarn db:generate` needs a local D1 that does not exist yet.~~ RESOLVED in slice 0.**
`yarn db:migrate:dev` creates the local D1 on its own — `yarn dev` was not needed. The anticipated
config tension did not materialise: `wrangler.jsonc.ci` declares the same `database_name`
(`saasmail-db`) as `.example`, so one config serves tests _and_ migrations. `yarn db:generate`
verified working (clean "no schema changes" run), which confirms the spec's corrected workflow.

**R7 — The local test suite is flaky under parallelism. (found in slice 0, revised in slice C)**
Bare `yarn test` fails ~21 files with 5s timeouts on this 18-core machine: the Cloudflare pool
starts a `workerd` per file with no cap and they starve each other. `--maxWorkers=4` is the working
default, but it is **not a complete fix** — a single unrelated file (`emails-router`) failed once at
that setting and then passed 4/4 in isolation and on two consecutive full runs. **Never conclude
from one red run that a change broke something**: re-run the file alone, then the full suite, before
believing it. Do not "fix" this by editing the committed vitest config; it is machine-specific and
CI does not exhibit it.

**R8 — `yarn tsc --noEmit` does not typecheck the worker at all. (found in slice C)**
The root `tsconfig.json` sets `"files": []` and references only `tsconfig.app.json`, whose
`include` is `["src"]` — the frontend. Worker code is covered only by `worker/tsconfig.json`, which
no documented command runs. This is how a genuine bug (two undefined identifiers in `index.ts`'s
cron wiring) passed a "clean" typecheck; only a test that actually executed the path caught it.

Mitigation while working here: run `npx tsc -p worker/tsconfig.json --noEmit` as well, and compare
against the baseline rather than expecting zero. That config reports pre-existing errors repo-wide —
`CloudflareBindings` unresolved in 12 files, a `BufferSource` variance in `unsubscribe-token.ts`,
and zod-openapi multi-status handler-type friction in **every** router (sequences 9, emails 7,
suppressions 3). Judge new code by whether it adds error _kinds_, not by a zero count.

Worth raising with the maintainers as a repo issue, but out of scope for this feature.

**R5 — Migration numbers drift.** The plan assumes `0035+`. Re-read
`migrations/meta/_journal.json` immediately before each `yarn db:generate`.

**R6 — Scale claims are unverified.** The spec asserts Workers Paid is required and a 10k send
completes in 100 coordinator pages, without a measured basis. Not a blocker for A–C; must be
load-tested during D before the fan-out is considered done.

## Verification checkpoints

Between every slice, all of:

```bash
yarn tsc --noEmit
yarn test --maxWorkers=4     # see R7 — required locally, and still occasionally flaky
npx tsc -p worker/tsconfig.json --noEmit   # see R8 — `yarn tsc` skips worker/ entirely
yarn format:check
```

Slice-specific gates:

- **After 0:** ✅ green baseline recorded — 80/80 files, 788 passed, 1 skipped, 0 failed. Any red
  test from here is attributable to our changes, not the harness.
- **After A:** integration tests cover list CRUD, member add/unsubscribe, export; `yarn db:migrate:dev` applies cleanly to a fresh D1.
- **After B:** 10k-row import completes across resumed pages; a multiline-quoted CSV field survives a page boundary.
- **After D:** duplicate-delivery, crash-recovery (`bookkeeping_pending`), and `completed_with_failures` tests pass; **sequence + transactional regression suites still green** (R1).
- **After E/F:** dedup holds under replayed pixel/click requests; concurrent unsubscribes attribute exactly once.
- **Before merge:** `yarn test:e2e`, `docs/newsletters.md` linked from `docs/README.md`, `CHANGELOG.md` `## [Unreleased]` entry, semver label requested.

## Branching

The spec lives on `spec/newsletter-revalidation`, not yet merged to `main`. Repo convention is to
branch off `main`. Recommendation: open the spec PR first and merge it, then branch
`feat/newsletter-lists` off `main` per slice. Until that happens, slice branches are cut from
`spec/newsletter-revalidation` so the spec travels with the code — **decision pending, see
`todo.md` task 0.4.**

## Out of scope (v1)

Per spec Future Considerations: dedicated campaign queue, sub-hourly scheduling, Turnstile,
Workers Free support, raw click-occurrence counts, provider-level idempotency headers,
self-service export/erasure, unarchive endpoint, WebMCP action tools.
