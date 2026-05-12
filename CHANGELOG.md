# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.4.2] - 2026-05-12

### Security

- Closed stored-XSS surface on per-inbox signatures: a new HTMLRewriter-based sanitizer (`worker/src/lib/sanitize-signature.ts`) strips dangerous tags (`script`, `style`, `iframe`, etc.), every `on*` event handler, `style` attributes, and unsafe URL schemes (`javascript:`, `vbscript:`, non-image `data:`). Signatures are sanitized at write time in the PATCH inbox endpoint (with a 20 000-character schema cap) and on the client in `ComposeModal` and `ReplyComposer` as defense-in-depth.
- `inbox-permissions.ts` lowercases addresses at resolution time, closing a latent permission-check bypass for mixed-case `inbox_permissions.email` rows.

### Fixed

- `EmailHtmlModal`: converted a `useMemo` side-effect to `useEffect`, eliminating a "Cannot update a component while rendering" warning under React StrictMode.
- Send and reply routes now cap CC arrays at 50 entries and normalize `fromAddress`, `to`, and every CC email to lowercase at the route boundary, ensuring consistent `computeConversationId` results.
- Inbound CC entries are now lowercased, trimmed, name-truncated, and filtered through a regex email-shape gate before storage; capped at 50 entries per inbound message.
- Non-admin member can no longer fetch a sent email authored from an inbox they do not own via `GET /api/emails/:id` (previously returned 200; now returns 404).
- Removed dead `inboxMode` toggle, unreachable `ThreadInboxSection` branch, and related state from `ConversationDetail` (~130 lines).

### Changed

- Drizzle meta snapshots reconciled for migrations 0021–0024, fixing a `parent snapshot collision` that prevented `drizzle-kit generate` from running; missing `app_settings` table export added to `worker/src/db/index.ts`.

## [0.4.1] - 2026-05-08

### Changed

- Compose modal converted to a right-side drawer matching the Reply composer: Radix Dialog primitives, fixed-right layout, same header/metadata/editor/footer pattern. ⌘/Ctrl+Enter sends; Send disabled until To and body are filled.
- Inbox page chrome trimmed: page title removed, Compose button moved into the toolbar row, bottom gap eliminated.
- Compact density pass: tighter padding and spacing throughout to fit more content on screen at default Mac scale.
- Footer slimmed: tighter vertical padding, smaller pill padding and font sizes, ~30 px shorter overall.

### Fixed

- Inbox card height restored to a hard `h-[calc(100vh-13rem)]` so inner scroll regions function correctly and the footer stays fully in view below the fold.
- LoginPage error message now applies `text-destructive` for correct theme colouring.
- Sign out menu item added to the user dropdown (exposes `logout-button` test ID for E2E).
- User email surfaced as the accessible title on the dropdown trigger.
- WebGL shader disabled in headless/low-capability browsers to prevent CI rendering failures.
- Templates link wired into the navigation bar.
- E2E selector and actionability drift fixed across multiple tests to align with the updated UI chrome.

## [0.4.0] - 2026-05-07

A large UX/visual overhaul plus a new bulk-actions API. Frontend, brand,
and admin tooling all changed; the data model is unchanged.

### Added

- **Brand refresh**: lime + violet palette via Tailwind v4 `@theme` tokens, Inter + Caveat fonts, animated GrainGradient backdrop on auth screens, soft pastel backdrop on the dashboard, mail-glyph favicon, OpenGraph image, comprehensive SEO meta + JSON-LD `SoftwareApplication`.
- **Top-nav layout**: floating dark pill nav with brand wordmark, route tabs, breadcrumbs strip, and a unified `Footer` (light variant for dashboard, dark variant for auth) — replaces the persistent left sidebar.
- **Inbox table view + filter toolbar**: new default view shows people as a sortable table with stats strip (people / unread / multi-inbox / with attachments). Single unified toolbar combines search, inbox dropdown, unread/attachments chips, and a List ↔ Table view toggle.
- **Bulk actions**: select multiple people via per-row checkboxes; floating `SelectionBar` exposes "Mark as read" with optimistic UI. Click an unread badge to mark just that person's emails as read. Per-inbox "Mark all in `<inbox>` as read" button on the active tab in `PersonDetail`.
- **Per-person tabbed inbox view**: when a contact has emailed multiple inboxes, each inbox is its own tab (short label, count, unread badge, mode dot) instead of stacked sections.
- **Drawer pattern for "View original" and "Reply"**: right-side animated slide-in (320 ms eased) with rich detail, From/To/ID/Time metadata, attachments with sizes, Rendered/Plain text toggle, copy-text. Reply drawer renders the email being replied to plus the surrounding thread alongside the editor (collapsible history).
- **Chat redesign**: sticky reply input always visible, day separators (Today / Yesterday / weekday), top + bottom fade affordances, "Jump to latest" / "New messages" pill when scrolled away from bottom, larger bubbles with shadow + ring.
- **Mobile-first overhaul**: floating compose FAB, full-screen drawers under `sm`, edge-to-edge inbox card on mobile, person tap opens full-screen, scroll-snap on inbox tabs, bottom-anchored selection bar with safe-area padding, larger touch targets (min 44 px), `text-base` on toolbar inputs to prevent iOS zoom.
- **Capability-aware animation gating**: new `useReducedAnimations()` hook detects `prefers-reduced-motion`, `navigator.connection.saveData`, slow connections, low device memory (< 4 GB), low core count (< 4) and renders a static CSS gradient fallback instead of the WebGL shader. Global CSS `@media (prefers-reduced-motion: reduce)` zero-duration overrides for animations and transitions.
- **Reusable page chrome**: `PageHeader` and `PageContainer` components applied to ApiKeys, Templates, Sequences, AdminUsers, Settings, and Inboxes — consistent title / subtitle / action layout, capped at `max-w-[1600px]` to better use desktop real estate.
- **Inboxes admin redesign**: real `<table>` with bulk select header checkbox, bulk Thread/Chat/Delete actions in a contextual bar, inline display-name editing, per-row mode toggle, and a popover-based member assignment cell.
- **Public legal pages**: `/terms` and `/privacy` rendered through a new `LegalLayout` (light readable doc style) with content appropriate for self-hosted Apache 2.0 software (operator-as-data-controller framing).
- **API**: `POST /api/people/mark-read` bulk endpoint (with optional `recipient` scope); `GET /api/people/grouped` accepts `recipient` / `unread` / `hasAttachment` filters and returns a new `recipients: string[]` field.
- **Demo seed generator**: `seeds/generate-demo.ts` (run via `npx tsx`) produces a 100-person / ~700-email dataset across 6 inboxes for stress-testing UI behaviour. The committed `seeds/demo.sql` is unchanged — use the generator to overwrite locally.

### Changed

- **Default inbox view** is now `Table` (was `List`).
- **Default `displayMode`** for inboxes is now `chat` (was `thread`). Existing rows keep their explicit setting; only the fallback for rows without a `sender_identities` entry flipped. Tests updated accordingly.
- **`PersonList` is now controlled** — data fetching for the people list lives in `InboxPage` so both Table and List views see the same paginated data. Previously the fetch was inside `PersonList`, which made the Table view show empty state.
- **`InboxToolbar`** consolidates what used to be three separate components (search input in the sidebar header, filter bar above the inbox card, view toggle on its own row) into a single bordered bar.
- **Auth pages** (`Login`, `Onboarding`, `InviteAccept`, `SetupPasskey`) restyled with the glass-card pattern on the animated dark backdrop. Login flow simplified to `Continue with passkey` (primary) and `Continue with email` (secondary fallback).
- **Footer** is a single-row layout (Privacy/Terms pills · copyright · sponsor pill), with a `variant="dark"` mode for auth pages so it stays legible against the dark backdrop.
- **`PeopleTable` "Inboxes" column** shows the actual inbox names as chips (first 3 + overflow `+N`), not just a count.

### Fixed

- Table view scroll: nested flex containers need `min-h-0 + overflow-hidden` on the immediate parent to constrain inner scroll regions; wrapper around `PeopleTable` updated.
- Footer was painted over by the fixed `dashboard-backdrop-mask` overlay; mask gradient now fades earlier and `Footer` is wrapped in `relative z-10`.
- Right-side drawers now slide in via pure-CSS keyframes (`drawer-slide-in / drawer-slide-out`) rather than relying on tailwindcss-animate's specific class names.

### Dependencies

- Added `@paper-design/shaders-react` for the auth-screen GrainGradient. `vite.config.ts` adds `resolve.dedupe: ["react","react-dom"]` and `optimizeDeps.include` so the lazy-loaded shader doesn't end up with a duplicate React copy.

## [0.3.3] - 2026-05-05

### Fixed

- Person-list search bar on iOS Safari: inputs with `font-size` below 16 px triggered automatic viewport zoom on focus. The search bar now uses 16 px text and a taller, more tappable input on mobile, reverting to the compact desktop size at the `sm` breakpoint.

### Dependencies

- Bumped the tiptap group (`@tiptap/extension-placeholder`, `@tiptap/pm`, `@tiptap/react`, `@tiptap/starter-kit`) from 3.22.4 to 3.22.5.
- Bumped `react` and `react-dom` from 18.3.1 to 19.2.5; bumped `@types/react` from 18.3.20 to 19.2.14.
- Bumped `@vitejs/plugin-react-swc` from 3.11.0 to 4.3.0.

## [0.3.2] - 2026-05-02

### Dependencies

- Bumped `better-auth` and `@better-auth/passkey` from 1.6.7 to 1.6.9.
- Bumped Cloudflare dev group: `@cloudflare/vite-plugin` 1.33.1 → 1.33.2, `@cloudflare/vitest-pool-workers` 0.14.9 → 0.15.0, `@cloudflare/workers-types` 4.20260423.1 → 4.20260426.1, `wrangler` 4.84.1 → 4.85.0.
- Bumped `@asteasolutions/zod-to-openapi` from 7.3.0 to 8.5.0.
- Bumped `@hono/swagger-ui` from 0.5.3 to 0.6.1.
- Bumped `actions/cache` from 4 to 5.
- Bumped `actions/checkout` from 4 to 6.

## [0.3.1] - 2026-04-30

### Dependencies

- Bumped `better-auth` and `@better-auth/passkey` from 1.6.7 to 1.6.9.
- Bumped Cloudflare dev group: `@cloudflare/vite-plugin` 1.33.1 → 1.33.2, `@cloudflare/vitest-pool-workers` 0.14.9 → 0.15.0, `@cloudflare/workers-types` 4.20260423.1 → 4.20260426.1, `wrangler` 4.84.1 → 4.85.0.
- Bumped `@asteasolutions/zod-to-openapi` from 7.3.0 to 8.5.0.
- Bumped `@hono/swagger-ui` from 0.5.3 to 0.6.1.
- Bumped `actions/cache` from 4 to 5.
- Bumped `actions/checkout` from 4 to 6.

## [0.3.0] - 2026-04-29

### Added

- Full-text email search via FTS5: the search box now surfaces people whose emails match the query by subject or body text, not just by name or email address. An `emails_fts` FTS5 virtual table is created with INSERT/UPDATE/DELETE triggers to keep the index in sync; existing emails are backfilled on migration. For members, FTS results are scoped to their permitted inboxes to prevent cross-inbox content leakage. The search box placeholder is updated to "Search…" and a clear (×) button appears when text is entered.

## [0.2.2] - 2026-04-26

### Fixed

- Clicking a Web Push notification now deep-links directly to the person's conversation instead of landing on the generic inbox view. Two bugs were fixed: `InboxPage` now reads `personId` from URL params and falls back to `fetchPerson(id)` when the contact isn't already in the loaded list; the service worker now `postMessage`s the target URL to any open same-origin tab (falling back to `openWindow`), and `App.tsx` adds a `/inbox/:inbox/:personId` route with a `NotificationClickListener` that calls `navigate(url)` on receipt.

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

[Unreleased]: https://github.com/choyiny/saasmail/compare/v0.4.2...HEAD
[0.4.2]: https://github.com/choyiny/saasmail/compare/v0.4.1...v0.4.2
[0.4.1]: https://github.com/choyiny/saasmail/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/choyiny/saasmail/compare/v0.3.3...v0.4.0
[0.3.3]: https://github.com/choyiny/saasmail/compare/v0.3.2...v0.3.3
[0.3.2]: https://github.com/choyiny/saasmail/compare/v0.3.1...v0.3.2
[0.3.1]: https://github.com/choyiny/saasmail/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/choyiny/saasmail/compare/v0.2.2...v0.3.0
[0.2.2]: https://github.com/choyiny/saasmail/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/choyiny/saasmail/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/choyiny/saasmail/compare/v0.1.2...v0.2.0
[0.1.2]: https://github.com/choyiny/saasmail/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/choyiny/saasmail/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/choyiny/saasmail/compare/v0.0.1...v0.1.0
[0.0.1]: https://github.com/choyiny/saasmail/releases/tag/v0.0.1
