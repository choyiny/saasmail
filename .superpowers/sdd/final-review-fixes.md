# Final-Review Fixes — Outbox Pattern

## Fix 1 — Write-ahead row must be unclaimable during inline attempt

**What changed:** `worker/src/lib/outbox.ts` — in `sendViaOutbox`, the insert now uses `nextRetryAt: now + 3600` (instead of `now`), with an explanatory comment. The transient-failure branch continues to reset to `after` (due now) — unchanged.

**RED (before fix):** New test `"keeps the write-ahead row unclaimable while the inline attempt is in flight"` observed `nextRetryAt` equal to `now`, so `expect(observedNextRetryAt).toBeGreaterThan(Math.floor(Date.now() / 1000))` failed.

**GREEN (after fix):** `nextRetryAt` is `now + 3600` during the in-flight call; test passes.

---

## Fix 2 — Transient retry must flip sent_emails (and sequence step) back to "retrying"

**What changed:** `worker/src/lib/outbox.ts` — in the transient branch of `attemptOutboxRow`, after updating the outbox row, we also idempotently set `sentEmails.status = "retrying"` where `id = row.sentEmailId`, and if `row.sequenceEmailId` set `sequenceEmails.status = "retrying"`. Comment explains no-op on normal cron path, matters on manual retry revival.

**RED (before fix):** New test `"flips a failed sent email back to retrying on a transient re-attempt"` found `sent[0].status` still `"failed"` after a transient attempt.

**GREEN (after fix):** `sent[0].status` is `"retrying"`; test passes.

---

## Fix 3 — Compound keyset cursor for GET /api/outbox

**What changed:** `worker/src/routers/outbox-router.ts`:

- Added `or` to drizzle-orm import.
- `orderBy` changed to `desc(outboxEmails.createdAt), desc(outboxEmails.id)`.
- Cursor format changed to `"${createdAt}_${id}"` (split on first `_`, ids are nanoids which may contain `_`).
- Where clause for cursor: if no `_` in cursor → old `lt(createdAt, ...)` (backward compat); otherwise compound `or(lt(createdAt, c), and(eq(createdAt, c), lt(id, cid)))`.

**Test updates (`worker/src/__tests__/outbox-router.test.ts`):**

- `seedRow` helper gained optional `createdAtOffset` to stamp distinct timestamps.
- "lists outbox rows newest first" now seeds rows with distinct `createdAt` values and asserts `ob-2` (newer) before `ob-1` (older).
- New tie-break test: 3 rows with same `createdAt`, `?limit=2`, follow `nextCursor`, assert all 3 distinct ids with no duplicates/losses.
- New 404 tests: retry and cancel on nonexistent id both return 404.

**GREEN:** All new tests pass.

---

## Fix 4 — Stale doc strings

**What changed:**

- `worker/src/routers/emails-router.ts` (~line 57): status description now mentions `'retrying'` alongside `'sent'` and `'failed'`.
- `worker/src/db/sequence-emails.schema.ts` line 11: status comment updated to `// pending, queued, sent, cancelled, failed, suppressed, retrying`.

---

## Verification Results

1. **Targeted suite** (`outbox-lib`, `outbox-processor`, `outbox-router`): **24 passed** (was 19; +5 new tests). 0 failures.
2. **`yarn tsc --noEmit`**: Clean, no errors.
3. **Full serialized suite** (`yarn test --run --no-file-parallelism`): **455 passed | 1 skipped | 0 failures** (53 test files).

## Commit

`fix(outbox): final-review fixes — in-flight claim guard, retrying flip, keyset cursor (#151)`
