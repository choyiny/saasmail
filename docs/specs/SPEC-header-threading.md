# SPEC: Header-based threading as a per-inbox option

Stage 10 follow-up, scheduled **last** (after every other Stage 9–11 spec). Depends on
`docs/archive/SPEC-reply-to.md` (the JMAP `replyTo` exposure rides on this reset) and `docs/archive/SPEC-audit-log.md`. Label
`minor`, or `major` if the team treats a JMAP account reset as breaking (as #39's `feat(jmap)!` did).

## Why

D1 (`claude/decisions.md`, 1C) keys a 1-on-1 conversation by the relationship: `p:<person_id>` within an
inbox. That is right for the customer view — one timeline per customer — and it keeps snooze and
assignment per customer, which support teams like. It is wrong for a mail client: over JMAP a `Thread`
is "everything this person ever sent to support@", so aerc or any desktop client shows a years-long
thread for every active customer, and `Thread/changes` churns on every message. Mailroom threads by
`In-Reply-To`/`References` with subject normalisation; every mail client does.

Facts to build on: received mail stores `in_reply_to` and `references_header` (migration 0062/0063);
sent mail stores `in_reply_to` and `message_id`; JMAP drafts already join the thread of the message they
answer by Message-ID (`threadKeyForMessageId` in `worker/src/jmap/email-create.ts`, master plan
decision 9) and carry `jmap_message_content.thread_key`; `conversationKeySql` is the single derivation
(`COALESCE(conversation_id, 'p:' || person_id)`); `inbox_conversation_state` is keyed by
`(inbox, conversation_key)`; the web mailbox reading pane shows one message, not a thread, so the
change is felt in JMAP threads and in snooze/assignment scope.

## Decisions (proposed 2026-10-03)

1. **Per inbox:** `sender_identities.threading_mode` `'relationship'` (default, today's behaviour) or
   `'headers'`. The customer view and the person timeline are unaffected in both modes (they group by
   person/customer, not by conversation key).
2. **Thread key:** `t:<sha256 hex of the root Message-ID>` stored in a new `thread_key` column on both
   `emails` and `sent_emails`, **set only for messages of inboxes in `headers` mode** (NULL otherwise).
   The derivation becomes `COALESCE(thread_key, conversation_id, 'p:' || person_id)`: no mode lookup at
   read time, no behaviour change for relationship inboxes.
3. **Resolution:** a message joins the thread of the first message it cites (`In-Reply-To`, then
   `References` nearest-first, ≤ 20 ids) that exists in the same inbox — as received mail, as sent mail
   (`message_id`), or as a JMAP send (`jmap_message_content.message_id`). Nothing cited is known → it
   starts a thread rooted at its own Message-ID (a synthetic one if absent). **No subject matching**:
   clients set these headers reliably, and subject heuristics merge unrelated mail.
4. **Switching modes** is an admin action with a confirmation that says what happens: a backfill job
   rekeys the inbox's mail; the inbox's snoozes and assignments are cleared (they were keyed by the old
   conversation keys and cannot be mapped one-to-one); JMAP clients of every user resync once. Switching
   back to `relationship` clears `thread_key` the same way.
5. **JMAP:** `threadId` is immutable, so a mode switch bumps an instance-wide `jmap_account_epoch`
   (`app_settings`) mixed into the account id and the state prefix, the mechanism behind the v3/v4
   resets but without a code change. The same reset exposes `replyTo` for received mail
   (SPEC-reply-to, decision 7).
6. **Rules and snooze** act on the conversation key as today, so in `headers` mode `snooze` and `assign`
   apply to the thread, not the customer. Documented.

## 1. Schema

**Files:** `worker/src/db/emails.schema.ts`, `sent-emails.schema.ts`, `sender-identities.schema.ts`,
migration, `helpers.ts`.

- `emails.thread_key TEXT NULL` + index `(recipient, thread_key)`; `sent_emails.thread_key TEXT NULL` +
  index `(from_address, thread_key)`; `sender_identities.threading_mode TEXT NOT NULL DEFAULT
'relationship'`.

## 2. Resolution helper

**Files:** new `worker/src/lib/messages/thread-key.ts` (+ tests); `worker/src/email-handler.ts` /
`worker/src/lib/inbound/store-received.ts` (after SPEC-mail-import); `worker/src/lib/send-email.ts`
(`sendEmail`, `replyToEmail`); `worker/src/lib/inbound/store-sent.ts`; `worker/src/jmap/email-create.ts`
(`threadKeyForMessageId` delegates to it); `worker/src/lib/sequence-processor.ts`,
`campaign-sender.ts`, `send-template.ts` (new sends start their own thread when the inbox is in
`headers` mode).

- `resolveThreadKey(db, { inbox, messageId, citedIds }): Promise<string>`: `citedIds` normalised
  (angle brackets stripped, trimmed, ≤ 20, nearest first); one query with three arms over the inbox
  (`recipient` / `from_address`), ids bound once as JSON (`json_each`), `LIMIT 1` per arm in citation
  order → the found row's `thread_key`; none → `threadKeyOf(messageId)` = `t:` + sha256 hex of the id
  (or of a `nanoid()` when the message has no Message-ID: `message_id` stays as received, only the
  key uses the random root).
- Callers compute `thread_key` only when the inbox's `threading_mode === 'headers'` (one cached
  `sender_identities` read; the inbound handler already loads `identityRows`).
- `conversationKeySql` and `conversationKeyOf` gain the `thread_key` term first. Every
  `UnifiedMessage`/`state.conversationKey` consumer picks it up; `jmapThreadKey` is unchanged (it
  prefers `jmap.threadKey`, then `state.conversationKey`) — in `headers` mode the JMAP content row's
  `thread_key` and the sent row's `thread_key` are written with the same value, so the two agree.

## 3. Mode switch and backfill

**Files:** `worker/src/routers/admin-inboxes-router.ts`, new `worker/src/lib/messages/thread-backfill.ts`,
`worker/src/db/async-jobs.schema.ts` (`job_type` gains `thread_backfill`), `worker/src/lib/queue-router.ts`,
`worker/src/jmap/public-ids.ts`, `worker/src/jmap/state.ts`, `worker/src/jmap/methods.ts` (Session).

- `PATCH /api/admin/inboxes/{email} { threadingMode }`: admin, passkey-gated; 409 if a backfill for
  the inbox is running; in one request: update the mode, `DELETE FROM inbox_conversation_state WHERE
inbox = ?` (counted and put in the audit `details`), increment `jmap_account_epoch`, insert the job
  and enqueue it, emit `inbox.updated` (`details.{threadingMode, clearedConversationStates}`).
- Backfill slice: pages the inbox's received and sent rows by `(occurred_at, id)` ascending in 200s
  (`queryMessages`, folder-neutral, both directions, trash and spam included); `headers` → for each row
  `resolveThreadKey` against rows already keyed (earlier in time, so parents are keyed before children
  in the normal case; a child seen before its parent starts a thread the parent then joins — the last
  pass re-resolves rows whose cited parent now has a different key: run the walk twice, the second pass
  only over rows whose `thread_key` differs from their cited parent's); `relationship` → `thread_key =
NULL` in batches. `cursor`, `processed_rows`; 20 s per slice; re-enqueue; `completed` → realtime
  `mail_refresh` for the inbox, `inbox.updated` audit with the row count.
- JMAP epoch: `publicAccountId(userId)` and the state prefix include `app_settings.jmap_account_epoch`
  (default 0): `a<sha256(jmap-account-v4e<epoch>:<userId>)>`, states `j4e<epoch>-…`. A client holding
  the old account id gets `accountNotFound` and resyncs from `/.well-known/jmap`, exactly as for the
  v3/v4 resets. `Email/get` now returns `replyTo` for received mail (from SPEC-reply-to's column and
  fallback).

## 4. UI

**Files:** `src/pages/InboxesPage.tsx`, `src/components/mail/MailReadingPane.tsx` (optional thread
strip), `docs/`.

- Inboxes admin: "Conversations" select — _By customer (default): all mail with a person is one
  conversation; snooze and assignment apply to the customer._ / _By thread: replies form threads like a
  mail client; snooze and assignment apply to the thread; JMAP clients see normal threads._ Changing it
  opens a confirmation listing the three consequences (backfill in the background, snoozes and
  assignments cleared, mail clients resync) and shows the backfill progress afterwards.
- Reading pane (optional, if cheap): when the inbox is in `headers` mode, a "N messages in this
  thread" strip that lists the thread's other messages (`GET /api/messages?threadKey=…`, which
  `queryMessages` already supports via `threadKeys`).

## Tests

- `resolveThreadKey`: joins by In-Reply-To; by a later References id when the direct parent is unknown;
  prefers the nearest citation; crosses received↔sent; joins a JMAP send by its content Message-ID; no
  citation → own root; no Message-ID → random root, stable within the call; inbox scoping (the same
  Message-ID in another inbox doesn't join).
- Derivation: relationship inbox rows unchanged (`thread_key` NULL → old key); headers rows use
  `t:…`; `inbox_conversation_state` snooze/assign on a thread key; a reply in a headers inbox joins
  the thread (`replyToEmail`), a new send starts one; sequence/campaign sends start their own.
- Backfill: a fixture with a parent arriving after its child ends with one key; relationship clears;
  resume by cursor; state rows cleared and counted; the epoch bump changes the account id and old
  states answer `accountNotFound`/`cannotCalculateChanges`.
- JMAP: `Thread/get` for a headers inbox returns the chain only; `replyTo` populated.
- e2e: switch the seeded inbox to threads and back (the backfill runs on the queue in dev).

## Docs and CHANGELOG

- `docs/mailbox-state.md` (conversation keys in both modes), `docs/inboxes.md` (the setting and its
  consequences), `docs/jmap.md` (threads; the epoch reset; `replyTo`), `docs/automations.md` (snooze/
  assign scope), `claude/decisions.md` D1 gets a "superseded per inbox by SPEC-header-threading" note.
- CHANGELOG `### Added`: **Threads like a mail client, per inbox.** … and `### Changed`: **JMAP account
  reset when an inbox's conversation mode changes.** …

## Spec changes (made while building it)

Decisions 1–4 and 6 stand. Decision 5 stands with change 2 below. What the code does differently from
the sections above, and why:

1. **The epoch is part of a state's fingerprint, not its prefix.** States stay `j4-<seq>-<issuedAt>-<fp>`;
   `stateFingerprint` hashes the epoch with the user and their inboxes. A state from another epoch fails
   the fingerprint check exactly as one with a `j4e<n>-` prefix would (`cannotCalculateChanges`), nothing
   parses a new format, and a push stream's periodic re-check compares fingerprints already, so an open
   stream ends on a bump without new code (within its query budget, which counts the extra read). Account
   ids are `a<sha256(jmap-account-v4e<epoch>:<userId>)>` as specified, so deploying this release is itself
   a reset, the one that exposes `replyTo`. A Hono middleware reads the epoch once per JMAP request
   (`/.well-known/jmap`, `/jmap/*`) and the id helpers read it from an `AsyncLocalStorage` scope
   (`jmap/epoch.ts`), like the audit actor, rather than threading it through 20-odd call sites.
2. **The epoch moves when the backfill ends (completed or failed), not at the switch.** The backfill
   rewrites `threadId`s over minutes; a client that resynced right after a bump at the switch would see
   them change under the new account. Mail that arrives meanwhile is keyed at once, and a new Email's
   `threadId` is never changed later except by the backfill, which the closing bump covers.
3. **A backfill page is one batch of `UPDATE … FROM` statements**, one per row, with the cited-thread
   lookup as a subquery (`citedThreadKeySql`, which `resolveThreadKey` now also uses), plus the progress
   update guarded by the slice's claim, in one transaction. A reply sees the key its parent got earlier in
   the same page, a page's rows and its progress commit together, and a slice stays well inside D1's
   query budget (at most 400 row statements or 20 s). Drizzle's `db.batch` takes builders only, so the
   batch is `$client.batch` of prepared statements.
4. **The second pass** walks the inbox again and re-resolves every row that cites something, keeping the
   row's key when nothing it cites has a thread (`COALESCE(lookup, thread_key)`), instead of selecting
   "rows whose `thread_key` differs from their cited parent's". Same result for a parent that arrived
   after its child; simpler to resume.
5. **A message without a Message-ID** is rooted in the backfill at `received:<id>` / `sent:<id>`, so both
   passes and a retry give it the same thread. Live mail keeps the random root of §2.
6. **JMAP content follows its Sent row.** Going to threads, the backfill sets
   `jmap_message_content.thread_key` to the Sent row's key; going back to customers, to the Sent row's
   conversation key (`COALESCE(conversation_id, 'p:' || person_id, 'sent:' || id)`), the key a draft
   written in a relationship inbox gets. A draft never sent keeps its thread. Live: `draftThreadKey` keeps
   joining the visible message it answers, and in a headers inbox a draft that answers nothing known is
   rooted at its own Message-ID; the Sent row of a JMAP send in a headers inbox takes its content's key.
7. **Retry.** Sending the current mode again after its backfill failed runs it again (the UI's **Retry**);
   with nothing failed it changes nothing. The spec had no way back from a stopped backfill but switching
   twice.
8. **Audit and API shapes.** The switch's `inbox.updated` has `details.threadingMode: {from, to}` like
   every other field, and `clearedConversationStates`; the backfill's end records another
   `inbox.updated` (`{threadingMode, backfill: "completed", rows}`). Both admin inbox routes return
   `threadingMode` and `threadBackfill` (`{id, mode, status, processed, total}`; `total` is twice the
   inbox's messages for threads, two passes, and its keyed messages going back). The PATCH route is an
   ordinary admin route: the passkey requirement is the instance-wide one for session users.
9. **UI.** The select sits under the Thread/Chat toggle in the Inboxes table
   (`src/components/ConversationModeControl.tsx` in `AdminInboxTable.tsx`), not in `InboxesPage.tsx`;
   the confirmation is the browser's `confirm`, like the table's delete. The optional reading-pane thread
   strip was not built.
10. **`claude/decisions.md` is not in this repository**, so there is no D1 note to add; the conversation
    key in both modes is documented in `docs/mailbox-state.md` and `docs/inboxes.md`.
11. **Hardening from the review.**
    - The PATCH route writes `threading_mode` only when the body has it, and drops an all-defaults
      row only while its mode is still `relationship`: another admin's save can't undo a switch.
    - Each slice first checks that the inbox still has the job's mode, and fails the job otherwise.
    - Every row write is conditional on the run still holding the job, so a run that lost it (a stall
      past its lease) writes nothing.
    - A page's read and progress write count toward the slice's 400-statement budget, so a pass-2 walk
      over mail that cites nothing stays within D1's per-invocation queries.
    - The epoch moves before the job's status is written, so a crash in between can't skip it.
    - A stopped backfill is audited (`inbox.updated`, `backfill: "failed"`).
12. **Imports.** An import into a headers inbox ends with a late-parent pass over the inbox (a
    `thread_backfill` starting at pass 2, `rethread: "import"`, no states cleared, JMAP resync at the
    end), because the live path roots a reply met before its parent. The mode can't be switched while an
    import into the inbox runs (`409`), since its slices read the mode as they go.
13. **Deleting an inbox** answers `409` while its backfill runs; deleting a headers inbox starts a
    clear to `relationship` (its mail stays, and the mode reads as the default once the row is gone).
14. **Smaller fixes.** A bare `In-Reply-To` stays first beside bracketed `References`; a composer reply
    to a message without a Message-ID takes the original's thread when both are in the inbox; moving a
    sent message to another inbox re-keys it for that inbox.
15. **Known limits, documented:** the walk is in date order, so a chain whose dates run backwards over
    several generations can stay split; in DEMO_MODE the slices run inline after the request and in the
    hourly run, which suits demo-sized inboxes only.
