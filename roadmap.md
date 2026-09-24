# Implementation Roadmap

Updated: 2026-09-24

This file tracks the stages built on top of saasmail's customer timeline, inbox
permissions, newsletters, sequences, MCP/WebMCP and delivery infrastructure.
The goal is one self-hosted system with two views over the same mail: the
person-centric **customer view** and a conventional **mailbox view**. The
native agent, MCP, WebMCP and JMAP are further clients of the same services.

## Status

Stages 1–7 are complete. Stage 8 is deferred.

| Stage | Scope                                                            | PR  | Merge commit |
| ----- | ---------------------------------------------------------------- | --- | ------------ |
| 1A    | Unified message read model (`queryMessages`, `UnifiedMessage`)   | #3  | `19f0418`    |
| 1B-0  | Index-friendly inbox reads (canonical lowercase addresses)       | #4  | `2c3b4f4`    |
| 1B-1  | Sequence provenance on sent messages                             | #5  | `32ea431`    |
| 1B-2a | Message state schema and services                                | #6  | `5a18641`    |
| 1B-2b | State reads, routes, and MCP/WebMCP tools                        | #8  | `d019e48`    |
| 1C    | Conversation snooze                                              | #9  | `3960341`    |
| 3a    | Mailbox view shell, list, and reading pane                       | #10 | `e1d9475`    |
| 3b    | Bulk actions, folders, and keyboard shortcuts                    | #11 | `9ef403c`    |
| 3c    | Drafts folder and per-inbox spam threshold                       | #12 | `5f392aa`    |
| 2a    | Native agent runtime                                             | #13 | `482cde6`    |
| 2b    | Native agent UI                                                  | #14 | `386900d`    |
| 2c    | Suggested replies                                                | #15 | `098881a`    |
| 4a    | Rules engine and conversation assignment                         | #16 | `fd9faf9`    |
| 4b    | Automations page and assignment UI                               | #17 | `874bf03`    |
| 4c    | Rule auto-replies                                                | #18 | `2b41377`    |
| 5     | Customer identity graph                                          | #19 | `ed89a47`    |
| 6     | Agent CRM actions with approval                                  | #21 | `258021a`    |
| 7a    | Read-only JMAP                                                   | #24 | `8025e55`    |
| 7b    | JMAP change log and `Email/set`                                  | #26 | `4042c01`    |
| QA 1  | Data correctness fixes from the production QA pass               | #27 | `d04dfe2`    |
| QA 2  | Agent fixes: reasoning models, signed approvals, teammate lookup | #28 | `da49cf0`    |
| QA 3  | Automation guards and JMAP conformance                           | #29 | `5ee9ab2`    |
| QA 4  | Real type checks, SQL logging off by default, upgrade docs       | #30 | —            |

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
  - See [docs/jmap.md](docs/jmap.md).

## Deferred

- **Stage 8, portability (a non-Cloudflare runtime):** only on real demand.
- **JMAP `EmailSubmission`:** not built; it needs an explicit product decision.
  JMAP push, search snippets, vacation response and blob upload are also
  deferred.
- **Snooze-expiry notifications:** there is no wake-up cron by design.
- **A persistent audit table for agent CRM actions:** approved executions are
  logged to the Workers console only.

## Principles

1. A message is `emails ∪ sent_emails`: no third source, and delivery machinery
   is not mail.
2. D1 is the system of record. Durable Objects are for coordination and agent
   session state only.
3. One permission-checked service layer serves HTTP, MCP, WebMCP, the native
   agent and JMAP.
4. Personal state stays separate from shared state.
5. A human confirms before anything is sent or any CRM change is made.
6. Changes are additive: new tables and modules, never reshaped upstream
   tables.
7. Limits live at the boundary (HTTP/MCP/JMAP), not in internal services.
