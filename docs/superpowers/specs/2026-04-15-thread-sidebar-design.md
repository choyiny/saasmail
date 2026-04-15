# Thread Sidebar Layout Design

## Summary

Replace the flat chronological email list in SenderDetail with a Slack-inspired thread layout: the most recent email displays prominently in the main area, and clicking it opens a right sidebar showing the full historical thread.

## Current State

`SenderDetail` renders all emails from a sender in a single scrollable list (oldest first), using `MessageBubble` for each email. There is no concept of a "primary" email vs. thread history.

## Design

### Layout States

**Collapsed (default):** The most recent email is displayed full-width in the main content area. It shows subject, full body, attachments, and action buttons (View HTML, Reply, Delete). A thread indicator (e.g., "4 previous emails") is visible if there are older emails.

**Expanded:** Clicking the thread indicator opens a right sidebar panel. The main area shrinks (roughly 60/40 split) to accommodate the sidebar. The sidebar shows all previous emails in chronological order (oldest first) as compact items.

### Components

#### SenderDetail (modified)

- Fetches emails as before, but separates the latest email from the rest.
- Manages `threadOpen: boolean` state.
- Renders:
  - Main area: latest email using a new `MainEmail` presentation (full body, not truncated).
  - Thread sidebar: conditionally rendered `ThreadSidebar` with the remaining emails.
  - Reply composer: anchored to bottom of main area (unchanged).

#### MainEmail (new component or mode of MessageBubble)

- Displays the most recent email prominently:
  - Sender/recipient header
  - Subject
  - Full body text (no truncation by default, but "Show more" still available for very long emails)
  - Attachments
  - Action buttons (View HTML, Reply, Delete)
- Thread indicator button: shows count of older emails, e.g., "5 earlier messages". Clicking toggles sidebar.

#### ThreadSidebar (new component)

- Right sidebar panel with its own scroll area.
- Header: "Thread" title + close button (X).
- Lists older emails chronologically (oldest first) using compact `MessageBubble` instances.
- Each message in the sidebar retains: sender line, timestamp, subject (if different from latest), truncated body, action buttons on hover.
- Clicking "View" or "Reply" on a sidebar message works the same as today.

### Responsive Behavior

- On desktop (md+): sidebar appears as a side panel, splitting the detail area ~60/40.
- On mobile: sidebar could overlay as a slide-in panel from the right, or stack below the main email. Recommend overlay for now to keep it simple.

### Visual Design

- Sidebar background: `bg-panel` (matches sender list panel).
- Sidebar border: `border-l border-border-dark`.
- Thread indicator button: subtle, text-only style with accent color, e.g., `text-accent text-xs`.
- Smooth transition when sidebar opens/closes (CSS transition on width or transform).

### Data Flow

No API changes needed. The existing `fetchSenderEmails` returns all emails for a sender. The frontend simply splits the array:

- `latestEmail = emails[0]` (API returns newest first)
- `threadEmails = emails.slice(1)` (the rest, reversed for chronological display in sidebar)

### Files to Modify

1. **`src/pages/SenderDetail.tsx`** - Split email list into main email + thread sidebar layout.
2. **`src/components/MessageBubble.tsx`** - May need a `compact` prop or variant for sidebar display, or create a separate `ThreadSidebar` component that renders compact messages.
3. **New: `src/components/ThreadSidebar.tsx`** - The sidebar panel component.

### Edge Cases

- **Single email from sender:** No thread indicator shown. Full-width main email only.
- **All emails are sent (no received):** Latest sent email is the main email. Thread works the same.
- **Recipient filter active:** Thread only shows filtered emails. Latest of the filtered set is the main email.
- **Reply composer open:** Composer stays at the bottom of the main area regardless of sidebar state.
