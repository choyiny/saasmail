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
  actor_label   TEXT NOT NULL,             -- "jane@acme.com", "API key sk_…abcd", "MCP client Claude", "rule Invoices → Archive", "system"
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

**Files:** new `worker/src/lib/audit/context.ts`, `record.ts`, `events.ts`; `worker/src/index.ts`
(HTTP middleware), `worker/src/mcp/http.ts`, `worker/src/jmap/http.ts`, `worker/src/agent/mail-agent.ts`,
`worker/src/email-handler.ts`, `worker/src/lib/queue-router.ts`.

- `context.ts`: an `AuditActor` type with `actorType`, `actorUserId`, `actorLabel`, `channel`, and the
  optional `ip`, `userAgent`, `apiKeyId`, `mcpClientId`, `agentSessionId`, `ruleId`;
  `runWithAudit(actor, fn)` and `currentAuditActor()` (returns the `system` actor when unset). One
  `AsyncLocalStorage` instance, module-level.
- HTTP: a Hono middleware registered right after the auth middleware for `/api/*` builds the actor from
  `c.get("user")`, the auth method (`session` → `user`/`web`; `apiKey` → `api_key`/`api`, label from the
  key prefix) and the request headers, then `await runWithAudit(actor, next)`.
- MCP: in the request handler, after the token is resolved: `mcp` with the OAuth client id/name.
- JMAP: in `authenticateJmap`'s caller: `jmap`, label "JMAP (<bearer prefix or session>)".
- Agent: each turn runs inside `runWithAudit({ actorType: "agent", actorUserId, agentSessionId, … })`
  (identity from D1 per D22). Approved CRM tool executions emit `agent.action_executed` (this replaces
  the console-only log the roadmap deferred).
- Inbound handler, queue consumer and cron: `system`; the rules evaluator wraps each rule's actions in
  `runWithAudit({ actorType: "rule", ruleId, actorLabel: rule.name, channel: "rule" })` so rule-caused
  sends and rejections name the rule.
- `record.ts`: `recordAudit(db, { action, targetType?, targetId?, inbox?, summary, details? })` reads
  the actor, truncates `details` and `summary`, inserts, catches and `console.warn`s. It is `async` but
  callers do not have to await it on hot paths (`ctx.waitUntil` in the handler/queue).
- `events.ts`: the action names as a `const` object with a TypeScript union, so a typo fails
  `yarn typecheck`.

## 3. Event catalogue (where each is emitted)

| Action                                                                                                                               | Emitted from                                                                                                                                                       | Summary example                                                                                                                  |
| ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| `mail.sent`                                                                                                                          | `sendEmail`, `replyToEmail`, `send-template.ts`, `submit-message.ts` (JMAP), auto-reply                                                                            | "Sent 'Re: invoice' to jane@acme.com from support@…" (`details`: sentEmailId, to, cc count, channel, templateSlug, replyTo used) |
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
  → `{ events, nextCursor }`, newest first, cursor = `at:id`. `q` is a `LIKE` on `summary` and
  `actor_label`. Admin only (the `/api/admin/*` role guard in `worker/src/index.ts`), passkey-gated like other admin
  routes.
- `GET /api/admin/audit/export.csv` with the same filters, at most 10,000 rows, `Content-Disposition:
attachment`.
- `GET /api/admin/audit/actions` → the distinct action names (for the filter dropdown).
- Page: filter bar (action group, actor, inbox, date range, text), table (time, actor, action, target,
  inbox, summary), "Load more", a row expands to pretty-printed `details`. A "Download CSV" button.
  Mobile: cards instead of a table (the house pattern in MailPage).

## 5. Retention

`pruneAuditEvents(db, now)` deletes rows older than `AUDIT_RETENTION_DAYS` (default 180, min 30) in
batches of 1,000 per cron pass, appended to the hourly chain in `worker/src/index.ts` right after
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
  `docs/README.md`; `docs/configuration.md` gains `AUDIT_RETENTION_DAYS`; `docs/agent.md` replaces the
  "console only" sentence; `roadmap.md` drops the deferred item.
- CHANGELOG `### Added`: **Audit log.** …
