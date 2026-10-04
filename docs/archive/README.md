# Archive

Specs and task notes for work that shipped or was dropped. Nothing here is kept
in step with the code: it says what was decided and built at the time. New work
gets a new spec in [`docs/specs/`](../specs/).

| File                                                     | Outcome                                                                                                              | Month   |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ------- |
| [SPEC-jmap-live-updates.md](./SPEC-jmap-live-updates.md) | Shipped in #64: EventSource push, `Email/queryChanges`, `Thread/changes`, search filters                             | 2026-09 |
| [SPEC-jmap-email-import.md](./SPEC-jmap-email-import.md) | Shipped in #65: `Email/import` into Drafts, so aerc can send                                                         | 2026-09 |
| [SPEC-jmap-hardening.md](./SPEC-jmap-hardening.md)       | Shipped in #66: one JSON bind per inbox list, import scanner fixes, push budget, Mailbox/get                         | 2026-09 |
| [SPEC-reply-to.md](./SPEC-reply-to.md)                   | Shipped in #67: replies follow the sender's Reply-To, own inboxes skipped, `recipient: "sender"`, composer hint      | 2026-10 |
| [SPEC-audit-log.md](./SPEC-audit-log.md)                 | Shipped in #68: `audit_events`, actors at every boundary, the event catalogue, admin API and page, 180-day retention | 2026-10 |
