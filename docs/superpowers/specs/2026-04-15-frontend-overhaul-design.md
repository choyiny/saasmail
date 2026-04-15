# Frontend Overhaul — Dark Theme & Shared Layout

## Overview

Redesign the cmail frontend with a dark, blue-tinted color scheme, compact density, and a persistent icon sidebar for navigation. Replace the current per-page headers/nav with a unified three-column layout: icon sidebar | contextual middle panel | main content area.

## Layout Architecture

A `<DashboardLayout>` component wraps all authenticated routes, rendering three columns:

- **Icon sidebar** (64px, `#0f1117`): Always visible. Top: page nav icons (Inbox, Templates, API, Admin). Bottom: Compose button, user avatar/menu.
- **Middle panel** (320px, `#141720`): Context-dependent. Inbox: sender list. Templates: template list. API Keys / Admin: not used — content spans middle + right.
- **Right panel** (flex-1, `#1a1d2e`): Main content area.

`App.tsx` restructured: all authenticated routes become children of a `<DashboardLayout>` layout route, replacing per-page `<AuthGuard>` wrappers. Unauthenticated pages (login, onboarding, invite, passkey setup) render outside the layout.

## Icon Sidebar

Fixed-width column with icon buttons and tooltips on hover.

**Navigation items (top):**

| Icon     | Tooltip   | Route          | Condition  |
| -------- | --------- | -------------- | ---------- |
| Mail     | Inbox     | `/`            | Always     |
| FileText | Templates | `/templates`   | Always     |
| Key      | API       | `/api-keys`    | Always     |
| Users    | Users     | `/admin/users` | Admin only |

**Action items (bottom):**

| Icon   | Tooltip    | Action                            |
| ------ | ---------- | --------------------------------- |
| Pen    | Compose    | Opens compose modal               |
| Avatar | User email | Dropdown: email display, sign out |

Active icon: `#2a2d3e` background, white icon color. Inactive: `#6b7280` icon color. Icons from lucide-react, 20px. Sidebar items are 48px square buttons centered in the 64px rail.

## Dark Theme Color System

CSS custom properties in `index.css`:

| Token              | Value     | Usage                                 |
| ------------------ | --------- | ------------------------------------- |
| `--bg-sidebar`     | `#0f1117` | Icon sidebar                          |
| `--bg-panel`       | `#141720` | Middle panel                          |
| `--bg-main`        | `#1a1d2e` | Right panel / main content            |
| `--bg-hover`       | `#2a2d3e` | Hover states, active sidebar icon     |
| `--bg-card`        | `#1e2235` | Cards, elevated surfaces              |
| `--bg-input`       | `#141720` | Input fields                          |
| `--border`         | `#2a2d3e` | Borders, dividers                     |
| `--text-primary`   | `#f0f0f0` | Primary text                          |
| `--text-secondary` | `#8b8fa3` | Secondary/muted text                  |
| `--text-tertiary`  | `#5a5e70` | Timestamps, metadata                  |
| `--accent`         | `#4f6ef7` | Active states, links, primary buttons |
| `--accent-hover`   | `#6180f9` | Accent hover                          |
| `--destructive`    | `#e5484d` | Delete/revoke actions                 |
| `--unread`         | `#4f6ef7` | Unread badges                         |

## Compact Typography

- Base font size: 13px
- Sender list items: 12-13px
- Email body: 14px
- Line heights: 1.3-1.4
- System font stack (existing)

## Page-by-Page Layout

### Inbox (three columns)

- Middle panel: search input at top, recipient filter, sender list. Sender rows: name, unread dot, timestamp, subject preview. Selected sender: `--bg-hover` background.
- Right panel: sender header (name, email, count), scrollable email thread. Each email: collapsed row or expanded view with HTML body, attachments.

### Templates (three columns)

- Middle panel: template list with "New" button at top. Each row: template name, slug, subject preview.
- Right panel: template editor (slug, name, subject, Tiptap body). No selection: empty state.

### API Keys (single content area)

- No middle panel — content spans both columns.
- Same functionality as current page, restyled for dark theme.

### Admin Users (single content area)

- No middle panel — content spans both columns.
- Users list and invitations as dark-themed cards/tables.

### Unauthenticated pages (login, onboarding, passkey setup, invite accept)

- Render outside `DashboardLayout` (no sidebar).
- Centered card on dark `--bg-main` background.

## File Structure

### New files

- `src/components/DashboardLayout.tsx` — three-column layout wrapper with sidebar, middle panel slot, content area
- `src/components/Sidebar.tsx` — icon sidebar with nav items, compose trigger, user menu
- `src/components/SidebarItem.tsx` — single icon button with tooltip and active state

### Modified files

- `src/index.css` — dark theme CSS custom properties
- `src/App.tsx` — nested route structure with `DashboardLayout` as layout route
- `src/pages/InboxPage.tsx` — strip header/nav, render sender list in middle panel slot and email detail in content area
- `src/pages/TemplatesPage.tsx` — strip back link/header, adapt to middle panel + content area split
- `src/pages/TemplateEditorPage.tsx` — restyle for dark theme
- `src/pages/ApiKeysPage.tsx` — strip back link, restyle for dark theme
- `src/pages/AdminUsersPage.tsx` — strip header/nav, restyle for dark theme
- `src/pages/SenderList.tsx` — dark theme styling, compact density
- `src/pages/SenderDetail.tsx` — dark theme styling, compact density
- `src/pages/ComposeModal.tsx` — dark theme dialog styling
- `src/pages/LoginPage.tsx` — dark theme standalone
- `src/pages/OnboardingPage.tsx` — dark theme standalone
- `src/pages/SetupPasskeyPage.tsx` — dark theme standalone
- `src/pages/InviteAcceptPage.tsx` — dark theme standalone
- `src/components/ui/*.tsx` — update all component variants to use dark theme tokens
- `src/components/TiptapEditor.tsx` — dark theme styling

### No new dependencies

Everything uses existing Tailwind, Radix, and lucide-react.
