# Implementation Roadmap

Updated: 2026-09-22

This file tracks the implementation stages built on top of saasmail's existing
customer timeline, inbox permissions, newsletters, sequences, MCP/WebMCP, and
delivery infrastructure.

## Stage 1 — Unified mail foundation

### 1A — Unified message read model ✅ Complete

Merged in PR #3 (`19f0418`).

- One application-level `UnifiedMessage` contract over exactly
  `emails ∪ sent_emails`.
- One permission-scoped `queryMessages()` service for cross-direction reads.
- Customer timeline, message search, and group-conversation detail now use the
  shared service.
- Deterministic ordering, opaque cursor pagination, offset compatibility,
  optional attachment enrichment, and existing search semantics are covered by
  tests.
- Operational delivery/workflow tables remain outside the user-visible message
  stream.
- No schema migration and no change to legacy shared `emails.is_read`
  semantics.

### 1B — Message state and provenance

Planned:

- Add per-user message state (for example seen/starred) separately from shared
  mailbox/conversation state.
- Preserve the existing shared `emails.is_read` behavior until the support
  workflow semantics are migrated deliberately.
- Add sequence provenance to the unified message contract. Candidate schema:
  an additive `sent_emails.sequence_id` reference (or equivalent stable
  provenance field), then expose it through `UnifiedMessage.source`.

## Stage 2 — Native agent runtime

Planned after the Stage 1 message/state contracts are stable. Agent reads and
actions should consume the same application services as HTTP, MCP, and WebMCP
instead of introducing another mail query path.

## Stage 3 — Mailbox views and scale

Planned mailbox views include Inbox, Sent, Starred, Archive, Snoozed, Spam,
Trash, and later custom mailboxes/folders.

Before mailbox-scale reads become a primary workload, address these query
follow-ups from the Stage 1A review:

1. **Restore inbox-index use under case-insensitive authorization.**
   `lower(e.recipient)` and `lower(se.from_address)` prevent the existing
   inbox/timestamp indexes from being used efficiently. Choose and enforce one
   canonical strategy before mailbox-scale rollout: canonical lowercase at
   write time, `COLLATE NOCASE` columns/indexes, or functional indexes. Once
   the storage/index contract guarantees case-insensitive matching, remove
   runtime `lower()` from the hot scope predicate where possible.

2. **Bound each union arm before the final merge/sort.** The current unified
   query filters each source but lets SQLite materialize all matching rows
   before the outer `ORDER BY … LIMIT`. For mailbox-scale pagination, push a
   compatible `ORDER BY … LIMIT offset+limit+1` (or cursor equivalent) into
   each source subquery before `UNION ALL`, then perform the final deterministic
   merge ordering. Keep parity tests around equal-second tie-breaking and
   cursor boundaries while doing this.

These are performance follow-ups, not Stage 1A correctness blockers.
