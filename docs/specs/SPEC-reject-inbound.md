# SPEC: Reject mail at the door — a `reject` rule action and unknown-recipient rejection

Stage 10 (triage), slice 1 of 3. Depends on `docs/archive/SPEC-audit-log.md`. Label `minor`. The evaluator split in
§1 is also what `SPEC-spam-learning.md` builds on, so this slice goes first.

## Why

Rules can only act on mail that is already stored: the evaluator runs after the `emails` row, the
attachments and the raw blob are written. Nothing can refuse a message while the sending server is
still on the line, which is the one moment a refusal costs us nothing and tells a legitimate sender
their mail didn't land. Mailflare's routing rules can "store, forward, reject"; Mailroom rejects mail
to addresses that aren't registered inboxes. We accept everything, including mail to addresses nobody
reads, and keep it forever.

Cloudflare Email Workers expose `message.setReject(reason)`: called before the handler returns, the
message is refused at SMTP time with a 5xx and the reason.

## Decisions (proposed 2026-10-03)

1. `reject` is a rule action evaluated **before storage**. A rule with `reject` may have no other
   action (validation), because none could run on a message that is never stored.
2. Matching moves before storage for every rule, actions stay after. The evaluator is split into a
   pure selection pass (which rules match, in order, honouring `stop_processing`) and an action pass.
   The set of matched rules is identical to today's for every message, since all conditions read the
   parsed message only.
3. Blocked senders are still dropped silently (a bounce confirms the address is live to a spammer).
   Deduplicated redeliveries are still dropped silently.
4. App setting `reject_unknown_recipients` (default off). On: mail whose recipient is not a
   `sender_identities` address is rejected with "No such mailbox" before anything else runs. Off keeps
   the catch-all behaviour (an Email Routing catch-all rule stores mail to any address under the
   domain).
5. A rejection is audited (`inbound.rejected`, actor `rule` or `system`) and counts in
   `rules.match_count`; nothing else is written. Rejected mail is not forwarded, not auto-replied, not
   webhooked.

## 1. Evaluator split

**Files:** `worker/src/lib/rules/evaluate.ts`, `worker/src/lib/rules/types.ts`,
`worker/src/lib/rules/validation.ts`, `worker/src/email-handler.ts`, tests.

- `types.ts`: `RuleActionSchema` gains `{ type: "reject", reason?: string }` — `reason` 1–200 printable
  ASCII characters (it travels in the SMTP reply), default `"Rejected by mailbox policy"`.
- `validation.ts`: a rule containing `reject` must contain exactly one action; `reject` may be
  inbox-scoped or global.
- `evaluate.ts`:
  - `selectMatchingRules(db, { inbox, message: RuleMessage }): Promise<MatchedRule[]>` loads the enabled
    `message.received` rules for the inbox (same query as today), parses conditions/actions (malformed
    rules are skipped with the same warning), runs `matchConditions`, and returns the matched rules in
    order, stopping after the first with `stop_processing`. No writes.
  - `runMatchedRules(db, matched, input: RuleEvaluationInput, runtime)` runs the actions of each matched
    rule exactly as `evaluateRules` does today (per-action try/catch, match stats, `markedSpam`/`snoozed`
    result). `evaluateRules` stays as a thin wrapper for existing tests.
  - `rejectionOf(matched): { ruleId, reason } | null` — the first matched rule whose action is `reject`.
- `email-handler.ts`, new order after `parseEmail`:
  1. recipient canonicalisation (as today);
  2. **unknown recipient** (§2): reject and return;
  3. blocklist drop; Message-ID dedupe (as today);
  4. `matched = await selectMatchingRules(…)` with the `RuleMessage` built from `parsed`:
     `hasAttachments` is `parsed.attachments.length > 0` (the same value the post-storage input used),
     plus `spamScore`, `headers`, `fromAddress`, `subject`, `bodyText`, `bodyHtml`;
  5. `rejection = rejectionOf(matched)` → `message.setReject(reason)`, bump `match_count`/`last_matched_at`
     of that rule, emit `inbound.rejected` (`details`: from, recipient, subject, messageId, ruleId),
     `console.log`, return;
  6. people upsert, attachments, raw blob, `emails` insert (as today);
  7. spam threshold (D14), then `runMatchedRules(db, matched, …)` instead of `evaluateRules` — still
     skipped entirely when `autoFiledSpam` is set (D21), exactly as today;
  8. suggested reply, notifications, webhooks, forwarding (as today).

## 2. Unknown recipients

**Files:** `worker/src/email-handler.ts`, `worker/src/routers/admin-router.ts` (`/settings`),
`src/pages/SettingsPage.tsx` or `src/pages/InboxesPage.tsx`.

- `app_settings.reject_unknown_recipients = "true"` → if `recipientCanonical` is not in
  `sender_identities` (the `identityRows` query moves up to run before storage; it is one small table
  read) → `message.setReject("No such mailbox")`, emit `inbound.rejected` (actor `system`, `details.reason:
"unknown_recipient"`), return.
- Settings UI: a toggle under Inboxes admin: "Reject mail to addresses that aren't inboxes", with the
  sentence "Off, mail to any address under your routed domains is stored (catch-all)."
- `settings.changed` on toggle.

## 3. Automations UI

**Files:** `src/pages/AutomationsPage.tsx` (action builder), `docs/automations.md`.

- Action "Reject the message" with an optional reason field (200 chars) and a warning line: "The
  sender's server is told the message was refused. Nothing is stored. This must be the rule's only
  action." The builder disables adding other actions once `reject` is present and vice versa.
- The dry-run ("test against a message") endpoint reports `wouldReject: true` for a reject match
  (no SMTP effect in dry-run).

## Tests

- Evaluator: `selectMatchingRules` returns the same ordered set as before for the fixture rules
  (including `stop_processing`); `runMatchedRules` reproduces `evaluateRules` results; `rejectionOf`.
- Handler: a matching `reject` rule → `setReject` called with the reason, no `emails`/`people`/
  `attachments` rows, no R2 writes, no queue message, no fan-out, one audit row, `match_count` + 1; a
  `stop_processing` rule before the reject rule prevents the rejection; a reject rule after a
  non-matching rule still rejects; blocked sender still dropped without `setReject`.
- Unknown recipient: setting on → `setReject("No such mailbox")`, audit row; setting off → stored as
  today; a known inbox with different case is known.
- Validation: `reject` with a second action → `InvalidRuleError`; reason length.
- e2e: Automations builder creates a reject rule (no live SMTP; the dry-run path shows `wouldReject`).

## Docs and CHANGELOG

- `docs/automations.md`: the action, when it runs, the one-action rule, the audit row.
  `docs/inboxes.md`: the unknown-recipient setting and the catch-all default. `docs/architecture.md`:
  the new inbound order (one diagram line).
- CHANGELOG `### Added`: **Reject mail at the door.** …

## Spec changes (implementation)

The five decisions are unchanged. What the code does differently, and why:

1. **Matching before storage reads the parsed HTML** (`parsed.bodyHtml`), not the copy with `cid:`
   references rewritten to attachment URLs. The only condition that reads HTML, `body contains`, reads
   the plain text when there is any and otherwise the HTML converted to text, which drops `src`
   attributes. An HTML-only message whose links point at `cid:` URLs could match differently (link
   targets are kept in the text); the rule test still reads the stored, rewritten HTML.
2. **The `sender_identities` read moves to the top**, and the `reject_unknown_recipients` setting is
   read only when the recipient is not an inbox, so the common path costs no extra query.
3. If selecting the rules fails (a D1 error), the message is stored with no rule actions and the
   failure logged, as a failed `evaluateRules` did before: a rule never makes delivery fail.
4. `recordRuleMatch` is shared by the rejection and the action pass; `runMatchedRules` no longer checks
   `stop_processing`, since the selection already stopped there.
5. The audit row's target is the rule (`target_type: "rule"`, its id) for a rule rejection and the
   address (`target_type: "inbox"`) for an unknown recipient; `details.reason` is the SMTP reason or
   `"unknown_recipient"`.
6. The dry run takes the rule's `actions` (optional, alongside `conditions`) to answer `wouldReject`.
7. The unknown-recipient toggle sits at the bottom of the **Inboxes** page, read and written through
   `GET`/`PATCH /api/admin/settings` (`rejectUnknownRecipients`).
8. **An inbox is an address with a sender identity or assigned members**, not only a
   `sender_identities` address (decision 4). The Inboxes page lists every address that ever received
   mail, and members can be assigned to one with no identity; refusing those would bounce mail a team
   is working. Turning the setting on first lists the addresses with mail in the last 30 days that
   would be refused (`GET /api/admin/settings/unknown-recipients`) and asks to confirm.
9. **A reject rule is decided before the inbox spam threshold** (D14), so it refuses mail the
   threshold would have filed to Junk; the threshold still keeps the other rules' actions from running
   (D21).
10. Cloudflare runs the handler once per recipient, and does not document how one invocation's
    `setReject` combines with another that accepts the same message (an SMTP refusal after the content
    is for the whole message). Not tested live; documented as such in `docs/automations.md` and
    `docs/inboxes.md`.
11. A reject reason is trimmed; the builder turns curly quotes and dashes into plain ones and refuses
    other non-ASCII before saving. The rule test sends only whether the rule rejects, so an action still
    being filled in cannot fail it.
12. Rules are created only through the admin HTTP API (and the web page on it), so that is the one
    place `reject` is offered; MCP's `list_rules` shows it like any other action.
