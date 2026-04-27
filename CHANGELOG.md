# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.2] - 2026-04-27

### Fixed

- Web push notification clicks now deep-link directly to the relevant person's conversation instead of landing on the inbox root.

## [0.2.1] - 2026-04-25

### Fixed

- Web push notifications now successfully decrypt in Chrome and other browsers: `deriveAes128GcmKeys` was appending a redundant `0x01` counter byte to the HKDF info before calling `hkdfExpand`, but `hkdfExpand` (RFC 5869) already appends its own counter byte for the first output block. The double-`0x01` caused "AES-GCM decryption failed" in `chrome://gcm-internals` while FCM silently accepted the malformed ciphertext. A known-answer test against the RFC 8291 §5 vector has been added to catch future regressions.

### Dependencies

- Bumped `postcss` from 8.5.9 to 8.5.10 (dev dependency).

## [0.2.0] - 2026-04-24

### Added

- Browser push notifications: users can now receive push alerts for new emails without the tab being open, powered by the Web Push Protocol (VAPID).
- `push_subscriptions` table stores per-user browser subscriptions.
- `GET /api/notifications/config` returns the server's VAPID public key so the frontend can subscribe.
- `POST/DELETE /api/notifications/subscriptions` for managing push subscriptions.
- `/deliver` endpoint on `NotificationsHub` Durable Object fans out new-email events to active WebSocket connections and falls back to Web Push when no WebSocket is present.
- Service worker (`sw.js`) that handles incoming push events and displays system notifications.
- Push orchestration library in the frontend (`usePush`) that manages subscription lifecycle, permission requests, and server sync.
- Contextual opt-in banner shown in the inbox when push permission has not yet been granted.
- Notifications settings page where users can subscribe or unsubscribe from push alerts.
- "Settings" entry added to the user dropdown in the sidebar for quick access to the new page.
- `vapid:generate` script (`scripts/generate-vapid.ts`) to generate a VAPID keypair for new deployments.
- VAPID configuration step added to the onboarding and update skills.
- `VAPID_SUBJECT` added to `wrangler.jsonc.example` and regenerated `worker-configuration.d.ts`.
- E2E smoke test covering the notifications settings page.
- Admin delete-person action: admins can delete a person and all associated emails from the person list via a new kebab menu, with a confirmation dialog and `DELETE /api/people/:id` endpoint.

### Fixed

- Web push is now always attempted when a new email is delivered; the previous logic skipped push if any WebSocket was open, even for other users.
- Push subscription UI in settings now surfaces errors, shows a loading state, and prevents double-clicks while a request is in-flight.

### Changed

- `NotificationsHub` Durable Object now captures `env` in its constructor so the `/deliver` handler can access bindings without passing them per-call.
- `/deliver` path on `NotificationsHub` now logs missing VAPID config, empty subscription lists, non-2xx push responses, and thrown `sendPush` errors instead of silently swallowing them, and warns if `VAPID_SUBJECT` is not a valid `mailto:`/`https:` URL.

### Dependencies

- Bumped `actions/setup-node` from 4 to 6.
- Bumped `github/codeql-action` from 3 to 4.
- Bumped `actions/upload-artifact` from 4 to 7.
- Bumped `@codemirror/view` (codemirror group).
- Bumped the tiptap group (4 packages).

## [0.1.2] - 2026-04-23

### Added

- Real-time inbox updates via Durable Object WebSockets: the inbox, person list, and open conversation now refetch automatically when new mail arrives, without any manual refresh.
- `NotificationsHub` Durable Object maintains hibernatable, per-user WebSocket connections keyed by user ID so only the correct user's connections are notified.
- `/api/notifications/stream` WebSocket upgrade endpoint; session and inbox permissions are validated in the main worker before the connection is forwarded to the DO.
- `useRealtimeUpdates` React hook that opens a WebSocket, reconnects on close, and fires a callback on `email_received` events.
- `wrangler.jsonc.example` now documents the DO binding and the required v1 migration for fresh deployers.

### Changed

- Emails are now marked read only when the user explicitly clicks the mark-read control. Auto-marking on conversation open has been removed because it conflicted with the upstream `onEmailRead` callback contract and broke the unread-count-sync test.

### Security

- WebSocket upgrade endpoint validates the `Origin` header against `TRUSTED_ORIGINS` to block Cross-Site WebSocket Hijacking (CSWSH).

## [0.1.1] - 2026-04-23

### Added

- Issue and pull-request templates, Code of Conduct, Dependabot config, CodeQL scanning, and `.editorconfig` for open-source community hygiene.
- Type-check step added to the CI test workflow.
- CI, license, and Cloudflare badges added to the README.

### Fixed

- Cloudflare Email Sending binding now works with custom headers (Message-ID, In-Reply-To): the sender rewrites outbound messages as raw MIME via `mimetext` instead of the object-form builder, which rejects non-whitelisted headers.
- Sidebar unread and total counts now update immediately when an email is read or deleted, instead of remaining stale until the next refetch.

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

[Unreleased]: https://github.com/choyiny/saasmail/compare/v0.2.2...HEAD
[0.2.2]: https://github.com/choyiny/saasmail/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/choyiny/saasmail/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/choyiny/saasmail/compare/v0.1.2...v0.2.0
[0.1.2]: https://github.com/choyiny/saasmail/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/choyiny/saasmail/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/choyiny/saasmail/compare/v0.0.1...v0.1.0
[0.0.1]: https://github.com/choyiny/saasmail/releases/tag/v0.0.1
