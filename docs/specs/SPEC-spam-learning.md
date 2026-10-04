# SPEC: A spam filter that learns from the team's marks

Stage 10 (triage), slice 3 of 3. Depends on `docs/archive/SPEC-reject-inbound.md` (the pre-storage matching pass:
the new condition must be computable before storage) and `docs/archive/SPEC-audit-log.md`. Label `minor`.

## Why

Our only spam signal is `X-Spam-Score` from upstream, when a provider sets it (D14: "only effective when
upstream sets `X-Spam-Score`"), plus a fixed per-inbox threshold. Marking a message as junk changes its
folder and nothing else; the same sender's next message lands in Inbox again. Mailflare ships "local
spam filtering with training". A naive-Bayes filter trained by the team's own junk/not-junk marks is
small, well understood (Graham's _A Plan for Spam_ with Robinson's corrections, what SpamAssassin's
Bayes and Thunderbird use), runs in a Worker with a handful of D1 reads, and needs no provider.

## Decisions (proposed 2026-10-03)

1. One model per inbox (`spam_tokens` keyed by inbox): a sales inbox and a support inbox see different
   mail. Enabled per inbox (`spam_models.enabled`), default off.
2. The filter **learns only from humans**: a user marking junk (`setMailboxState` with a non-null
   `userId` and `spam: true`) trains spam; a user marking not-junk (`spam: false` on a message that was
   junk) or **replying** to a message (`replyToEmail` with a user actor — never the auto-reply, never a
   rule) trains ham. System and rule actions (D14 threshold, `mark_spam`, D21) never train, so the
   filter can't feed on its own output; neither does a mail import (audit channel `import`,
   SPEC-mail-import), which replays old state rather than expressing a judgement. Each message is trained at most once per label; flipping the
   label retrains (subtract the old counts, add the new).
3. The filter **only scores**: new inbound mail gets `emails.spam_probability` (0–1) when the inbox's
   model is enabled and has at least 20 spam and 20 ham training messages. Acting on the score is a
   rule: a new condition `spam_probability gte/lte` with the existing `mark_spam` action (silent, like
   D21/D28). The Inboxes page offers a one-click "Create the junk rule" (threshold 0.9). No second
   hidden threshold: one engine.
4. Bounded cost: at most 150 distinct tokens looked up per message in 4 batched statements (40 per
   `IN`, the house batch size); a token table capped at 100,000 rows per inbox, pruned hourly.
5. Reset: an admin can clear an inbox's model (tokens, training rows, counters).

## 1. Schema

**Files:** `worker/src/db/spam-models.schema.ts`, `spam-tokens.schema.ts`, `spam-training.schema.ts`,
`emails.schema.ts`, `schema.ts`, migration, `helpers.ts`.

```
spam_models   (inbox TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 0,
               spam_messages INTEGER NOT NULL DEFAULT 0, ham_messages INTEGER NOT NULL DEFAULT 0,
               updated_at INTEGER NOT NULL)
spam_tokens   (inbox TEXT NOT NULL, token TEXT NOT NULL, spam_count INTEGER NOT NULL DEFAULT 0,
               ham_count INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL,
               PRIMARY KEY (inbox, token))            index (inbox, updated_at)
spam_training (inbox TEXT NOT NULL, email_id TEXT NOT NULL, label TEXT NOT NULL /* spam | ham */,
               trained_by TEXT NULL, trained_at INTEGER NOT NULL, PRIMARY KEY (inbox, email_id))
emails.spam_probability REAL NULL
```

`spam_training` rows are deleted inside `deleteMessageState()` itself (`worker/src/lib/messages/state.ts`),
so every hard-delete path (`delete-email.ts`, `purge-blocked.ts`, the person delete in `people-router.ts`)
is covered without changes; note it in `AGENTS.md` next to the existing rule.

## 2. Tokenizer and scorer

**Files:** new `worker/src/lib/spam/tokenize.ts`, `score.ts`, `train.ts` (pure functions + thin D1
access), tests.

- `tokenize({ fromAddress, subject, bodyText, bodyHtml })` → `string[]` (distinct, insertion order,
  ≤ 150): lowercase; words of 3–24 characters matching `[\p{L}\p{N}][\p{L}\p{N}'$%€.-]*` from the
  subject (prefixed `s:`) and from the first 3,000 characters of `trimQuotedText(bodyText)` or
  `htmlToText(bodyHtml)` (no prefix); `f:<address>` and `d:<domain>`; `h:attachments` when any; pure
  numbers dropped unless they contain `$`/`€`/`%`. Stop words are not removed (the probabilities handle
  them).
- `score(tokens, counts, model)` → `number` in [0,1]: for each token with `spam_count + ham_count ≥ 1`,
  `b = spam_count / spam_messages`, `g = 2 * ham_count / ham_messages` (Graham's ham bias),
  `p = clamp(b / (b + g), 0.01, 0.99)`; unknown tokens are skipped; take the 15 tokens with the largest
  `|p − 0.5|`; combine `P = Π p / (Π p + Π (1 − p))` in log space. Fewer than 5 known tokens → `null`
  (not enough evidence; stored as `NULL`).
- `trainMessage(db, { inbox, emailId, label, userId })`: reads the message's tokens (same tokenizer
  over the stored row), reads the current `spam_training` row; same label → no-op; different → one
  batched `UPDATE spam_tokens … count - 1` for the old label; then upsert `+1` for the new label
  (`INSERT … ON CONFLICT DO UPDATE`, 40 tokens per statement), update `spam_models` message counters,
  upsert the training row. All best-effort behind `ctx.waitUntil` where a request is involved.

## 3. Hooks

**Files:** `worker/src/lib/messages/state.ts` (`setMailboxState`), `worker/src/lib/send-email.ts`
(`replyToEmail`), `worker/src/email-handler.ts`, `worker/src/lib/rules/types.ts`, `match.ts`.

- `setMailboxState`: when `userId` is non-null, the audit channel is not `import`, and `changes.spam`
  is defined, after the state write, for each received ref whose inbox has `spam_models.enabled` →
  `trainMessage(label: spam ? "spam" : "ham")`. Only `spam: false` on a message that _was_ junk trains ham (an idempotent `spam: false` on
  inbox mail does nothing). Batches ≤ 50 refs per call are trained inline; larger batches train the
  first 50 (bulk-junking 500 messages is still a user signal, but bounded).
- `replyToEmail`: for a received original in an enabled inbox and a user actor (audit context
  `user`/`api_key`/`mcp`/`jmap`, never `rule`/`agent`/`system`) → `trainMessage(label: "ham")`.
- Inbound handler, before `selectMatchingRules`: if the recipient inbox has an enabled model with
  ≥ 20/20 training messages → `spamProbability = score(tokenize(parsed), lookups, model)`; else `null`.
  Stored on the row; passed in `RuleMessage.spamProbability`.
- Rules: condition `{ field: "spam_probability", operator: "gte" | "lte", value: 0–1 }`; `null`
  never matches. Automations builder: the field with a 0–1 input and the hint "requires the inbox's
  learning filter".

## 4. API and UI

**Files:** `worker/src/routers/admin-inboxes-router.ts`, `src/pages/InboxesPage.tsx`,
`src/components/mail/MailReadingPane.tsx`, `src/pages/AutomationsPage.tsx`, `src/lib/api.ts`.

- `GET /api/admin/inboxes` gains `spamFilter: { enabled, spamMessages, hamMessages, ready }`;
  `PATCH /api/admin/inboxes/{email}` accepts `spamFilterEnabled`; `POST /api/admin/inboxes/{email}/spam-filter/reset`
  clears the three tables for the inbox (audit `inbox.updated` with `details.spamFilterReset`).
- Inboxes page, per inbox: "Learn from junk marks" toggle; status "Learning — 12 of 20 junk, 31 of 20
  not-junk examples" or "Scoring new mail"; "Create the junk rule" (opens Automations with a prefilled
  rule `spam_probability ≥ 0.9 → mark as junk`, inbox-scoped; disabled when such a rule exists); Reset.
- Reading pane details: "Spam probability 0.97 (learned filter)" when the row has one.
- `UnifiedMessage.spamProbability: number | null` (received only) for the above and for the agent's
  read tools.

## Tests

- Tokenizer fixtures (prefixes, limits, quoted tail trimmed, unicode words, `$` numbers kept).
- Scorer: a hand-computed example; `< 5` known tokens → `null`; clamp; the 15-token selection.
- Training: spam then ham on the same message subtracts and adds; idempotent repeat; counters;
  40-token batches (a 150-token message makes 4 statements per label); a system actor never trains; an
  auto-reply never trains; a user reply trains ham.
- Inbound: no score below 20/20; a score with a trained model; the condition matches `gte`.
- Prune: token cap respected, oldest low-count tokens go first.
- Web (vitest): the Inboxes controls; the prefilled rule.

## Docs and CHANGELOG

- `docs/inboxes.md` (the learning filter: what trains it, when it scores, the one-click rule, reset),
  `docs/automations.md` (the condition), `docs/mailbox-state.md` (the probability field),
  `AGENTS.md` (the `spam_training` cascade line next to `deleteMessageState()`).
- CHANGELOG `### Added`: **A spam filter that learns from your junk marks.** …
