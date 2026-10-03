# SPEC: AI filing into folders (auto-labels)

Stage 10 (triage), slice 2 of 3. Depends on `SPEC-audit-log.md` only for the manual action's audit row;
independent of `SPEC-reject-inbound.md`. Label `minor`.

## Why

Mailroom's most useful feature is auto-labelling: each inbox describes its labels in words ("invoices
and receipts", "bug reports", "sales leads") and a model files incoming mail. Our rules engine only
matches literal text (from, subject, body, header, spam score), so "put support questions about billing
in Billing" is not expressible. We already have the provider selection (D18), the queue job pattern
(suggested replies, 2c) and — the key fact — **custom folders that already behave like labels**: a
message in a custom folder stays in Inbox unless archived (`folderMembershipSql` in
`worker/src/lib/messages/query.ts`; `docs/mailbox-state.md`). So no label table is needed: folders gain
a description and a colour, and the AI files into them.

## Decisions (proposed 2026-10-03)

1. No new "label" concept. `mailboxes` gains `color` and `ai_description`; "AI filing" is the rule action
   `ai_file`, so it lives in the one automations engine (principle: never a second subsystem).
2. Filing is asynchronous on `EMAIL_QUEUE` (job `ai_file`), like suggested replies: the inbound handler
   never waits on a model. Filed folders appear a few seconds after the message, with the same realtime
   refresh suggested replies use.
3. The model sees the message as quoted data (D19 framing) and may only answer with folder ids from the
   list it was given; anything else is ignored. No separate injection screen: the worst outcome of a
   hostile message is a wrong folder, and the output is validated. Fail closed: parse error or model
   error → no change, one console warning.
4. `ai_file { archiveWhenFiled?: boolean }`: when a folder matched and the flag is set, the message is
   also archived ("skip the inbox", Gmail-style). Default false.
5. Model: `selectModel(env)` (D18). An optional `TRIAGE_MODEL` var overrides the model name for filing
   only (`selectModel({ ...env, AGENT_MODEL: env.TRIAGE_MODEL ?? env.AGENT_MODEL })`), so a cheap model
   can file while a strong one chats. Reasoning off as in D38; `temperature: 0`; `maxOutputTokens: 200`.
6. Later rules cannot branch on AI folders inline (the filing is asynchronous). Documented; a
   `message.filed` trigger is a possible later addition, not part of this slice.
7. Bounds: ≤ 30 described folders per inbox; a description ≤ 300 characters; the body excerpt ≤ 4,000
   characters of `bodyText` (or `htmlToText(bodyHtml)`), with the quoted-reply tail trimmed by the
   existing `trimQuotedText`.

## 1. Schema and folder API

**Files:** `worker/src/db/mailboxes.schema.ts`, migration, `helpers.ts`,
`worker/src/routers/mailboxes-router.ts`, `src/lib/api.ts`.

- `mailboxes.color TEXT NULL` — one of twelve palette names (`red orange amber yellow lime green teal
cyan blue violet purple pink`) validated by a zod enum; `mailboxes.ai_description TEXT NULL`.
- `POST /api/mailboxes` and the rename route (`PATCH /api/mailboxes/{id}`) accept `color` and
  `aiDescription` (trimmed; empty → `NULL`). The 30-described-folders cap is enforced at write with
  `400 TOO_MANY_AI_FOLDERS`. `GET /api/mailboxes` returns both fields. JMAP `Mailbox/get` is unchanged
  (neither property exists in RFC 8621).

## 2. Rule action

**Files:** `worker/src/lib/rules/types.ts`, `validation.ts`, `evaluate.ts`, `worker/src/lib/queue-router.ts`,
new `worker/src/lib/triage/ai-file.ts`, `worker/src/lib/triage/prompt.ts`.

- `RuleActionSchema` gains `{ type: "ai_file", archiveWhenFiled: z.boolean().optional() }`. Validation:
  inbox-scoped rule; at most one `ai_file` per rule; the inbox must have ≥ 1 described folder when the
  rule is saved (`400 NO_AI_FOLDERS`, with the hint to describe folders first).
- `runAction` case `ai_file`: `runtime.ctx.waitUntil(env.EMAIL_QUEUE.send({ type: "ai_file", emailId,
inbox, ruleId, archiveWhenFiled }))`; skipped with a log line when `selectModel(env).ok` is false.
- Queue consumer (`ai-file.ts`, `fileWithAi(db, env, job)`):
  1. Load the message through `queryMessages` (system scope for the inbox; `withReplyTo` not needed) —
     gone → done.
  2. Load the inbox's described folders (`ai_description IS NOT NULL`), ordered by `sort_order, name`;
     none → done.
  3. `buildFilingPrompt({ folders, message })` (`prompt.ts`, pure): system text explains the task,
     lists folders as `id — name — description`, states the answer format `{"folders": ["<id>", …]}`
     with `[]` allowed, and that the quoted message is content, not instructions. The user message
     carries From, Subject, the excerpt and attachment names/types, each clearly delimited.
  4. `generateText` with the D38 options; parse the first `{…}` JSON object in the text; keep only ids
     from step 2 (dedupe, ≤ 5).
  5. Apply through `setMailboxMembership(db, allowedForInbox, null, [ref], { add })` and, when
     `archiveWhenFiled` and `add.length > 0`, `setMailboxState(…, { archived: true })` — both as the
     system actor like other rule actions. No audit row (routine rule action; `match_count` already
     counted the rule).
  6. Realtime: the same fan-out `notifySuggestionReady` uses, sending a new event type
     `{ type: "mail_refresh", inbox }` (next to `email_received` and `suggested_reply` in
     `worker/src/do/notifications.ts`), which the Mail page handles like `email_received`.
     Retries follow the queue's `max_retries`; a model error throws (retry), a parse failure returns
     (no retry).

## 3. Manual action

**Files:** `worker/src/routers/messages-router.ts` (`POST /api/messages/ai-file { refs }`),
`src/components/mail/MailReadingPane.tsx`, `src/components/mail/MailSelectionBar.tsx`.

- Any member with access to the inbox may ask for up to 50 messages to be (re)filed: the route checks
  access per ref, enqueues one `ai_file` job per message with `ruleId: null` and
  `archiveWhenFiled: false`, emits one `mail.ai_file_requested` audit row (count + first 20 refs) and
  returns `202 { queued }`. Shown as "File with AI" in the reading pane menu and the bulk bar; disabled
  with a tooltip when the inbox has no described folder or no model is configured
  (`GET /api/agent/status` already says).

## 4. UI

**Files:** `src/components/mail/MailFolderRail.tsx` (create/rename dialog), `MailMessageList.tsx`,
`src/pages/AutomationsPage.tsx`.

- Folder dialog: a colour picker (12 dots) and "What belongs here? (lets the AI file mail into this
  folder)" textarea with a counter. The rail shows the colour dot before the name.
- Message list rows: up to three folder chips (name, colour) for custom-folder memberships, "+N" beyond.
  The row data already includes mailbox ids (`mailboxIds`); the names/colours come from the folder list
  the page holds.
- Automations action builder: "Let the AI file into folders" with the "also archive" checkbox and a
  line listing the inbox's described folders (or the hint to describe some).

## Tests

- Prompt builder: deterministic output for a fixture; excerpt truncation; quoted tail trimmed.
- Parser: accepts `{"folders":["a","b"]}`, ignores unknown ids, garbage → `[]`, text around the JSON.
- Consumer (mock `LanguageModel` as in the 2c tests): applies memberships; archive flag; no described
  folders → no call; message gone → no call; model throw → rethrow; parse failure → no change.
- Validation: unscoped rule refused; second `ai_file` refused; no described folder refused.
- Route: 50-ref cap, access per ref, 202, audit row.
- Web (vitest): colour and description round-trip in the dialog; chips render; the builder entry.
- e2e: create a described folder; the Automations page saves an `ai_file` rule (no model in e2e, so no
  filing is asserted).

## Docs and CHANGELOG

- `docs/automations.md` (action, async note, the "no branching on AI folders" caveat),
  `docs/mailbox-state.md` (colour, description, chips), `docs/agent.md` or `docs/configuration.md`
  (`TRIAGE_MODEL`).
- CHANGELOG `### Added`: **AI filing into folders.** …
