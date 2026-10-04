# SPEC: Audit log

Stage 9 (trust and safety), slice 2 of 5. Depends on nothing; the later Stage 9–11 specs emit events
through it, so it ships before them. Label `minor`.

## Why

Shared inboxes are changed by several people, by API keys, by MCP clients, by JMAP clients, by rules and
by the native agent. Today the only traces are `updated_by` on state rows, `rules.match_count`, and
console lines for approved agent CRM actions (the roadmap lists "a persistent audit table for agent CRM
actions" as deferred). When a message disappears from Inbox or a reply goes out under a shared
identity, nobody can say who or what did it. Mailflare ships an audit log; a self-hosted team mail
server needs one.

## Decisions (proposed 2026-10-03)

1. One append-only table, `audit_events`, written best-effort (a failed audit write is logged and never
   fails the user's request).
2. Services write the events, not routes, so every channel is covered once. The actor is not a service
   parameter: a request-scoped context carried by `AsyncLocalStorage` (`node:async_hooks`, available
   under `nodejs_compat`) is set at each boundary (HTTP, MCP, JMAP, agent turn) and read by the
   recorder. Outside a request (cron, queue, inbound) the context is `system`, or `rule` when a rule
   acts.
3. Recorded: anything that sends mail, changes shared mail state, deletes, or changes configuration,
   membership, credentials or permissions. Not recorded: reads, per-user seen/starred, routine
   per-message rule actions (archive/folder/snooze/assign on inbound mail: `match_count` covers them and
   they would dominate the table), realtime/push fan-out, inbound storage itself.
4. Retention 180 days (`AUDIT_RETENTION_DAYS`, optional var), pruned in bounded batches by the hourly
   maintenance chain, like `jmap_changes`.
5. Admin-only. Members do not see the log, not even for their own actions (it names other people's
   actions in the same rows).

## 1. Table

**Files:** `worker/src/db/audit-events.schema.ts`, `worker/src/db/schema.ts`, generated migration,
`worker/src/__tests__/helpers.ts`.

```
audit_events (
  id            TEXT PRIMARY KEY,          -- nanoid
  at            INTEGER NOT NULL,          -- unix seconds
  actor_type    TEXT NOT NULL,             -- user | api_key | mcp | jmap | agent | rule | system
  actor_user_id TEXT NULL,                 -- users.id when a person is behind the actor (also for api_key/mcp/jmap/agent)
  actor_label   TEXT NOT NULL,             -- "jane@acme.com", "API key sk_abcde...", "MCP client Claude", "rule Invoices", "system"
  channel       TEXT NOT NULL,             -- web | api | mcp | jmap | agent | rule | inbound | cron | queue | import
  action        TEXT NOT NULL,             -- dotted name from the catalogue below
  target_type   TEXT NULL,                 -- message | conversation | folder | inbox | user | api_key | rule | setting | list | campaign | sequence | customer | oauth_client | backup | import | export
  target_id     TEXT NULL,
  inbox         TEXT NULL,                 -- lowercase inbox address when the event belongs to one
  summary       TEXT NOT NULL,             -- one human sentence, written by the emitter, ≤ 300 chars
  details       TEXT NULL,                 -- JSON, ≤ 4 KB after serialisation (truncate arrays, never secrets)
  ip            TEXT NULL,                 -- cf-connecting-ip, HTTP channels only
  user_agent    TEXT NULL                  -- ≤ 200 chars
)
indexes: (at), (actor_user_id, at), (inbox, at), (action, at)
```

Bulk operations write one row with `details.count` and the first 20 refs; `target_id` is `NULL`.

## 2. Context and recorder

**Files:** new `worker/src/lib/audit/context.ts`, `record.ts`, `events.ts`, `actors.ts` (one builder
per kind of actor), `mail-events.ts` and `crm-events.ts` (the emitters services share), `prune.ts`;
`worker/src/lib/request-auth.ts` (returns the API key's id and prefix), `worker/src/index.ts` (HTTP,
inbound, queue and cron entry points), `worker/src/mcp/http.ts`, `worker/src/jmap/http.ts` and `auth.ts`,
`worker/src/lib/agent/tools.ts` and `worker/src/agent/mail-agent.ts`, `worker/src/lib/rules/evaluate.ts`,
`worker/src/auth/audit-hooks.ts` (better-auth `hooks.after`), `worker/src/node-async-hooks.d.ts`.

- `context.ts`: an `AuditActor` type with `actorType`, `actorUserId`, `actorLabel`, `channel`, and the
  optional `ip`, `userAgent`, `apiKeyId`, `mcpClientId`, `agentSessionId`, `ruleId`;
  `runWithAudit(actor, fn)` and `currentAuditActor()` (returns the `system` actor when unset). One
  `AsyncLocalStorage` instance, module-level.
- HTTP: every request starts as an anonymous `system`/`web` actor carrying the caller's IP and user
  agent; the `/api/*` auth middleware then runs the rest of the request as the resolved actor
  (`session` → `user`/`web`; `apiKey` → `api_key`/`api`, labelled with the key's stored prefix, which
  `resolveRequestAuth` now returns with the key's id). Public routes that know who is acting (invite
  accept) name that person themselves.
- MCP: in the request handler, after the token is resolved: `mcp` with the OAuth client id/name.
- JMAP: in `authenticateJmap`'s caller: `jmap`, label "JMAP (<bearer prefix or session>)".
- Agent: each tool's `execute` runs inside `runWithAudit({ actorType: "agent", actorUserId,
agentSessionId, … })` (identity from D1 per D22). The wrap is per tool, not per turn, because tools
  execute while the response stream is read, after the turn's caller has returned. An approval-gated
  tool that ran emits `agent.action_executed`; a `tool-output-denied` part in a finished step emits
  `agent.action_denied`.
- Inbound handler, queue consumer and cron: `system`; the rules evaluator wraps each rule's actions in
  `runWithAudit({ actorType: "rule", ruleId, actorLabel: "rule " + rule.name, channel: "rule" })` so
  rule-caused sends and rejections name the rule. A delayed JMAP send released by the queue or cron is
  recorded as the person who scheduled it.
- Sign-ins, passkey changes and OAuth registration and consent are handled by better-auth and pass
  none of our routes: a `hooks.after` on the auth configuration records them.
- `record.ts`: `recordAudit(db, { action, targetType?, targetId?, inbox?, summary, details? })` reads
  the actor, truncates `details` and `summary`, inserts, catches and `console.warn`s. Callers await it
  (the queue consumer has no `ctx` to hand it to). `recordBulkAudit` writes the one-row-with-a-count
  form, and `collectAudit(db, fn)` merges the rows of a loop that changes one message per service call
  (a JMAP `Email/set`, the blocked-mail purge) into one per action and inbox.
- `events.ts`: the action names as a `const` object with a TypeScript union, so a typo fails
  `yarn typecheck`.

## 3. Event catalogue (where each is emitted)

| Action                                                                                                                               | Emitted from                                                                                                                                                       | Summary example                                                                                                                  |
| ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| `mail.sent`                                                                                                                          | `sendEmail`, `replyToEmail`, `send-template.ts`, `jmap/submission.ts` and `jmap/release.ts` (JMAP, now and delayed), auto-reply                                    | "Sent 'Re: invoice' to jane@acme.com from support@…" (`details`: sentEmailId, to, cc count, channel, templateSlug, replyTo used) |
| `mail.archived` / `mail.unarchived` / `mail.spam` / `mail.not_spam` / `mail.trashed` / `mail.restored`                               | `setMailboxState` when `userId` is non-null or the actor is a rule with `mark_spam`                                                                                | "Archived 3 messages in support@…"                                                                                               |
| `mail.moved`                                                                                                                         | `setMailboxMembership` (add/remove)                                                                                                                                | "Filed 1 message into 'Invoices'"                                                                                                |
| `mail.snoozed` / `mail.unsnoozed`                                                                                                    | `snoozeConversations`                                                                                                                                              |                                                                                                                                  |
| `mail.assigned` / `mail.unassigned`                                                                                                  | `assignConversations`                                                                                                                                              |                                                                                                                                  |
| `mail.deleted`                                                                                                                       | every hard-delete path (`delete_email`, emails/sent routes, person delete cascade)                                                                                 |                                                                                                                                  |
| `inbound.rejected`                                                                                                                   | SPEC-reject-inbound                                                                                                                                                | "Rejected mail from x@y to hello@… (rule 'Block vendors')"                                                                       |
| `sending.paused` / `sending.resumed` / `send.limit_reached`                                                                          | SPEC-send-controls                                                                                                                                                 |                                                                                                                                  |
| `settings.changed`                                                                                                                   | admin settings routes (`app_settings`, brand, sending controls)                                                                                                    | `details.{key, from, to}`; secret-like keys record only that they changed                                                        |
| `inbox.created` / `inbox.updated` / `inbox.deleted`                                                                                  | `admin-inboxes-router.ts`                                                                                                                                          | `details` lists changed fields                                                                                                   |
| `folder.created` / `folder.renamed` / `folder.deleted`                                                                               | `mailboxes-router.ts`                                                                                                                                              |                                                                                                                                  |
| `rule.created` / `rule.updated` / `rule.deleted` / `rule.toggled`                                                                    | `admin-rules-router.ts`                                                                                                                                            |                                                                                                                                  |
| `user.invited` / `user.joined` / `user.role_changed` / `user.removed` / `user.inbox_access_changed`                                  | invites, admin users, inbox permissions routes                                                                                                                     |                                                                                                                                  |
| `user.passkey_added` / `user.passkey_removed`                                                                                        | better-auth `hooks.after` on `/passkey/verify-registration` and `/passkey/delete-passkey` (the passkey plugin's endpoints)                                         |                                                                                                                                  |
| `user.two_factor_enabled` / `…_disabled` / `…_reset`                                                                                 | SPEC-two-factor                                                                                                                                                    |                                                                                                                                  |
| `auth.sign_in` / `auth.sign_in_failed`                                                                                               | better-auth `hooks.after` on `/sign-in/email`, `/passkey/verify-authentication`, `/two-factor/verify-*` (method and outcome; failed attempts carry the email only) |                                                                                                                                  |
| `api_key.created` / `api_key.revoked`                                                                                                | `api-keys-router.ts`                                                                                                                                               | label is the prefix                                                                                                              |
| `oauth.client_registered` / `oauth.consent_granted` / `oauth.consent_revoked`                                                        | oauth routes / better-auth hooks                                                                                                                                   |                                                                                                                                  |
| `customer.linked` / `customer.unlinked` / `customer.merged`                                                                          | customers service                                                                                                                                                  |                                                                                                                                  |
| `sequence.enrolled` / `sequence.cancelled` / `list.member_added` / `list.member_removed` / `campaign.started` / `campaign.cancelled` | the existing services (agent approvals included)                                                                                                                   |                                                                                                                                  |
| `agent.action_executed` / `agent.action_denied`                                                                                      | agent approval-gated tools                                                                                                                                         | `details.{tool, args (redacted to ids), result summary}`                                                                         |
| `export.*`, `import.*`, `backup.*`                                                                                                   | Stage 11 specs                                                                                                                                                     |                                                                                                                                  |

## 4. API and UI

**Files:** `worker/src/routers/admin-audit-router.ts`, `src/pages/AdminAuditPage.tsx`, `src/App.tsx`
(`/admin/audit`), the admin navigation next to Users/Inboxes/Automations, `src/lib/api.ts`.

- `GET /api/admin/audit?cursor&limit(≤100)&action&actionPrefix&actorUserId&inbox&targetType&targetId&from&to&q`
  → `{ events, nextCursor }`, newest first, cursor = `at:rowid` (the row sequence breaks ties, so events
  of the same second keep the order they happened in; ids are random). `q` is a `LIKE` on `summary` and
  `actor_label`. Admin only (the `/api/admin/*` role guard in `worker/src/index.ts`), passkey-gated like other admin
  routes.
- `GET /api/admin/audit/export.csv` with the same filters, at most 10,000 rows, `Content-Disposition:
attachment`.
- `GET /api/admin/audit/actions` → every action name in the catalogue (for the filter dropdown).
- Page: filter bar (action group, actor, inbox, date range, text), table (time, actor, action, target,
  inbox, summary), "Load more", a row expands to pretty-printed `details`. A "Download CSV" button.
  Mobile: one card per event instead of the table. Behind `AdminGuard`, like `/automations`.

## 5. Retention

`pruneAuditEvents(db, now)` deletes rows older than `AUDIT_RETENTION_DAYS` (default 180, min 30) in
batches of 1,000, up to ten per cron pass, appended to the hourly chain in `worker/src/index.ts` right after
`pruneJmapChanges` (no new cron schedule: `scheduled()` runs every job on every tick).

## Tests

- Recorder: writes with a set actor; falls back to `system`; truncates `details`; swallows a DB error.
- Context: the HTTP middleware sets user/web and api_key/api actors; the actor does not leak across
  concurrent requests (two `runWithAudit` calls interleaved with awaits).
- Services: `setMailboxState` by a user emits one row for a batch; by the system (D21 auto-junk) emits
  none; `replyToEmail` emits `mail.sent` with channel `rule` from an auto-reply.
- Route: filters, cursor paging, admin-only (403 for members), CSV bounded.
- Prune: deletes only older rows, bounded.
- Web (vitest): the page renders rows and expands details.

## Docs and CHANGELOG

- New page `docs/audit-log.md` (what is recorded, what is not, retention, the API) linked from
  `docs/README.md`; `docs/configuration.md` gains `AUDIT_RETENTION_DAYS`; `docs/agent.md` says where the
  agent's actions are recorded.
- CHANGELOG `### Added`: **Audit log.** …

## Spec changes (2026-10-03, while implementing)

The five decisions are unchanged. Where the code differed from what the sections assumed:

1. There was no console-only log of agent CRM actions to replace, `docs/agent.md` had no "console
   only" sentence and `roadmap.md` no longer lists the deferred item: the agent docs gain a sentence
   instead, and nothing is dropped from the roadmap.
2. The API key's id and prefix were not available at the boundary; `resolveRequestAuth` now returns
   them. Only the prefix is stored (`sk_abcde...`), so that is the label, not a suffix.
3. The MCP handler did not load the client's name; it does now.
4. `queue()` has no `ctx`, so audit writes are awaited rather than handed to `waitUntil`.
5. JMAP sends happen in `jmap/submission.ts` and `jmap/release.ts`, not `submit-message.ts`.
6. Agent tools run while the stream is read, so the actor is set around each tool, not the turn.
7. Users and invites live in `admin-router.ts`, inbox access in `admin-inboxes-router.ts`
   (`PUT /{email}/assignments`), and invite accept is a public route that names its own actor.
8. There is no toggle route for rules: a `PATCH` that only carries `enabled` is `rule.toggled`.
9. Sign-in, passkey and OAuth events come from a better-auth `hooks.after`; no hooks existed. The
   password sign-in our own pre-check refuses is recorded where it is refused.
10. `cancelSequencesForPerson` runs after every send and every inbound message, so it is not
    instrumented: `sequence.cancelled` is recorded where a person or the agent cancels on purpose.
    List membership is recorded where a person or the agent changes it (the list routes, the agent
    tool), not for public subscribe and unsubscribe links or imports. `campaign.started` is in
    `beginCampaignSend`, which the route and cron both call; `campaign.cancelled` in the route.
11. JMAP `Email/set` and the blocked-mail purge change one message per service call; `collectAudit`
    merges those rows so a bulk operation is still one row.
12. `setMailboxState` can clear several flags at once (a JMAP move to Inbox clears all three): a
    cleared flag is recorded only for messages that had it, which needs one read before the write.
13. The cursor is `at:rowid`, not `at:id`: ids are random, and events of the same second would
    otherwise list in no particular order.
14. No page had a filter bar, a table and mobile cards; MailPage has neither. The page uses a table
    on wide screens and cards on narrow ones, and sits behind `AdminGuard`.
15. `mail.sent` is recorded once the provider or the outbox has the message; a refused or fully
    suppressed send sent nothing and is not recorded. Sequence and campaign messages are not recorded
    one by one: `sequence.enrolled` and `campaign.started` cover them.
16. `AsyncLocalStorage` gets a two-method type declaration instead of `@types/node`, whose globals
    would clash with the Workers types.

After an independent review of the first implementation (same day):

17. better-auth's admin plugin serves `/api/auth/admin/*` (set role, remove, ban, set password, revoke
    sessions, impersonate), which no route of ours sees. The auth hook records them: `user.role_changed`,
    `user.removed`, `user.joined`, a new `user.updated` (ban, password, sessions; never a request
    field) and a new `user.impersonated`. An impersonated session is recorded as the admin
    ("admin@… as member@…"), not as the member.
18. `agent.action_denied` is read from the incoming messages (a tool part in `approval-responded` with
    `approved: false`); the SDK never puts the denial in a finished step, so the first version never
    fired.
19. A failed sign-in needs no authentication: it is recorded only against an existing account, never
    with what was typed, and at most once a minute per account (per caller address for a passkey).
20. Mail-state events count only what changed: the flags, folder membership and conversation state
    are read before the write (one read each, for calls by a person), and a failed audit read is
    logged instead of failing the request.
21. `mail.sent` is also recorded for a failed send that goes out on a manual Outbox retry and for a
    campaign test send.
22. New `campaign.scheduled`: cron starts a scheduled campaign as the system, so the schedule is what
    names the person.
23. Deleting a contact records its mail as one `mail.deleted` row per inbox, like every other delete.
24. A granted OAuth consent names its client; the webhook URL is logged without credentials or query.
25. The prune takes up to ten batches of 1,000 per pass (one would fall behind a busy instance), and
    `GET /api/admin/audit/actions` returns the catalogue instead of a `DISTINCT` over the table.
26. The page drops a "Load more" page that arrives after the filters changed.
