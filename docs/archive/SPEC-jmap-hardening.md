# SPEC: JMAP hardening — review follow-ups from #64 and #65

## Why

Both JMAP v1 PRs were merged with known findings from their second Codex review. None hits the current
Snowlan account (1 admin, 2 inboxes), but each is a real failure for larger accounts or crafted input:

- D1 accepts at most 100 bound parameters per statement. Several queries bind a list once per UNION arm
  (or twice per id) and fail with `serverFail` past a threshold.
- `Email/import`'s raw MIME scanner and postal-mime can still disagree about a part's boundary, so a
  crafted signed message can pass the "signed/encrypted mail is refused" rule.
- The import's 100-part limit is enforced after every part range has been built in memory.
- A push stream for a member with many inboxes can pass its 40-query budget before its loop starts.

## 1. Bind inbox lists once (D1 100-parameter limit)

**Files:** `worker/src/lib/inbox-permissions.ts` (`inboxScopeSql`), then every other list bind the audit
below finds in `worker/src/lib/messages/query.ts`, `worker/src/jmap/thread-changes.ts`,
`worker/src/jmap/drafts.ts`, `worker/src/jmap/emails.ts`, `worker/src/jmap/event-source.ts`,
`worker/src/jmap/state.ts`, `worker/src/jmap/changes.ts`.

- `inboxScopeSql(allowed, column)`: for a member, `AND <column> IN (SELECT value FROM json_each(?))` with the
  inbox list bound once as a JSON array (admins unchanged: no clause; an empty list stays `AND 0`). One
  parameter whatever the grant size, for all 11 callers.
- Audit every SQL statement built from a list on the JMAP and message-read paths (`IN ${array}`,
  `sql.join` of values, VALUES lists, repeated arms): each must stay under 100 parameters for any input
  size, either by binding the list once as JSON through `json_each` or by chunking on the **combined**
  count across all arms. Known offenders from review:
  - `thread-changes.ts` draft lookup (binds each id twice) — overflows at ~50 changed drafts.
  - `thread-changes.ts` member query (thread keys and allowed inboxes repeated in both arms) — overflows for
    a member with ~30 inboxes.
  - `inMailboxOtherThan` exclusions (`excludeFolders` / `DraftFilter.exclude`) in `query.ts` / `drafts.ts` —
    overflow at ~17 custom folders.
  - The shared message query's received and sent arms (the follow-up read of `threadKeyForMessageId` in
    `email-create.ts`) — overflow for a member with 45+ inboxes.
- `currentJmapSeqQueries` (`state.ts`) becomes **one** statement for a member (inbox list bound once as JSON)
  plus nothing else, so a push tick costs exactly one query for any grant size. The 40-inbox chunk loops in
  `state.ts` and `changes.ts` are replaced by the JSON bind.
- Mailbox counts: `Mailbox/get` computes counts only for the mailboxes it returns (after applying `ids`), and
  `Mailbox/query` computes none unless its filter or sort needs them (today neither does). A `Mailbox/get`
  with `ids: null` for a grant whose mailbox list exceeds `maxObjectsInGet` answers `requestTooLarge`
  before any count query (RFC 8620 §5.1 allows this); document it.

## 2. Push stream budget at connect

**File:** `worker/src/jmap/event-source.ts`.

- Enforce the 40 ceiling in the counting `env.DB` wrapper itself, from the first query of the request
  (auth, allowed inboxes, fingerprint, first seq, the initial re-check): a statement that would be the 41st
  is refused before it runs. A refusal before the initial state event closes the stream cleanly with no
  event (for the HTTP route: still `200` with an empty `text/event-stream` body plus `retry:`, so clients
  back off and reconnect); a refusal later behaves as the existing budget stop. The initial re-check
  reserves its cost like the per-tick re-check does.

## 3. `Email/import`: one strict Content-Type grammar

**File:** `worker/src/jmap/email-import.ts`.

The scanner and postal-mime must never interpret a part differently. postal-mime's parameter parser isn't
exported, so the scanner accepts only a narrow, explicit grammar for every `Content-Type` (at any depth)
and refuses anything else with `invalidEmail`, nothing stored:

```
content-type = type "/" subtype *( OWS ";" OWS parameter ) OWS [";" OWS]
parameter    = attribute "=" value
attribute    = token                      ; compared case-insensitively
value        = token / quoted-string
quoted-string = DQUOTE *( qtext / "\\" CHAR ) DQUOTE   ; backslash escapes decoded
token        = 1*<RFC 2045 token chars>
```

- RFC 822 comments are stripped first (existing `stripComments`), then the grammar applies to what is left.
- Refused: a segment without `=` (e.g. `rogue`), a missing value, an unterminated quote, anything after a
  closing quote other than OWS / `;` / end, a duplicate attribute (already refused), any attribute ending in
  `*` or containing `*<digit>` (RFC 2231 extended/continued forms) on `Content-Type` **except** `name*`,
  and a type or subtype that isn't a token.
- `Content-Disposition` gets the same grammar, with RFC 2231 allowed only for `filename*` (non-ASCII
  attachment names), because it decides body vs attachment.
- Tests: the reviewer's messages (`boundary=seen; boundary*0=real; boundary*1=x` with `multipart/signed`
  under `--realx`; `boundary=seen; rogue; boundary=real`) and one case per refused class, each at top level
  and nested two levels down → `invalidEmail`, no draft/content/blob rows, no R2 objects.
- Unchanged (regression list): the existing import tests' valid messages (text+HTML, attachment, inline
  image, `message/rfc822`, quoted boundary, folded headers, `filename*=utf-8''…`, iso-8859-1 bodies) still
  import with the same stored draft.

## 4. `Email/import`: stop splitting at the part limit

**File:** `worker/src/jmap/email-import.ts` (`splitMultipart`, `walk`).

- Split lazily (a generator or an index scan that yields one part range at a time) and stop as soon as the
  total part count passes 100, so a < 5 MiB message of many short boundary lines never materialises more
  than 101 ranges. Same `invalidEmail` as today.
- Test: a message just under the size limit made of 200,000+ minimal parts is refused with the part-limit
  error, and the split allocates at most 101 ranges (assert through an exported counter or by checking the
  generator is consumed only that far).

## Patterns to copy

- JSON list binding: `threadKeyForMessageId` in `worker/src/jmap/email-create.ts` (`WITH scope_inboxes(value)
  AS (SELECT value FROM json_each(?))`).
- Query counting in tests: the counting `env.DB` proxies in `jmap-event-source-edges.test.ts` and
  `jmap-query-changes.test.ts`.

## Gotchas

- Worker strict mode is off; `yarn typecheck` ratchet 434; Prettier enforced.
- `json_each` over a TEXT column value compares as TEXT; inbox addresses are stored lowercased on the
  columns these clauses filter — keep whatever normalisation `allowed.inboxes` has today (don't change
  case handling in this PR).
- Tests that seed many permission rows must insert them in chunks (a single multi-row insert of 32+ rows
  itself overflows D1).

## Done means

1. `yarn format:check`, `yarn typecheck`, `yarn test`, `yarn test:web` pass.
2. A member with **150** granted inboxes (seeded in chunks) plus one inbox they are **not** granted
   (control, with mail in it), each statement's bound-parameter count recorded through an `env.DB` proxy
   and asserted ≤ 100:
   - `Email/query` (Inbox of inbox #1): returns that inbox's ids, `canCalculateChanges: true`; never ids of
     the control inbox.
   - `Email/get` of those ids: the objects; the control inbox's email id → `notFound`.
   - `Email/changes` / `Email/queryChanges` after a new email in inbox #150: it appears (created / added at
     index 0).
   - `Mailbox/get` with the six ids of inbox #1: six mailboxes with correct counts; with `ids: null`:
     `requestTooLarge`, and no count query ran.
   - `Mailbox/query`: all 900 ids, no count queries.
   - `Thread/get` and `Thread/changes` for a new thread in inbox #150: `created: [thread]`.
   - `Email/set` create and `Email/import` of a reply with `In-Reply-To` to mail in inbox #150: `created`,
     with the original's thread id.
   - Web `GET /api/messages?inbox=<#1>`: that inbox's messages only.
   - Push stream: first state event arrives; total queries ≤ 40 until close.
3. `Thread/changes` with 300 changed drafts in one thread: `created: [thread]` within its 30-query budget.
4. `inMailboxOtherThan` naming 60 custom folders: exactly the emails outside those folders.
5. Push connect budget: grants arranged so connect alone costs 39, 40 and 41 queries → the first two serve
   events (41st never run), the third closes with no event and a `retry:`; never more than 40 statements.
6. Every refused Content-Type/Content-Disposition class in §3 (top level and nested) → `invalidEmail`,
   nothing stored; every regression-list message imports with the same stored draft as before.
7. A < 5 MiB message of 200,000+ minimal parts → the part-limit `invalidEmail`, and the lazy split yields
   at most 101 ranges.
8. Named regressions unchanged: mailbox counts for the verifier's seeded mix (Inbox 4/3, Sent 2/0, Archive
   1/1, Junk 1/1, Drafts 2) and the existing `jmap.test.ts` / `jmap-changes-api.test.ts` expectations pass
   untouched.
