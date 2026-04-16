# cmail Frontend Light-Theme Redesign

**Date:** 2026-04-16
**Status:** Design approved, ready for implementation planning

## Goal

Overhaul the cmail frontend with a modern light theme, replacing the existing
dark theme entirely. Inspired by a reference image of a Gmail-like agentic
inbox: clean white surfaces, a single blue accent, relaxed spacing, soft-modern
corners. No new features — retheme existing features and introduce a
collapsible sidebar.

## Scope

Full redesign across all frontend pages and components under `src/`. No
backend changes, no route changes, no state-management changes, no API
changes. Component APIs (button variants, prop names) are preserved.

## Non-goals

- No new feature surfaces (no folders, labels, filters, or navigation items
  beyond the current set).
- No dark-mode support — it is scrapped, not replaced with a toggle.
- No mobile redesign — responsive behavior is preserved as-is; mobile polish
  is out of scope for this pass.
- No backend/API/schema/test-structure changes.

## Design Tokens (`src/index.css`)

Replace the existing `@theme` block. Remove dark `body` background.

### Surfaces

| Token               | Value     | Usage                                      |
| ------------------- | --------- | ------------------------------------------ |
| `--color-bg`        | `#ffffff` | main background (inbox pane, detail pane)  |
| `--color-bg-subtle` | `#f9fafb` | sidebar, rails, table headers              |
| `--color-bg-muted`  | `#f3f4f6` | hover on list rows, menu items             |
| `--color-bg-panel`  | `#ffffff` | cards (paired with `ring-1 ring-gray-200`) |

### Borders

| Token                   | Value     | Usage                              |
| ----------------------- | --------- | ---------------------------------- |
| `--color-border`        | `#e5e7eb` | default dividers                   |
| `--color-border-subtle` | `#f1f5f9` | whisper dividers between list rows |

### Text

| Token                    | Value                 | Usage               |
| ------------------------ | --------------------- | ------------------- |
| `--color-text-primary`   | `#0f172a` (slate-900) | headings, body      |
| `--color-text-secondary` | `#475569` (slate-600) | meta text           |
| `--color-text-tertiary`  | `#94a3b8` (slate-400) | placeholders, icons |

### Accent (single blue system)

| Token                      | Value                     | Usage                                  |
| -------------------------- | ------------------------- | -------------------------------------- |
| `--color-accent`           | `#2563eb` (blue-600)      | primary CTA, unread dot, send, Compose |
| `--color-accent-hover`     | `#1d4ed8` (blue-700)      | hover                                  |
| `--color-accent-subtle`    | `#eff6ff` (blue-50)       | selected row bg, tag bg                |
| `--color-accent-subtle-fg` | `#1d4ed8`                 | text on accent-subtle                  |
| `--color-ring`             | `rgba(37, 99, 235, 0.25)` | focus ring                             |

### Semantic

| Token                        | Value     |
| ---------------------------- | --------- |
| `--color-destructive`        | `#dc2626` |
| `--color-destructive-subtle` | `#fee2e2` |
| `--color-success`            | `#16a34a` |
| `--color-warning-bg`         | `#fffbeb` |
| `--color-warning-border`     | `#fde68a` |
| `--color-warning-text`       | `#b45309` |

### Typography

- Base: `14px` (up from 13px)
- Stack: `-apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", Helvetica, Arial, sans-serif`
- `font-feature-settings: 'cv11', 'ss01'` for Inter-like clarity on modern
  system fonts (no webfont payload)

### Radii & shadows

| Token         | Value  | Usage                  |
| ------------- | ------ | ---------------------- |
| `--radius-sm` | `6px`  | badges                 |
| `--radius-md` | `8px`  | buttons, inputs        |
| `--radius-lg` | `12px` | cards, panels, dialogs |

- `shadow-sm` for cards
- `shadow-md` for dropdowns and modal content
- `ring-1 ring-gray-200` as a whisper border alternative to hard borders

## Component Primitives (`src/components/ui/*`)

Rewrite variants against new tokens. **No API changes.**

### `button.tsx`

- `default` (primary): `bg-accent text-white hover:bg-accent-hover`, 8px radius, `shadow-sm`
- `secondary`: `bg-white text-text-primary ring-1 ring-gray-200 hover:bg-bg-muted`
- `ghost`: `text-text-secondary hover:bg-bg-muted hover:text-text-primary`
- `outline`: `ring-1 ring-gray-200 hover:bg-bg-muted`
- `destructive`: `bg-destructive text-white hover:bg-red-700`
- Sizes: `sm` 28px, `default` 32px, `lg` 40px. Icon buttons square.

### `input.tsx` / `textarea.tsx`

- `bg-white ring-1 ring-gray-200 rounded-md px-3 py-2`
- Focus: `ring-2 ring-accent/25`
- Placeholder: `text-text-tertiary`

### `card.tsx`

- `bg-white ring-1 ring-gray-200 rounded-xl shadow-sm` with `p-5` default
- Header/footer: `border-t border-border-subtle`

### `dialog.tsx`

- Overlay: `bg-slate-900/40 backdrop-blur-sm`
- Content: `bg-white rounded-xl shadow-lg ring-1 ring-gray-200 p-6`

### `dropdown-menu.tsx`

- Content: `bg-white rounded-lg shadow-md ring-1 ring-gray-200 p-1`
- Items: `rounded-md px-2 py-1.5 hover:bg-bg-muted`
- Separator: `bg-border-subtle`

### `badge.tsx`

- `default`: `bg-accent-subtle text-accent-subtle-fg` (count chips)
- `secondary`: `bg-bg-muted text-text-secondary`
- `destructive`, `success`, `warning` in subtle variants

### `avatar.tsx`

- Background tinted with a deterministic hue from initials (hash-based)
- Text white
- Fallback: `bg-accent` with white letters

### `scroll-area.tsx` / `separator.tsx` / `label.tsx`

- Thumb: `bg-slate-300 hover:bg-slate-400`
- Separator: `bg-border`
- Label (when used for section headers): `text-text-secondary text-xs font-medium uppercase tracking-wide`

## Layout Shell

### `DashboardLayout.tsx`

- Body: `bg-bg` (white) — replaces `bg-main`.
- `<body>` background in `index.css` also swapped.
- Structure unchanged: `flex h-screen` with Sidebar + `<Outlet />` + ComposeModal.

### `Sidebar.tsx` — collapsible

Two states:

- **Expanded** (default, 224px): icons + labels.
- **Collapsed** (64px): icon-only rail (current look, rethemed).

Toggle via chevron button in footer. Preference persisted in
`localStorage["cmail:sidebar-collapsed"]` via `src/lib/useSidebarCollapsed.ts`
(new hook — only structural addition).

Width animates: `transition-[width] duration-150`.

Structure top → bottom:

1. **Header**
   - Expanded: `[logo letter] [app name]` row, `px-3 py-3`. Name from `useBranding().name`.
   - Collapsed: logo letter centered.
2. **Nav items** (preserved: Inbox, Templates, Sequences, API, Inboxes*, Users*)
   - Expanded row: `flex items-center gap-3 px-3 h-9 rounded-md` with 16px icon + label.
     - Active: `bg-accent-subtle text-accent-subtle-fg`.
     - Hover: `bg-bg-muted text-text-primary`.
     - Idle: `text-text-secondary`.
   - Collapsed: 40×40 centered icon button with same active/hover treatment, Radix tooltip with label.
3. **Compose button** (primary CTA, above footer)
   - Expanded: full-width `Button variant="default"` with `<PenSquare />` + "Compose", `h-10 rounded-lg`, blue.
   - Collapsed: 40×40 icon button with `bg-accent text-white`, tooltip "Compose".
4. **Footer** (`border-t border-border-subtle`)
   - Account chip: avatar + (expanded: name/email stack) + chevron → existing dropdown with sign out.
   - Collapse toggle: ghost icon button.

Active-route logic unchanged. Admin gating unchanged
(`session?.user?.role === "admin"`).

On `<md` breakpoints, sidebar stays collapsed. No off-canvas drawer — mobile is out of scope.

## Inbox Panes

### `InboxPage.tsx`

- Outer: `bg-bg`.
- PersonList pane: `bg-bg-subtle` + `border-r border-border`.
- PersonDetail pane: `bg-white`.
- ThreadSidebar (when open): `bg-bg-subtle` + `border-l border-border`.
- Empty-state ("No inboxes assigned"): centered card `bg-white ring-1 ring-gray-200 rounded-xl p-8 max-w-sm` with muted icon above heading.
- "Select a person" placeholder: centered `text-text-tertiary` with faint `Mail` icon above.

### `PersonList.tsx`

- Container: `divide-y divide-border-subtle`.
- Row: `flex items-start gap-3 px-4 py-3 cursor-pointer`.
  - Hover: `bg-bg-muted`.
  - Selected: `bg-accent-subtle` + 3px `border-l border-accent`.
- Left: star toggle (`Star` lucide 14px). Filled = `text-amber-400`; empty = `text-text-tertiary`, hover-revealed.
- Middle (flex-1, min-w-0):
  - Row 1: `[name] [count-badge]` left, `[timestamp]` right.
    - Name unread: `text-sm font-semibold text-text-primary`.
    - Name read: `text-sm text-text-secondary`.
    - Badge: `bg-accent-subtle text-accent-subtle-fg rounded-full px-1.5 text-xs`.
  - Row 2: subject/preview `text-sm text-text-secondary truncate`.
    - Unread: `font-medium text-text-primary`.
- Unread dot: 8px `bg-accent` absolute at `left-1.5 top-4`, only when unread.
- Header: search input `bg-white ring-1 ring-gray-200 rounded-lg h-9 pl-9` with inline search icon. Existing right-side controls preserved as ghost icon buttons.
- Pagination footer: "Showing X-Y of Z" + prev/next as ghost icon buttons.
- Loading skeleton: `bg-bg-muted` pulsing rows.

### `PersonDetail.tsx`

- Header bar (reply/forward/star/more): `border-b border-border` + ghost icon buttons. Tokens only — no restructuring.
- Subject: `text-lg font-semibold text-text-primary`. Meta: `text-text-secondary`.
- Message bubbles (via `MessageBubble`): `bg-white ring-1 ring-gray-200 rounded-xl`. Draft bubbles: `bg-amber-50 ring-amber-100` with "Draft" badge.
- Inline reply composer: `ring-1 ring-border rounded-xl bg-white` wrapping TiptapEditor. Send = blue primary; Edit = secondary; Discard = ghost.
- Collapsed quoted replies: click-to-expand chevron in `text-text-tertiary`.

### `ThreadSidebar.tsx`

- Retheme: `bg-bg-subtle border-l border-border`.
- "Thread" label: `text-text-secondary text-xs font-medium uppercase tracking-wide`.
- Close button: ghost icon.
- Dividers: `divide-border-subtle`.

## Composers & Editors

### `ComposeModal.tsx`

- Dialog surface: `bg-white rounded-xl shadow-lg ring-1 ring-gray-200 p-0`.
- Header: `border-b border-border px-5 py-3` with "New message" + close icon.
- From/To/Subject rows: light inputs (`ring-1 ring-gray-200`), inline labels in `text-text-secondary`.
- Body: TiptapEditor with new light `.notion-editor` styling.
- Footer: `border-t border-border px-5 py-3`. Blue "Send" primary left, ghost "Discard" right, preserved attachment/template ghost icon buttons.

### `ReplyComposer.tsx`

- Surface: `bg-white ring-1 ring-gray-200 rounded-xl`.
- Toolbar divider retheme; Send = blue primary. Existing edit/discard/send affordances preserved.

### `TiptapEditor.tsx` + `.notion-editor` CSS

Rewrite the `.notion-editor` rules in `index.css`:

- Background: transparent (inherits from surface).
- Text: `var(--color-text-primary)`.
- Block hover: `rgba(15, 23, 42, 0.03)`.
- Blockquote: border `var(--color-accent)`, text `var(--color-text-secondary)`.
- Code blocks: `bg-slate-50 ring-1 ring-slate-200` (replaces `bg-sidebar`).
- Inline code: `bg-slate-100 text-rose-600`.
- Toolbar: `bg-white border-b border-border`, icon buttons in ghost styling.
- Drag handle: idle `text-text-tertiary` opacity 0.4; hover `bg-bg-muted text-text-secondary`; active `bg-accent text-white`. Behavior preserved.
- Drop indicator: `bg-accent` with `box-shadow: 0 0 4px rgba(37, 99, 235, 0.35)`.
- Placeholder: `text-text-tertiary`.

### `HtmlCodeEditor.tsx`

- Replace `@codemirror/theme-one-dark` with a light theme.
- Use CodeMirror's default light theme + a small custom `EditorView.theme({...})` for alignment:
  - Background `#ffffff`, gutter `#f9fafb`, active line `#f3f4f6`, cursor `var(--color-accent)`.
- HTML syntax highlighting unchanged (`@codemirror/lang-html`).

### `EmailHtmlModal.tsx`

- Dialog surface light. Preview iframe unchanged.

### `EnrollSequenceModal.tsx`

- Dialog light. Form rows use new primitives. Primary action blue.

## Auxiliary Pages

### Shared page-chrome pattern

For standalone pages (Templates, Sequences, API Keys, Inboxes, Users, Persons):

- `bg-white` page with `px-6 py-5` top section.
- Title: `text-xl font-semibold text-text-primary`.
- Subtitle: `text-sm text-text-secondary mt-1`.
- Primary action (right-aligned): blue button where applicable.
- Separator (`border-b border-border`) below header.
- Content in cards (`bg-white ring-1 ring-gray-200 rounded-xl`) or tables.

### Shared table pattern

Used by API keys, users, admin inboxes, sequence detail:

- Wrapper: `bg-white ring-1 ring-gray-200 rounded-xl overflow-hidden`.
- Header row: `bg-bg-subtle text-text-secondary text-xs font-medium uppercase tracking-wide` + `px-4 py-2.5`.
- Body rows: `border-t border-border-subtle` + `hover:bg-bg-muted`.
- Row actions: ghost icon buttons revealed on hover.
- Empty row: centered `text-text-tertiary` with muted icon + "No X yet" + subtle CTA.

### Per-page notes

- **TemplatesPage / TemplateEditorPage**: grid of template cards with title, preview, last-edited meta, hover-revealed edit/delete ghost icons. Editor retheme only; HTML editor uses the new light CodeMirror theme.
- **SequencesPage / SequenceEditorPage / SequenceDetailPage / SequenceStatus**: sequence cards with status pills (`Active` = green-subtle, `Paused` = amber-subtle, `Draft` = gray-subtle). Step builder retheme; add-step = dashed-border ghost.
- **ApiKeysPage**: table + blue "New API key" primary. Reveal-once modal with copy-to-clipboard secondary button.
- **InboxesPage / AdminInboxTable**: table with assignment chips `bg-accent-subtle text-accent-subtle-fg`. Empty-state card with muted `Mail` icon.
- **AdminUsersPage**: user table (avatar + name + email + role + actions). Role pill = subtle variant. Invite = blue primary.
- **LoginPage**: centered card on `bg-bg-subtle` with logo letter + app name + sign-in form. Blue primary. Existing passkey/email flow preserved.
- **OnboardingPage**: light card-based step flow with blue "Continue" and ghost "Back". Step structure preserved.
- **InviteAcceptPage / SetupPasskeyPage**: centered light cards, blue primary actions. Flows preserved.

## Implementation Strategy

Phased rollout (each phase leaves the app visually coherent):

1. **Tokens & base CSS** — rewrite `src/index.css` `@theme`, swap base font size to 14px, update `<body>` background, rewrite `.notion-editor` and `.drag-handle` styles.
2. **UI primitives** — `src/components/ui/*.tsx` variants updated.
3. **Layout shell** — rewrite `Sidebar.tsx` with collapsible behavior, add `useSidebarCollapsed` hook, retheme `DashboardLayout.tsx`.
4. **Inbox surfaces** — `PersonList`, `PersonDetail`, `ThreadSidebar`, `MessageBubble`, `ReplyComposer`.
5. **Composers & editors** — `ComposeModal`, TiptapEditor styles (from phase 1), swap CodeMirror theme in `HtmlCodeEditor.tsx`, retheme `EmailHtmlModal`, `EnrollSequenceModal`.
6. **Auxiliary pages** — Templates, Sequences (3 pages + `SequenceStatus`), ApiKeys, Inboxes (+ `AdminInboxTable`), AdminUsers, Login, Onboarding, InviteAccept, SetupPasskey.
7. **Final QA pass** — smoke-test each page, fix leaked dark-mode tokens.

## Verification

Per phase:

- `yarn tsc --noEmit` passes.
- `yarn test` passes (current suite covers backend + some UI behavior; this pass changes styling only).
- Visual smoke test in browser: each page loaded + empty states.

After phase 6:

- `rg "bg-sidebar|bg-panel|bg-main|bg-card|bg-hover|border-border-dark"` returns 0 matches in `src/`.
- Grep for `theme-one-dark` returns 0 matches.

## Files Touched

### Rewrites

- `src/index.css` — token block, body background, `.notion-editor`, `.drag-handle`.
- `src/components/Sidebar.tsx` — collapsible restructure.

### Token/class swaps

- `src/components/ui/*.tsx` (11 files)
- `src/components/DashboardLayout.tsx`
- `src/components/ThreadSidebar.tsx`
- `src/components/MessageBubble.tsx`
- `src/components/ReplyComposer.tsx`
- `src/components/TiptapEditor.tsx`
- `src/components/HtmlCodeEditor.tsx` (plus CodeMirror theme swap)
- `src/components/EmailHtmlModal.tsx`
- `src/components/EnrollSequenceModal.tsx`
- `src/components/AdminInboxTable.tsx`
- `src/components/SequenceStatus.tsx`
- `src/pages/InboxPage.tsx`
- `src/pages/PersonList.tsx`
- `src/pages/PersonDetail.tsx`
- `src/pages/ComposeModal.tsx`
- `src/pages/TemplatesPage.tsx`
- `src/pages/TemplateEditorPage.tsx`
- `src/pages/SequencesPage.tsx`
- `src/pages/SequenceEditorPage.tsx`
- `src/pages/SequenceDetailPage.tsx`
- `src/pages/ApiKeysPage.tsx`
- `src/pages/InboxesPage.tsx`
- `src/pages/AdminUsersPage.tsx`
- `src/pages/LoginPage.tsx`
- `src/pages/OnboardingPage.tsx`
- `src/pages/InviteAcceptPage.tsx`
- `src/pages/SetupPasskeyPage.tsx`

### New

- `src/lib/useSidebarCollapsed.ts` — persisted boolean hook.

## What's preserved

- All component APIs (variants, prop names, exports).
- All routes, state management, React Query keys.
- All Hono endpoints, DB schemas.
- Feature set — no new nav items, no folders/labels/filters.
- TipTap editor behaviors (drag-drop, toolbar actions, shortcuts).
- Responsive breakpoints (mobile polish out of scope).
- Admin gating logic.
