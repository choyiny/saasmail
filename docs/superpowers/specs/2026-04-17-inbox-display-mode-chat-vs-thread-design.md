# Inbox Display Mode: Chat vs Thread

**Date:** 2026-04-17
**Status:** Draft — pending user review

## Problem

The person-detail view in the inbox always renders email as a thread: each per-inbox section shows the latest message expanded as sanitized HTML with older messages collapsed behind a toggle, and a Slack-style `ReplyComposer` opens on demand. This works for traditional email threads but feels heavy for short, chatty back-and-forths that some teams use specific inboxes for (e.g., a `support@` inbox used like an SMS line).

We want to give admins a per-inbox display mode that, when set to `chat`, renders that inbox's messages in an iMessage-style bubble layout with an always-visible plain-text quick reply, while `thread` mode preserves the existing behavior exactly.

## Goals

- Admins can set a `displayMode` of `thread` (default) or `chat` per inbox, alongside the existing display name.
- In `chat` mode, the inbox's messages in `PersonDetail` render as chronological chat bubbles (received left, sent right), text-only.
- The 5 most recent bubbles are shown by default; older bubbles are loaded on demand via a "Show earlier messages" control.
- An always-visible plain-text quick reply (auto-growing textarea + Send button) is pinned to the bottom of each chat-mode section.
- Bubbles whose source is HTML expose a "View original" link that opens the existing `EmailHtmlModal` for full fidelity.
- Attachments remain accessible from each bubble as a chip row.
- A person with email across multiple inboxes can see mixed modes simultaneously — each per-inbox section renders in its own mode.

## Non-goals

- Per-user display-mode preferences. The mode is admin-set on the inbox.
- A live toggle in the inbox view to switch modes ad hoc.
- Sidebar / `PersonList` changes — the sidebar is unchanged.
- Read receipts, typing indicators, or any iMessage-like presence semantics.
- Affecting `ComposeModal`, sequences, templates, or any other surface outside `PersonDetail`.
- Real-time updates when an admin changes the mode while a member is viewing — the next refetch picks it up.

## Data Model

### Modified table `sender_identities`

Add `display_mode` and make `display_name` nullable so a row can persist when the only setting is the mode.

```ts
{
  email:       text PRIMARY KEY,
  displayName: text,                                              // now nullable
  displayMode: text NOT NULL DEFAULT 'thread'                     // new
                CHECK (display_mode IN ('thread', 'chat')),
  createdAt:   integer NOT NULL,
  updatedAt:   integer NOT NULL,
}
```

A row exists when _either_ `displayName` is set or `displayMode != 'thread'`. When both are at defaults (`null` and `'thread'`), the row is deleted so the table stays sparse.

The Drizzle enum `text("display_mode", { enum: ["thread", "chat"] })` provides type-level safety; the SQL `CHECK` constraint enforces it at rest.

### Migration

`yarn db:generate` produces:

1. `ALTER TABLE sender_identities ADD COLUMN display_mode TEXT NOT NULL DEFAULT 'thread';`
2. SQLite cannot drop `NOT NULL` in place, so Drizzle emits the standard table-rebuild dance for `display_name` (create new table → copy → drop → rename).

## API Surface

All changes are in `worker/src/routers/admin-inboxes-router.ts` and `worker/src/routers/people-router.ts` (or wherever `GET /people/{id}/emails` lives).

### `GET /admin/inboxes`

Response row gains `displayMode`:

```ts
const InboxRowSchema = z.object({
  email: z.string(),
  displayName: z.string().nullable(),
  displayMode: z.enum(["thread", "chat"]),
  assignedUserIds: z.array(z.string()),
});
```

The `WITH universe` query selects `s.display_mode AS displayMode`. Inboxes with no `sender_identities` row default to `"thread"` in the mapping (`r.displayMode ?? "thread"`).

### `PATCH /admin/inboxes/{email}`

Body becomes a partial update — at least one field required:

```ts
body: z.object({
  displayName: z.string().nullable().optional(),
  displayMode: z.enum(["thread", "chat"]).optional(),
}).refine(
  (b) => b.displayName !== undefined || b.displayMode !== undefined,
  "must update at least one field",
);
```

Handler:

1. Load the current row (if any).
2. Compute `nextDisplayName` (use provided value, else current, else `null`) and `nextDisplayMode` (provided, else current, else `"thread"`).
3. If `nextDisplayName === null && nextDisplayMode === "thread"`, `DELETE` the row.
4. Otherwise `INSERT … ON CONFLICT (email) DO UPDATE SET display_name = ?, display_mode = ?, updated_at = ?`.
5. Return `{ email, displayName, displayMode }`.

### `GET /people/{id}/emails`

Response shape changes from `Email[]` to:

```ts
{
  emails: Email[],
  inboxes: Array<{ email: string, displayName: string | null, displayMode: "thread" | "chat" }>,
}
```

`inboxes` covers exactly the inbox addresses present across the returned emails (`recipient` for received, `fromAddress` for sent), each annotated with its current admin-set settings. Unknown inboxes default to `"thread"`.

This avoids exposing `/admin/inboxes` to non-admin members and keeps the per-email payload small (no repeated `displayMode` per row).

## Frontend

### `src/lib/api.ts`

- Add `displayMode: "thread" | "chat"` to the `AdminInbox` type.
- Replace `updateInboxDisplayName(email, displayName)` with `updateInboxSettings(email, partial: { displayName?: string | null; displayMode?: "thread" | "chat" })` matching the new PATCH contract. Update existing call sites.
- Update `fetchPersonEmails(personId)` return type to `{ emails: Email[]; inboxes: InboxMeta[] }`.

### `src/components/AdminInboxTable.tsx`

Each per-inbox card gains a segmented control next to the display-name input:

```
Display name:  [ ___________ ]
Mode:          [ Thread | Chat ]
```

- Default is Thread. Active button is filled with the accent color; inactive is muted.
- Clicking the inactive button calls `updateInboxSettings(email, { displayMode: next })` with optimistic update and rollback on error (mirrors the existing assignment-toggle pattern).
- Helper text under the control: _"Chat mode shows the last 5 messages as bubbles with an inline reply."_

### `src/pages/PersonDetail.tsx`

State plumbing:

- `fetchPersonEmails` now returns `{ emails, inboxes }`. Build `inboxModeMap = new Map<string, "thread" | "chat">` from `inboxes`, defaulting to `"thread"` for any inbox not present.
- `inboxGroups.map((group) => …)` becomes:

  ```tsx
  const mode = inboxModeMap.get(group.inbox) ?? "thread";
  return mode === "chat"
    ? <ChatInboxSection group={group} … />
    : <ThreadInboxSection group={group} … />;
  ```

- The existing per-section JSX (sticky header + collapsed-older + latest expanded) is extracted into `ThreadInboxSection` with no functional change.
- The page-level `ReplyComposer` is only triggered by Thread sections (Chat sections have their own quick reply).

### New component: `src/components/ChatInboxSection.tsx`

Layout:

```
┌─ sticky header: 📥 support@example.com · 12 emails ──┐
│  [ Show 7 earlier messages ]              ← only if >5│
│                                                       │
│   ┌───────────────────────┐                           │
│   │ Hey, can you check…   │  ← incoming (left, gray)  │
│   └───────────────────────┘                           │
│   Sat 2:14 PM                                         │
│                                                       │
│                       ┌───────────────────────┐       │
│                       │ Yes — looking now.    │  sent │
│                       └───────────────────────┘       │
│                       Sat 2:16 PM                     │
│   …                                                   │
│                                                       │
├──────────────────────────────────────────────────────┤
│  [ ChatQuickReply textarea ]                  [Send] │
└──────────────────────────────────────────────────────┘
```

Bubble rules:

- Chronological order, newest at bottom (matches the page's existing auto-scroll-to-bottom behavior).
- `received` → left-aligned, neutral background (`bg-bg-muted`).
- `sent` → right-aligned, accent background (`bg-accent text-white`).
- Body: `email.bodyText` if present, else `DOMParser` strip of `bodyHtml` (same path `MessageBubble` uses today).
- Long messages: clamp to ~6 lines with a per-bubble "Show more" inline expand (local state in the bubble component).
- Timestamp shown small under each bubble.
- Subject: omitted in bubbles; surfaced as a `title` tooltip on the bubble for context.
- Attachments (excluding inline `contentId` ones): chip row under the bubble (filename + paperclip), reusing the styling pattern from `MessageBubble`.
- "View original" link bottom-right of any bubble whose source was HTML — opens existing `EmailHtmlModal`.
- Unread received messages: small accent dot until clicked, click to mark read (same handler as today).
- Delete: hover-revealed trash icon on the bubble, same handler as today.

Pagination:

- Local state `visibleCount`, initial `5`. "Show N earlier messages" button increments by 20. Hidden when all loaded.

### New component: `src/components/ChatQuickReply.tsx`

```ts
interface ChatQuickReplyProps {
  inboxAddress: string; // From address — fixed to this section's inbox
  latestReceivedEmailId: string | null; // what we reply to
  personEmail: string;
  onSent: () => void; // refetch + scroll-to-bottom
}
```

- Auto-growing `<textarea>` (1 line min, ~6 line max, then scrolls). Plain text.
- `Send` button right-aligned, disabled while empty or in flight.
- `Enter` inserts a newline. `Cmd/Ctrl+Enter` sends.
- Muted hint line: _"Replies in chat mode are sent as plain text from `support@example.com`."_
- No template tab, no From picker, no Tiptap.
- Send path: the existing reply route (`POST /send/reply/{emailId}` in `worker/src/routers/send-router.ts`) requires `bodyHtml` or `templateSlug` and returns 400 otherwise. Rather than relax the backend, the quick reply wraps the plain text on the client into minimal HTML — `<p>` per non-empty line, empty lines become `<p>&nbsp;</p>`, with all text HTML-escaped — and sends both: `replyToEmail(latestReceivedEmailId, { bodyHtml: wrapped, bodyText: raw, fromAddress: inboxAddress })`. The wrapping helper is colocated with `ChatQuickReply`.
- On success: clear textarea, call `onSent()`. On error: inline red message under the textarea, content preserved.
- If `latestReceivedEmailId === null` (no received messages yet in this section): disable Send with hint _"Waiting for a message to reply to."_ — composing a new outbound email is out of scope here.

## Edge Cases & Decisions

- **Default for unknown inboxes.** `inboxModeMap.get(x) ?? "thread"` everywhere (DB, API, frontend).
- **Mixed-mode person view.** A person spanning two inboxes (one Chat, one Thread) sees two sections, each in its own mode, each with its own controls. No global toggle.
- **Mode change while viewing.** Not synced live. Next refetch picks it up. Acceptable — admin mode changes are rare.
- **Permissions.** No new permission surface. `displayMode` is admin-set via the existing admin-only PATCH route. Members read it via the new `inboxes` field on `GET /people/{id}/emails`, which they already have access to.
- **Sidebar / `PersonList`.** Unchanged.
- **Sequences, templates, compose modal.** Unchanged.
- **HTML emails with images / signatures.** Stripped to text in the bubble. "View original" opens `EmailHtmlModal`.
- **Auto-scroll.** `PersonDetail` already scrolls to bottom on emails change; remains correct because chat bubbles are chronological-newest-at-bottom.
- **Empty section.** A `ChatInboxSection` is only constructed from a non-empty inbox group, so the empty state is unreachable in practice; render a graceful empty placeholder if it ever happens.

## Testing

### Backend

`worker/src/__tests__/admin-inboxes-router.test.ts`:

- `PATCH /admin/inboxes/{email}` accepts `displayMode`, persists it, returns it.
- PATCH with both fields, with only one, with `displayName: null` + `displayMode: "chat"` — row stays.
- PATCH with `displayName: null` + `displayMode: "thread"` — row deleted.
- PATCH with empty body — 400 (per the `refine`).
- `GET /admin/inboxes` returns `displayMode` (defaulting to `"thread"` for inboxes without a row).

`worker/src/__tests__/` (people / emails router):

- `GET /people/{id}/emails` returns `{ emails, inboxes }` with correct `displayMode` for each inbox referenced by the returned emails.

### Frontend

The project's existing test footprint is small. Rely on:

- `yarn tsc --noEmit` — all new types compile.
- Manual QA via `yarn db:seed:dev`.

### Manual QA checklist

1. Set `support@` to Chat in admin UI; reload person detail; chat bubbles render.
2. Send a reply via the quick reply textarea; verify it appears as a sent bubble after refetch.
3. Bubble with HTML source shows "View original" → opens `EmailHtmlModal`.
4. Person spans two inboxes with different modes → both sections render correctly.
5. Inbox with > 5 messages → "Show earlier" reveals more.
6. Change mode back to Thread → existing thread layout returns.
7. Member (non-admin) cannot see the mode selector but sees correct rendering.
8. Empty quick reply / no received messages → Send disabled with appropriate hint.

## Files Touched

**Backend**

- `worker/src/db/sender-identities.schema.ts` — add `displayMode`, make `displayName` nullable
- `migrations/<new>.sql` — generated migration
- `worker/src/routers/admin-inboxes-router.ts` — extend GET and PATCH
- `worker/src/routers/people-router.ts` (or wherever `GET /people/{id}/emails` lives) — return `inboxes[]`
- `worker/src/__tests__/admin-inboxes-router.test.ts` — new cases
- `worker/src/__tests__/<people router test>` — new cases

**Frontend**

- `src/lib/api.ts` — types and client helpers
- `src/components/AdminInboxTable.tsx` — segmented mode control
- `src/pages/PersonDetail.tsx` — split rendering by mode, consume `inboxes[]`
- `src/components/ThreadInboxSection.tsx` — new (extracted from existing JSX)
- `src/components/ChatInboxSection.tsx` — new
- `src/components/ChatQuickReply.tsx` — new
