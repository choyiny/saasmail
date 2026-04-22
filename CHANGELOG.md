# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-04-21

### Added

- Reply action is now available on sent messages, allowing you to continue outbound conversations from the person detail view.
- `/reply/{emailId}` endpoint accepts sent-email IDs in addition to received-email IDs.
- `message_id` column on `sent_emails` table; a standards-compliant Message-ID header is generated and persisted on every send, reply, and sequence delivery.
- `generateMessageId` helper in the worker for consistent Message-ID generation.
- Saasmail logo adopted as the default app branding; `APP_NAME` and `APP_LOGO_LETTER` environment variables removed.
- Email links inside message bodies open in a new tab.

### Changed

- Compose editor simplified to plain rich-text format with an enlarged modal.

### Fixed

- Reply endpoint now rejects sent-email IDs belonging to inboxes the caller does not own.
- Person detail header displays the contact's email address inline beside their name.
- Compose editor padding restored after accidental removal.
- Email attachments are now handled correctly end-to-end.

## [0.0.1] - 2026-04-18

### Added

- Initial release of saasmail — self-hosted email server on Cloudflare Workers.
- One unified timeline per customer, collapsing marketing, notifications, and support emails into a single per-person view.
- Multi-inbox support with per-inbox display names and team member permissions.
- Per-inbox display mode: render as **Thread** (traditional email threading) or **Chat** (bubble-style conversation).
- Inbound email via Cloudflare Email Workers.
- Outbound email via Cloudflare Email Sending (`EMAIL` binding) or Resend (`RESEND_API_KEY`).
- Admin UI to create and configure inboxes.
- Authentication via better-auth, including passkey support.
- Drizzle ORM schema and migrations backed by Cloudflare D1.
- Hono + Zod OpenAPI backend with Swagger UI.
- React + Tailwind frontend with TipTap rich-text composer and CodeMirror HTML editor.
- Person detail view with `ChatInboxSection` (bubble layout, pagination, plain-text quick reply) and `ThreadInboxSection`.
- Stats endpoint with per-inbox and per-person aggregates.
- Demo deploy mode (`deploy:demo`) for DB-only demo instances.
- Project scaffolding: Vite build, Vitest tests, Prettier, Husky + lint-staged, TypeScript strict mode.

[Unreleased]: https://github.com/choyiny/saasmail/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/choyiny/saasmail/compare/v0.0.1...v0.1.0
[0.0.1]: https://github.com/choyiny/saasmail/releases/tag/v0.0.1
