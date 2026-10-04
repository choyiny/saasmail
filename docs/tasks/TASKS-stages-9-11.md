# Tasks: stages 9–11 (trust and safety, triage, data ownership)

Written 2026-10-03 from a comparison with [cf-mailroom](https://github.com/wong2/cf-mailroom) and
[Mailflare](https://github.com/hieunc229/mailflare). Mailflare is AGPL-3.0: a functional reference
only, never a source (roadmap principle). Mailroom is Apache-2.0.

One spec per PR, in `docs/specs/`. Each spec opens with the decisions it proposes; change them in the
file **before** starting its PR, never silently in code (the house rule: when code contradicts the
spec, stop and fix the spec). When a PR merges, `git mv` its spec here → `docs/archive/` and add a
line to `docs/archive/README.md`.

## Order

| #   | Spec                       | Stage     | Why here                                                                                        | Migration                                                                | Label          |
| --- | -------------------------- | --------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | -------------- |
| 1   | `SPEC-reply-to.md`         | 9         | Smallest correctness fix; no dependencies                                                       | `emails.reply_to`                                                        | minor          |
| 2   | `SPEC-audit-log.md`        | 9         | Everything after it emits events through it                                                     | `audit_events`                                                           | minor          |
| 3   | `SPEC-send-idempotency.md` | 9         | Needed before agents send more                                                                  | `send_idempotency`                                                       | minor          |
| 4   | `SPEC-send-controls.md`    | 9         | Pause, `MCP_SEND_ENABLED`, daily caps; shares the send-route changes of #3                      | `send_counters`                                                          | minor          |
| 5   | `SPEC-two-factor.md`       | 9         | better-auth plugin + D1 rate-limit storage                                                      | auth tables (`yarn auth:generate` first), `auth_rate_limits`             | minor          |
| 6   | `SPEC-reject-inbound.md`   | 10        | Splits the rules evaluator (match before storage); #8 needs that                                | none                                                                     | minor          |
| 7   | `SPEC-ai-folders.md`       | 10        | Folder colour/description + `ai_file` action on the queue                                       | `mailboxes.color`, `ai_description`                                      | minor          |
| 8   | `SPEC-spam-learning.md`    | 10        | Learned Bayes filter + `spam_probability` condition                                             | `spam_models`, `spam_tokens`, `spam_training`, `emails.spam_probability` | minor          |
| 9   | `SPEC-mail-export.md`      | 11        | mbox export job, `.eml` download; opens the Data UI                                             | `async_jobs.params`, `requested_by`, enum                                | minor          |
| 10  | `SPEC-mail-import.md`      | 11        | Extracts the inbound storage helper; mbox/eml import                                            | `async_jobs` enum                                                        | minor          |
| 11  | `SPEC-backups.md`          | 11        | Daily D1 dump to R2, restore script                                                             | `backup_runs`                                                            | minor          |
| 12  | `SPEC-header-threading.md` | 10 (last) | Rekeys conversations and resets JMAP accounts; batched with the JMAP `replyTo` exposure from #1 | `thread_key` ×2, `sender_identities.threading_mode`                      | minor or major |

Migrations are numbered at implementation time (next free is 0074 as of this writing). Every schema
migration also updates `applyMigrations()` in `worker/src/__tests__/helpers.ts`; a data-only change
uses `yarn db:generate --custom` and a hand-chained snapshot (AGENTS.md).

## Progress

Updated by whoever works a spec (the loop prompt in `LOOP-stages-9-11.md` does it each run). States:
`todo` → `branch spec/<slug>` → `PR #N open` → `merged <sha>` → `archived`.

| #   | Spec                       | Status      |
| --- | -------------------------- | ----------- |
| 1   | `SPEC-reply-to.md`         | archived    |
| 2   | `SPEC-audit-log.md`        | archived    |
| 3   | `SPEC-send-idempotency.md` | archived    |
| 4   | `SPEC-send-controls.md`    | archived    |
| 5   | `SPEC-two-factor.md`       | archived    |
| 6   | `SPEC-reject-inbound.md`   | archived    |
| 7   | `SPEC-ai-folders.md`       | archived    |
| 8   | `SPEC-spam-learning.md`    | PR #74 open |
| 9   | `SPEC-mail-export.md`      | todo        |
| 10  | `SPEC-mail-import.md`      | todo        |
| 11  | `SPEC-backups.md`          | todo        |
| 12  | `SPEC-header-threading.md` | todo        |

## Shared conventions the specs rely on

- **Audit actor context** (spec 2) is an `AsyncLocalStorage` set at each boundary; later specs name
  the channel (`web | api | mcp | jmap | agent | rule | inbound | cron | queue | import`).
- **Queue jobs** go on the existing `EMAIL_QUEUE` with a new `type`; no new queue, no new cron
  schedule (`scheduled()` runs every job on every tick). New hourly maintenance is appended to the
  chain in `worker/src/index.ts` and prunes in bounded batches.
- **Limits at the boundary**: caps and idempotency live in the HTTP/MCP/JMAP routes and tools, not in
  `sendViaOutbox` (except the pause, which is deliberately a dispatch halt).
- **D1 parameter cap**: every list bind is JSON through `json_each` or chunked at 40.
- **Model calls** use `selectModel(env)` (D18) with D38's reasoning-off options; tests use the mock
  `LanguageModel` pattern from the 2c tests; e2e never has a provider.
- **New dependencies** (`qrcode.react` in #5; the AWS SDK only for `s3://` in #11's script) are pinned
  exactly, followed by `yarn install --update-checksums`.

## Deploy notes to collect as PRs merge

- #5: `yarn db:migrate:prod` before deploy (new auth tables); optional `TWO_FACTOR_ISSUER`.
- #4: optional `MCP_SEND_ENABLED`; the pause and caps are settings, no deploy needed.
- #11: optional `BACKUPS` binding and `BACKUP_ENCRYPTION_KEY` secret; backups stay off until enabled
  in Settings → Data.
- #12: every JMAP client resyncs after an inbox's conversation mode changes (expected, documented).

## Out of scope (decided 2026-10-03)

- Calendar, invites and booking pages (Mailflare): a second product; revisit "booking links on the
  customer timeline" after stage 10.
- Docker / non-Cloudflare runtime: Stage 8 stays deferred.
- Forcing every user onto TOTP: the passkey gate already guarantees a strong registered factor.
