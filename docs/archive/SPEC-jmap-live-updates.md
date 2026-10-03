# SPEC: JMAP live updates and search (aerc as the reference client)

## Why

aerc (via go-jmap) is the first real JMAP client pointed at saasmail. It reads mail since #62/#63 but:

- never sees new mail or changes made elsewhere until restarted: it has no polling and relies on
  EventSource push (`eventSourceUrl` is `""` today), then `Email/queryChanges` (how it inserts new
  messages into an open folder) and `Thread/changes`;
- lists only the newest 256 messages of a folder: it sends `Email/query` with no `limit` and never pages;
  saasmail silently caps at 256 (`MAX_OBJECTS_IN_GET`);
- can't search or show its "All mail" folder: it uses `subject`, `body`, `inMailboxOtherThan` and a
  `FilterOperator` AND wrapper, none of which saasmail accepts.

Owner decisions (2026-09-28): query ceiling 10,000 with RFC `limit` reporting; push checks every 10 s,
keepalive every 30 s, stream closes after 5 min (or a query budget), initial state on connect unless
`closeafter=state`; keep the architecture simple (a streaming Worker response, no Durable Object).

Out of scope: `Email/import` (next spec), `Mailbox/set`, `to`/`cc`/`header` filters, OR/NOT operators,
sort options other than `receivedAt` descending, `Identity` and `EmailDelivery` push types.

## 1. EventSource push (RFC 8620 §7.3)

**Files:** new `worker/src/jmap/event-source.ts`; route in `worker/src/jmap/http.ts`; Session in
`worker/src/jmap/methods.ts` (`makeSession`); constants in `worker/src/jmap/constants.ts`; cheap seq
check in `worker/src/jmap/state.ts`.

- Session: `eventSourceUrl: \`${origin}/jmap/eventsource/?types={types}&closeafter={closeafter}&ping={ping}\``
  (absolute, same origin rule as `apiUrl`, see #62).
- Route: `GET /jmap/eventsource/` and `GET /jmap/eventsource` → same handler. Auth exactly like
  `/.well-known/jmap` (`authenticateJmap`; bearer or session cookie; 401 problem+json otherwise).
- Query parameters (all optional):
  - `types`: `*` or a comma list of type names. Supported types: `Email`, `Mailbox`, `Thread`,
    `EmailSubmission`. Unknown names are ignored. If none remain, the stream still runs (pings and
    keepalives only).
  - `closeafter`: `state` or `no` (default `no`). Anything else → 400 problem+json.
  - `ping`: non-negative integer seconds (default 0 = no ping events). Anything else → 400. A nonzero
    value is clamped to [10, 300] and rounded up to a multiple of the 10 s tick; the `ping` event's data
    is `{"interval": <actual seconds>}`.
- Response: `200`, `Content-Type: text/event-stream; charset=utf-8`, `Cache-Control: no-cache,
  no-transform`, body a `ReadableStream`. First bytes: `retry: 5000\n\n`.
- State: all four types share one state string today (`currentJmapState`). Compute the fingerprint
  (`stateFingerprint`) once at connect; per tick run only the seq queries (`currentJmapSeqQueries`: one
  query for an admin, one per 40-inbox chunk plus one for a member) and rebuild the string with
  `formatJmapState(seq, issuedAt(now), fp)` (issuedAt is the day bucket; export a helper instead of
  duplicating the arithmetic). Snapshot `allowed` at connect for the seq checks, but **before sending any
  `state` event** (initial or on change) re-authenticate the caller (same user/API-key lookup as the route)
  and re-resolve `allowed`; if the credential is gone or the inbox fingerprint changed, close the stream
  without sending the event. These re-checks count toward the query budget.
- Events:
  - On connect, unless `closeafter=state`: one `state` event with every requested type's current state.
  - Each tick (every 10 s): if the state string differs from the last one sent (or, with
    `closeafter=state`, from the one at connect), send
    `event: state\ndata: {"@type":"StateChange","changed":{"<accountId>":{"Email":"…","Mailbox":"…","Thread":"…","EmailSubmission":"…"}}}\n\n`
    with only the requested types (one line of JSON). With `closeafter=state`, close right after it.
  - `ping` events at the clamped interval when `ping > 0`.
  - A comment line `: keepalive\n\n` whenever 30 s passed without any bytes written (Cloudflare closes
    idle connections at 100 s).
- Lifetime: close cleanly after 5 minutes **or** once the stream has used 40 D1 queries, whichever
  comes first (per-tick cost is the number of seq queries; the free plan allows 50 queries per
  invocation). Clients reconnect (aerc loops on a clean close; browsers honour `retry`).
- Stop on client disconnect (`cancel()` of the stream, or a write that throws) and on a DB error (close
  the stream; do not send partial events). No unhandled rejections.
- Testability: the loop takes injected `sleep(ms)`, `now()` and `checkSeq()` so tests drive ticks without
  real time. Export the pure pieces (parameter parsing, event formatting, the tick loop) from
  `event-source.ts`.

## 2. `Email/queryChanges` (RFC 8620 §5.6) and `canCalculateChanges`

**Files:** `worker/src/jmap/emails.ts` (share the filter/sort parsing with `emailQuery`),
`worker/src/jmap/changes.ts` (changed Email ids since a state), `worker/src/jmap/methods.ts` (dispatch
before the generic `/(changes|queryChanges)$/` fallback).

- Arguments: `accountId`, `filter`, `sort`, `sinceQueryState`, `maxChanges`, `upToId`, `calculateTotal`,
  `collapseThreads`. Same filter/sort validation and errors as `Email/query` (reuse, don't copy).
  `collapseThreads` other than absent/false → `invalidArguments` `["collapseThreads"]`, exactly as
  `Email/query` does today (`emails.ts` ~line 729).
- `sinceQueryState` validation = `validateSinceState` in `changes.ts` (bad, foreign-fingerprint, too old
  or over-window state → `cannotCalculateChanges`).
- Consistency rule (applies to `Thread/changes` too): read the current state **first**, then read the
  changes and the results. `newQueryState` is that first state. A write landing during assembly may show
  up in `added` and be reported again by the next call (idempotent for clients); it can never be missed.
- Algorithm:
  - From the change log since the state (the same grouping, `classify` and `publicIdForChangeObject`
    mapping `emailChanges` uses, no paging): `createdIds` (first op `c`) and `touchedIds` (updated or
    destroyed, i.e. every other changed id).
  - Current results = the full ordered id list of the query (same code path as `Email/query`, position 0,
    limit = the ceiling). If the result would exceed the ceiling → `cannotCalculateChanges`.
  - `removed` = `touchedIds` (each may or may not have been in the old results; RFC allows the extras).
    Newly created ids are **not** in `removed`: they were never in the old results.
  - `added` = `[{id, index}]` for each id of `createdIds ∪ touchedIds` present in the current results,
    ordered by index.
  - If `maxChanges` is given and `removed.length + added.length > maxChanges` → `tooManyChanges`
    (RFC 8620 §5.6 counts both arrays).
  - `upToId`: RFC says it only applies to immutable sort/filter; our filters include mutable ones
    (keywords, mailboxes), so accept and ignore it.
  - `oldQueryState` = the argument, `newQueryState` = current state, `total` when `calculateTotal`.
- `Email/query` returns `canCalculateChanges: true` when the whole result fits the ceiling (known when
  the page starts at 0 and returns fewer than the ceiling, or from `total` when computed), otherwise
  `false`; `Email/queryChanges` answers `cannotCalculateChanges` in exactly those cases.

## 3. `Thread/changes`

**Files:** `worker/src/jmap/changes.ts` (or a new `thread-changes.ts`), `worker/src/jmap/methods.ts`.

- `sinceState`/`maxChanges` validation as `emailChanges`. `newState` = current state.
- For the Emails changed since the state: load the ones that still exist (Email/get's loading path), take
  their current thread ids, and for each thread load its Email ids (Thread/get's path). A thread is
  `created` when every Email in it was created since the state, otherwise `updated`.
- `destroyed`: threads can't be recovered for destroyed Emails (the change log keeps no thread key).
  Report none; document that a thread whose last Email was destroyed is not reported (a client that asks
  `Thread/get` for it gets `notFound`). Returning `cannotCalculateChanges` instead was rejected: aerc logs
  it on every push and never advances its thread state, and it threads client-side anyway. A test pins
  this: destroying a thread's last Email gives a successful response with that thread in no array.
- More than `maxChanges` threads → `hasMoreChanges` is not possible without paging state; return
  `cannotCalculateChanges` instead (clients then refetch).

## 4. Filters and the result ceiling

**Files:** `worker/src/jmap/emails.ts` (`hasOnlySupportedFilterFields`, `emailQuery`),
`worker/src/lib/messages/query.ts` (a subject-only / body-only search mode),
`worker/src/jmap/drafts.ts` (`draftWhereSql` same modes), `worker/src/jmap/constants.ts`.

- Operators: a `FilterOperator` with `operator: "AND"` whose conditions flatten (recursively) into one
  condition with no property given twice is that condition. Any operator with exactly one condition
  (except `NOT`) is that condition. Anything else (OR/NOT with ≥2 conditions, AND repeating a property,
  nested non-flattenable) → `unsupportedFilter`.
- `subject: string`: subject contains, case-insensitive (existing `subject` search mode).
- `body: string`: one rule everywhere, **case-insensitive substring of the stored text body** (so a
  substring inside a word matches). Received: `e.body_text LIKE` (not FTS); sent: `se.body_text LIKE`;
  drafts: the text body values through `json_each(c.body_values_json)` exactly as `draftWhereSql` does for
  `text` today (values, never the JSON structure). `text` keeps today's behaviour. Only one of
  `text`/`subject`/`body` per query; two → `unsupportedFilter`.
- `inMailboxOtherThan: Id[]`: the Email is in none of the listed mailboxes. Unknown ids are ignored.
  Extract from `stateScope` (`query.ts`) an exported `folderMembershipSql(folder, kind, idColumn,
  inboxColumn)` that returns the positive predicate for one folder (today's per-folder branches, unchanged
  behaviour for existing callers), and add `MessageQuery.excludeFolders: {inbox, folder}[]` that each arm
  turns into `AND NOT (<inboxColumn> = inbox AND <folderMembershipSql>)`. The draft arm gets the same via
  `DraftFilter.exclude: {inbox, role | mailboxId}[]` in `draftWhereSql`. May combine with `inMailbox`.
- Ceiling: `MAX_QUERY_RESULTS = 10_000` in `constants.ts` is the **per-request page size** (the largest
  `limit`), not a cap on the result set: `position` beyond it still works and `total` counts everything.
  `Email/query` without `limit`, or with a larger one, uses 10,000 and returns `"limit": 10000` (RFC 8620
  §5.5); a smaller limit (including 0) is used as given and not echoed. The internal query and
  queryChanges helpers take the ceiling as a parameter (default the constant) so tests can exercise the
  boundary with a small value. `Email/get` stays at `maxObjectsInGet: 256`.

## 5. Docs

- `docs/jmap.md`: push section (URL, params, types, timing, lifetime, reconnect); `Email/queryChanges`
  and `Thread/changes` semantics including the over-report and the missing destroyed threads; new filters
  and the operator rule; the 10,000 ceiling. Remove push and `queryChanges` from the limitations list.
- `CHANGELOG.md` → `Unreleased` → `Added`.

## Patterns to copy

- Method dispatch and error mapping: the `Email/changes` block in `methods.ts`.
- Since-state validation, change grouping, public ids: `emailChanges` in `changes.ts`.
- Route + auth: `/.well-known/jmap` in `http.ts`.
- Tests: `worker/src/__tests__/jmap-changes-api.test.ts` (states, changes), `jmap.test.ts` (`jmapJson`,
  `addIdentity`, fixtures), `jmap-to-addresses.test.ts` (Email/get over real rows).

## Gotchas (from project memory / CLAUDE.md)

- Worker strict mode is off: unions don't narrow; use casts or a nullable `error` field, as `methods.ts`
  does with `JmapMethodError`.
- `yarn typecheck` is the gate (worker ratchet 434; new files must add 0 errors). Prettier is enforced.
- D1 rejects statements with too many bound parameters: chunk id lists (see `ALIAS_LOOKUP_CHUNK`, the
  40-inbox chunks).

## Done means

1. `yarn format:check`, `yarn typecheck` (ratchet not above 434), `yarn test`, `yarn test:web` pass.
2. Session `eventSourceUrl` is absolute with the three template variables (test).
3. EventSource tests with injected clock/sleep: initial state event; a change (insert a `jmap_changes` row
   or make one via `Email/set`) produces exactly one `state` event with only the requested types;
   `closeafter=state` sends no initial event and closes after the first change; `ping=15` emits pings with
   `{"interval":20}`; keepalive comment after 30 s of silence; the stream ends at 5 min and at the query
   budget; a revoked API key (or a removed inbox permission) closes the stream before the next `state`
   event is sent; 401 without auth; 400 for bad `closeafter`/`ping`; a route-level test reads the first
   event over `exports.default.fetch` and cancels.
4. `Email/queryChanges`: after a new received Email in the Inbox, `added` has it at index 0 and `removed`
   does not; after marking one seen with a `notKeyword: "$seen"` filter it is in `removed` and not
   `added`; applying the response to the cached id list of the earlier `Email/query` gives exactly the new
   `Email/query` ids (reconciliation test); `tooManyChanges` when `maxChanges` is one less than
   `removed + added`, success at exactly that sum; stale/foreign state → `cannotCalculateChanges`; the same
   filter validation errors as `Email/query`; state-first ordering (a write injected between the state read
   and the result read, via a hooked `env.DB` as in `shared-drafts-readonly.test.ts`, is reported by the
   next call).
5. `Thread/changes`: a new Email in a new thread → `created`; a reply joining an existing thread →
   `updated`; destroying a thread's last Email → success with that thread in no array; bad state →
   `cannotCalculateChanges`.
6. Filters: `subject`; `body` with the same substring-inside-a-word term matching a received, a sent and a
   draft body (and a draft whose JSON structure, not its text, contains the term does not match);
   `inMailboxOtherThan` (excluding one inbox's Junk and Trash keeps the other inbox's Junk and Trash mail);
   AND-flattening (aerc's exact shapes: AND[{inMailbox, subject}], AND[{inMailbox},{hasKeyword}]); OR of
   two `from` → `unsupportedFilter`.
7. Ceiling: 300 Emails in a folder → `Email/query` with no `limit` returns all 300 and `"limit": 10000`;
   `limit: 50` returns 50 and no `limit` key; `limit: 0` returns no ids; with the ceiling parameter set to
   5 over 6 Emails: the page is 5, `position: 5` returns the 6th, `canCalculateChanges` is false and
   `Email/queryChanges` answers `cannotCalculateChanges`; with exactly 5 Emails it is true.
8. Live (after deploy), aerc with `use-labels = true` and `Inbox — hello@snowlan.app` open: no
   `jmap listen` error for 10 minutes (across at least one stream reconnect); a message sent to
   hello@snowlan.app from Gmail appears in the open folder within 20 s of saasmail storing it; a flag
   changed in the web shows in aerc within 20 s; `:search` by subject finds a known message; "All mail"
   lists messages.
