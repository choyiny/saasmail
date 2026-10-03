# SPEC: Replies go to the sender's Reply-To

Stage 9 (trust and safety), slice 1 of 5. Depends on nothing. Label `minor`.

## Why

`replyToEmail` (`worker/src/lib/send-email.ts`) addresses every reply to `people.email` of the
original's sender. The inbound `Reply-To` header is parsed into `raw_headers` and then ignored, so a
reply to a ticketing system, a `noreply@` notification that names a real support address, or any sender
who asked for answers elsewhere goes to the wrong mailbox. Every mail client and Mailroom honour
Reply-To; we are the exception.

Facts to build on: `emails` has no `reply_to` column; `raw_headers` is a JSON object of lowercase
header names → raw values (postal-mime), so older rows can be read without a migration;
`parseAddressHeader()` in `worker/src/lib/email-parser.ts` already turns such a value into
`ParsedEmailAddress[]`; postal-mime exposes `replyTo: Address[]`.

## Decisions (proposed 2026-10-03; change them in this file before implementing)

1. Replies default to the Reply-To address(es) when present. Callers may ask for the sender instead
   (`recipient: "sender"`). The web composer shows which one it will use and lets the user flip it.
2. Reply-To addresses that are our own inboxes (any `sender_identities.email`, case-insensitive) are
   dropped from the candidates; if none remain, the reply goes to the sender as today. This is the loop
   guard: a message whose Reply-To points back at us never produces a reply to ourselves.
3. Several Reply-To addresses: the first becomes To, the rest are added to Cc (deduplicated against the
   caller's Cc; `MAX_CC_ENTRIES` from `worker/src/lib/send-limits.ts` still applies).
4. The sent row keeps `person_id` = the original sender's person, so the reply stays on that customer's
   timeline. `to_address` is the Reply-To address. The timeline shows "to support@…" on the reply.
5. Rule auto-replies keep answering the sender (`recipient: "sender"`). An automatic response should not
   follow an attacker-controlled Reply-To; RFC 3834 points automatic responses at Return-Path/From.
6. No SQL backfill. Rows from before this change have `reply_to = NULL`; the reply path and the message
   reads fall back to `raw_headers["reply-to"]` through `parseAddressHeader()`, and the reply path writes
   the parsed value back so the fallback runs once per message.
7. JMAP keeps returning `replyTo: null` for now. It is an immutable Email property and this repo resets
   the account id when one changes (docs/jmap.md, id format v3). The reset is batched with
   `SPEC-header-threading.md`, which exposes `replyTo` then.

## 1. Parse and store

**Files:** `worker/src/lib/email-parser.ts`, `worker/src/db/emails.schema.ts`,
`worker/src/email-handler.ts`, `worker/src/routers/emails-router.ts`, `worker/src/__tests__/helpers.ts`,
a generated migration.

- `ParsedEmail` gains `replyTo: ParsedEmailAddress[]` from postal-mime's `replyTo`: email trimmed and
  lowercased, name or `null`, entries without an `@` dropped, duplicates removed, at most 10 kept.
- `emails.reply_to TEXT NULL`: JSON `[{"email","name"}]`, exactly the `cc` convention; `NULL` when the
  header is absent or empty. `yarn db:generate`; update `applyMigrations()` in `helpers.ts`.
- `handleEmail` writes `replyTo: parsed.replyTo.length ? JSON.stringify(parsed.replyTo) : null`.
- A helper `replyToOf(row: { replyTo: string | null; rawHeaders: string | null }): MailAddress[]` in
  `worker/src/lib/messages/adapters.ts` returns the stored list, else the parsed fallback from
  `raw_headers`, else `[]`. Every reader below uses it; nothing parses `raw_headers` elsewhere.
- Re-attribution (`PATCH /api/emails/{id}/person`) already strips `reply-to` from `raw_headers`, because
  from then on `people.email` is the reply target. It sets `reply_to = NULL` in the same update, or the
  stored list would bring the old target back.

## 2. Message reads

**Files:** `worker/src/lib/messages/types.ts`, `query.ts`, `adapters.ts`,
`worker/src/lib/reply-recipients.ts` (new), `worker/src/lib/queries/emails.ts`,
`worker/src/routers/messages-router.ts`, `conversations-router.ts`, `emails-router.ts`,
`worker/src/lib/agent/tools.ts`, `src/lib/api.ts`.

- `UnifiedMessage.replyTo?: MailAddress[]`: what `replyToOf` gives, set only when the caller asks
  (`withReplyTo: true`): the list (possibly empty) for received mail, `[]` for sent. It is left out
  otherwise, like `attachments` and `state`, so "not loaded" never reads as "none".
- With `withReplyTo`, the received arm selects `e.reply_to` and, for rows where that is `NULL`, the one
  `reply-to` value out of `raw_headers` (`json_extract`, the way `to_header` is read). The whole
  `raw_headers` object never leaves SQLite, so a list page can afford it.
- Who asks:
  - `GET /api/messages`: the reading pane renders the selected row of this list; there is no
    per-message read behind it.
  - `GET /api/conversations/{id}/emails` and `GET /api/emails/by-person/{personId}`: they feed the chat
    view's quick reply (group and one-to-one).
  - the agent's `read_message`.
  - `GET /api/emails/{id}` and MCP `read_email` read one row through `getEmailById`, which calls
    `replyToOf` on it; its private header parser (`extractReplyTo`) goes away.
- The HTTP routes return where a reply would go, not the bare header: the own-inbox guard of decision 2
  runs on the server (`replyCandidates()` in `worker/src/lib/reply-recipients.ts`, the function the reply
  path uses), because a member's browser only knows the inboxes they were granted and cannot filter the
  others. The inbox the message arrived at is dropped too: it is what the reply is sent from. A list
  that is only the sender is returned empty (`replyRecipients()`), since following it changes nothing.
  - `MailMessage.replyTo?: MailAddress[]` (`GET /api/messages`): every address a reply would use, in
    order (To, then the copies).
  - `Email.replyRecipients: MailAddress[]` (the three `Email`-shaped routes): the same list. The reply
    composers read this one, so that every address that gets the reply is on screen before it is sent.
  - `Email.replyTo: string | null` (same routes): the first candidate when it is not the sender, else
    `null`. The field existed on `GET /api/emails/{id}` (`surfaceReplyTo`) and `ReassignPersonModal`
    uses it; its type is unchanged, it now also drops our own inboxes, and the two timeline routes
    fill it.
  - The agent's `read_message` returns the list as stored: it reads the message, it doesn't send.

## 3. Reply path

**Files:** `worker/src/lib/send-email.ts`, `worker/src/routers/send-router.ts`,
`worker/src/mcp/server.ts` (`reply_email`), `worker/src/lib/rules/auto-reply.ts`,
`src/lib/api.ts`, the reply composer (`src/components/ReplyComposer.tsx`, opened from
`src/components/mail/MailReadingPane.tsx` and the customer view) and the chat view's quick reply
(`src/components/ChatInboxSection.tsx`, `src/components/ChatQuickReply.tsx`), plus
`src/components/ThreadMessage.tsx` for the "Replying to" card.

- `ReplyEmailParams` gains `recipient?: "reply_to" | "sender"` (default `"reply_to"`).
- For a received original: `candidates = replyToOf(orig)` minus our inbox addresses minus the From
  inbox of this reply. Non-empty and `recipient === "reply_to"` → `toAddress = candidates[0].email`,
  `candidates.slice(1)` appended to Cc (dedupe, cap). Otherwise `toAddress = people.email` as today.
  The new To is removed from the caller's Cc: a reply-all composer carries the original's Cc, which
  may hold that very address. The reply's `conversation_id` is still computed from the original
  sender and the caller's Cc, not from the Reply-To addresses, so a reply written in a group
  conversation stays in it (decision 4 for groups).
  For a sent original nothing changes. If `orig.replyTo` was `NULL` and the fallback found addresses,
  write them to `emails.reply_to` (best effort, after the send, and only if the row still has no
  list and still belongs to the same person: a re-attribution during the send cleared it on purpose).
  That update fires the `emails` update triggers once (FTS and the JMAP change log); no JMAP property
  changes, so clients refetch an identical Email.
- `ReplyEmailSuccess` gains `to: string`, `cc: string[]` (every address the reply was copied to) and
  `repliedTo: "reply_to" | "sender"`.
- `POST /api/send/reply/{emailId}`: optional `recipient` (zod enum) in the JSON `payload`
  (`ReplyEmailSchema`), next to `fromAddress`: the multipart body has only `payload` and `files`. The
  response gains `to`, `cc` and `repliedTo`. Update the zod-openapi schemas so `/doc` is right.
- MCP `reply_email`: optional `recipient` input (`z.enum(["reply_to","sender"]).optional()`), the
  description says replies follow the message's Reply-To unless `recipient: "sender"`, and the result
  includes `to` and `cc`. The tool inventory test is unchanged (no new tool).
- `runAutoReply` passes `recipient: "sender"`.
- Web: when a received message's `replyTo` (after the own-inbox filter) differs from its From, the reply
  composer shows "Replies go to support@acme.com (the sender asked for replies there)" with a
  "Reply to the sender instead" toggle. The composer reads `Email.replyRecipients` of the message it
  answers (it already loads that message with `fetchEmail`); the chat view's quick reply reads it from
  its reply target. With several addresses the hint names them all ("Replies go to a@x.com, with
  b@y.com in Cc (…)"), also when the first is the sender itself. The web always sends `recipient`:
  `reply_to` only while the hint is on screen and the toggle is off, `sender` otherwise, so a reply
  never goes to an address the composer did not show (the original may fail to load). Answering one
  of our sent messages, the To row shows that message's recipient. The reading pane's header block
  shows a `Reply-To:` line in the same case, from `MailMessage.replyTo`. `replyToEmail` in
  `src/lib/api.ts` takes `recipient`.

## Tests

- Parser: Reply-To with a display name; a list of three; an invalid entry dropped; absent → `[]`.
- Handler: `reply_to` stored as JSON; `NULL` when absent.
- `replyToEmail`: honours `reply_to`; three addresses → To + 2 Cc, deduped against caller Cc; a Reply-To
  equal to one of our inboxes falls back to the sender; `recipient: "sender"`; a sent original is
  unchanged; an old row with `reply_to NULL` and a `raw_headers` Reply-To uses it and writes it back;
  `sent_emails.person_id` is the original sender's person.
- Route and MCP: `recipient` validation, `to`/`repliedTo` in the response.
- Auto-reply still goes to the sender.
- Web (vitest): the hint renders only when Reply-To differs; the toggle flips the submitted `recipient`.

## Docs and CHANGELOG

- `docs/inboxes.md`: a "Replying" paragraph (Reply-To rule, own-inbox guard, the toggle, timeline
  attribution). `docs/mcp.md`: `reply_email` gains `recipient`. `docs/jmap.md`: one line that `replyTo`
  stays `null` until the next id-format reset. `docs/automations.md`: auto-replies answer the sender.
- CHANGELOG `### Added`: **Replies follow the sender's Reply-To.** … (one paragraph, the house style).

## Spec changes (2026-10-03, while implementing)

The decisions above are unchanged. Sections 1 to 3 were corrected where the code differed from what
they assumed:

1. The reading pane has no per-message read: it renders rows of `GET /api/messages`. That list asks for
   `replyTo`, and the query reads only the `reply-to` value out of `raw_headers`, never the object.
2. `read_email` (MCP) and `GET /api/emails/{id}` go through `getEmailById`, not `queryMessages`, and
   already returned `replyTo: string | null`, which `ReassignPersonModal` uses. The field keeps its
   type and is now computed through `replyToOf`.
3. A member's browser only knows the inboxes they were granted, so the own-inbox guard for the web hint
   runs on the server; the HTTP routes return the addresses a reply would use.
4. `PATCH /api/emails/{id}/person` strips Reply-To from `raw_headers` on re-attribution; it must clear
   `emails.reply_to` too.
5. `UnifiedMessage.replyTo` is optional (present when asked for), like the other opt-in fields.
6. `recipient` is a field of the JSON `payload`, not a separate form field.
7. The reply composer lives in `src/components/ReplyComposer.tsx`; the person timeline route feeds the
   one-to-one chat reply and asks for `replyTo` like the conversation route.

After a review of the first implementation (same day), decision 3 gained the detail it lacked: the
copies it adds must be visible.

8. The composers show every address a reply reaches, not only the first. `Reply-To: sender, other`
   used to show no hint at all while `other` was copied. The `Email` shape gains `replyRecipients`
   for that, the reply result gains `cc`, and a list that is only the sender is reported as empty.
9. The web always sends `recipient`, the target it displayed. The server default (follow Reply-To)
   is for API and MCP callers; a composer whose original had not loaded showed the sender and would
   have followed a Reply-To it never showed.
10. The address that becomes To is removed from the caller's Cc, so it is not mailed twice.
11. A reply keeps the conversation of the message it answers: `conversation_id` is computed from the
    original sender and the caller's Cc. Computed from the Reply-To address, a reply written in a
    group conversation left it.
12. The read-side guard also drops the inbox the message arrived at, and the write-back does not run
    if the message was re-attributed during the send.
