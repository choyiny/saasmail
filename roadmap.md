# Implementation Roadmap

Updated: 2026-10-04

This file tracks the stages built on top of saasmail's customer timeline, inbox
permissions, newsletters, sequences, MCP/WebMCP and delivery infrastructure.
The goal is one self-hosted system with two views over the same mail: the
person-centric **customer view** and a conventional **mailbox view**. The
native agent, MCP, WebMCP and JMAP are further clients of the same services.

## Status

Stages 1–7 are complete, including JMAP sending and the JMAP v1 follow-ups (#45–#66).
Stage 8 is deferred. Stages 9–11 shipped one spec per PR (#67–#78), in the order of
[`docs/archive/TASKS-stages-9-11.md`](docs/archive/TASKS-stages-9-11.md); their specs are in
[`docs/archive/`](docs/archive/).

| Stage | Scope                                                                                                                                  | PR      | Merge commit     |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------- | ------- | ---------------- |
| 1A    | Unified message read model (`queryMessages`, `UnifiedMessage`)                                                                         | #3      | `19f0418`        |
| 1B-0  | Index-friendly inbox reads (canonical lowercase addresses)                                                                             | #4      | `2c3b4f4`        |
| 1B-1  | Sequence provenance on sent messages                                                                                                   | #5      | `32ea431`        |
| 1B-2a | Message state schema and services                                                                                                      | #6      | `5a18641`        |
| 1B-2b | State reads, routes, and MCP/WebMCP tools                                                                                              | #8      | `d019e48`        |
| 1C    | Conversation snooze                                                                                                                    | #9      | `3960341`        |
| 3a    | Mailbox view shell, list, and reading pane                                                                                             | #10     | `e1d9475`        |
| 3b    | Bulk actions, folders, and keyboard shortcuts                                                                                          | #11     | `9ef403c`        |
| 3c    | Drafts folder and per-inbox spam threshold                                                                                             | #12     | `5f392aa`        |
| 2a    | Native agent runtime                                                                                                                   | #13     | `482cde6`        |
| 2b    | Native agent UI                                                                                                                        | #14     | `386900d`        |
| 2c    | Suggested replies                                                                                                                      | #15     | `098881a`        |
| 4a    | Rules engine and conversation assignment                                                                                               | #16     | `fd9faf9`        |
| 4b    | Automations page and assignment UI                                                                                                     | #17     | `874bf03`        |
| 4c    | Rule auto-replies                                                                                                                      | #18     | `2b41377`        |
| 5     | Customer identity graph                                                                                                                | #19     | `ed89a47`        |
| 6     | Agent CRM actions with approval                                                                                                        | #21     | `258021a`        |
| 7a    | Read-only JMAP                                                                                                                         | #24     | `8025e55`        |
| 7b    | JMAP change log and `Email/set`                                                                                                        | #26     | `4042c01`        |
| QA 1  | Data correctness fixes from the production QA pass                                                                                     | #27     | `d04dfe2`        |
| QA 2  | Agent fixes: reasoning models, signed approvals, teammate lookup                                                                       | #28     | `da49cf0`        |
| QA 3  | Automation guards and JMAP conformance                                                                                                 | #29     | `5ee9ab2`        |
| QA 4  | Real type checks, SQL logging off by default, upgrade docs                                                                             | #30     | —                |
| 7c-1  | JMAP ids are RFC 8620-valid; account reset                                                                                             | #39     | `ad9c35b`        |
| 7c-2  | Crash-safe sent attachments and outbox bookkeeping ownership                                                                           | #40     | `22fc601`        |
| 7c-3  | JMAP upload, blob download and creation references                                                                                     | #41     | `496d91a`        |
| 7c-4  | JMAP drafts and stored message content                                                                                                 | #42     | `12ca097`        |
| 7c-5  | JMAP EmailSubmission                                                                                                                   | #43     | `0a2f726`        |
| 7c-6  | JMAP on-success filing, crash recovery, e2e script and docs                                                                            | #44     | `ac0276b`        |
| 7d    | JMAP v1 follow-ups: several To/Bcc, delayed send, drafts in folders, raw blobs, shared drafts, live updates, `Email/import`, hardening | #45–#66 | `35c5dd1` (last) |
| 9-1   | Replies follow the sender's Reply-To (`docs/archive/SPEC-reply-to.md`)                                                                 | #67     | `10f39e6`        |
| 9-2   | Audit log (`docs/archive/SPEC-audit-log.md`)                                                                                           | #68     | `3b42c45`        |
| 9-3   | Idempotency keys for sends (`docs/archive/SPEC-send-idempotency.md`)                                                                   | #69     | `ee8a135`        |
| 9-4   | Pause switch, MCP kill switch, daily caps (`docs/archive/SPEC-send-controls.md`)                                                       | #70     | `c1ecdd2`        |
| 9-5   | Sign-in rate limits and passkey-only sessions; two-factor sign-in dropped (`docs/archive/SPEC-two-factor.md`)                          | #71     | `f4b0625`        |
| 10-1  | `reject` rule action, unknown-recipient rejection (`docs/archive/SPEC-reject-inbound.md`)                                              | #72     | `35d68d6`        |
| 10-2  | AI filing into folders (`docs/archive/SPEC-ai-folders.md`)                                                                             | #73     | `ee7fc98`        |
| 10-3  | A spam filter that learns from junk marks (`docs/archive/SPEC-spam-learning.md`)                                                       | #74     | `ea365b7`        |
| 11-1  | mbox export and `.eml` download (`docs/archive/SPEC-mail-export.md`)                                                                   | #75     | `a6b9d6b`        |
| 11-2  | mbox/eml import (`docs/archive/SPEC-mail-import.md`)                                                                                   | #76     | `9e1a87e`        |
| 11-3  | Scheduled D1 backups to R2 and a restore script (`docs/archive/SPEC-backups.md`)                                                       | #77     | `893e240`        |
| 10-4  | Header-based threading per inbox, last (`docs/archive/SPEC-header-threading.md`)                                                       | #78     | `4765891`        |

A row with `—` is on a branch that hasn't merged yet; fill in the PR number and
squash commit when it lands.

The stage order isn't numeric because Stage 3 (the mailbox view) needed Stage
1's state model, while the agent (Stage 2) could land later.

## What each stage delivered

- **Stage 1: mail foundation.**
  - A message is exactly `emails ∪ sent_emails`, read only through
    `worker/src/lib/messages/query.ts`.
  - Per-user state (seen, starred) is kept separate from shared per-inbox state
    (archive, spam, trash, folders).
  - Conversation snooze has no cron: it's evaluated at read time and woken by
    new inbound mail.
  - See [docs/mailbox-state.md](docs/mailbox-state.md).
- **Stage 2: native agent.**
  - An `AIChatAgent` Durable Object per user session, with sessions, streaming
    and visible tool calls.
  - Per-inbox agent instructions, and suggested replies behind a
    prompt-injection screen.
  - The agent never sends mail.
  - See [docs/agent.md](docs/agent.md).
- **Stage 3: mailbox view.**
  - Inbox, Sent, Drafts, Starred, Snoozed, Archive, Spam, Trash and user
    folders for each inbox.
  - Bulk actions and keyboard shortcuts.
  - A per-inbox spam threshold.
- **Stage 4: one automations engine.**
  - `message.received` rules: conditions are ANDed and there's no regex.
  - Actions: archive, spam, folder, snooze, assign, and auto-reply with
    loop/flood guards.
  - Conversation assignment.
  - See [docs/automations.md](docs/automations.md).
- **Stage 5: identity graph.**
  - Manual linking of several addresses into one customer; merging two
    existing customers is admin-only.
  - See [docs/customers.md](docs/customers.md).
- **Stage 6: agent CRM actions.**
  - Enroll, cancel, add to list, assign, and link customer. Each needs
    per-call human approval on a signed approval card.
- **Stage 7: JMAP.**
  - An RFC 8620/8621 core subset: Session, `Mailbox/*`, `Email/*`,
    `Thread/get`, `Identity/get`, and `Email/set` for keywords and mailbox
    membership.
  - A trigger-based change log.
  - Sending (7c): RFC 8620-valid ids, blob upload and download, drafts with a
    stored RFC 5322 form, and `EmailSubmission` with the RFC 8621 on-success
    update, as transactional one-To messages through the shared outbox.
  - See [docs/jmap.md](docs/jmap.md).

- **Stage 9: trust and safety** (#67–#71). Replies follow Reply-To; an audit
  log fed by every channel; idempotency keys on sends; a pause switch that
  holds the outbox, an `MCP_SEND_ENABLED` kill switch and daily caps per
  channel; D1-backed sign-in rate limits and passkey-only sessions. The TOTP
  second factor was dropped: a password cannot sign in to a passkey account.
- **Stage 10: triage** (#72–#74, #78). A `reject` rule action evaluated
  before storage and optional rejection of unknown recipients; folder colours
  and descriptions with an `ai_file` rule action; a per-inbox Bayes spam
  filter trained by the team's junk marks, exposed as a `spam_probability`
  condition; last, header-based threading as a per-inbox option.
- **Stage 11: data ownership** (#75–#77). mbox export and `.eml`
  download; mbox/eml import through the shared inbound storage helper; daily
  logical D1 backups to R2 with a CLI restore.

## Deferred

- **Stage 8, portability (a non-Cloudflare runtime):** only on real demand.
- **JMAP follow-ups:** search snippets and vacation response.
- **A second sign-in factor (TOTP or similar):** deferred on 2026-10-04, not
  dropped. Stage 9 shipped sign-in rate limits and passkey-only sessions
  without it, because a password can't sign in to a passkey account
  (`docs/archive/SPEC-two-factor.md`). It needs a new spec that says what a
  second factor protects once sign-in is passkey-only.
  Candidates: creating API keys (API keys skip the passkey gate), account
  recovery after losing every passkey, and a step-up check before sensitive
  admin actions.
- **Snooze-expiry notifications:** there is no wake-up cron by design.
- **Calendar, invites and booking pages:** a second product; revisit booking
  links on the customer timeline after stage 10.

## Principles

1. A message is `emails ∪ sent_emails`: no third source, and delivery machinery
   is not mail. Drafts, from the web composer or from JMAP, are unsent client
   state, not mail.
2. D1 is the system of record. Durable Objects are for coordination and agent
   session state only.
3. One permission-checked service layer serves HTTP, MCP, WebMCP, the native
   agent and JMAP.
4. Personal state stays separate from shared state.
5. A human confirms before anything is sent or any CRM change is made.
6. Changes are additive: new tables and modules, never reshaped upstream
   tables.
7. Limits live at the boundary (HTTP/MCP/JMAP), not in internal services.
