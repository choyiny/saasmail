# Thread Sidebar Layout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the flat email list in SenderDetail with a Slack-style thread layout — latest email prominent in the main area, historical thread in a right sidebar.

**Architecture:** Split SenderDetail's conversation area into two zones: a main email display (always visible) and a collapsible ThreadSidebar (toggled by a thread indicator button). No API changes needed — the frontend splits the existing `emails` array into `latestEmail` and `threadEmails`.

**Tech Stack:** React, Tailwind CSS, Radix ScrollArea, lucide-react icons

---

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `src/components/ThreadSidebar.tsx` | Create | Right sidebar panel: header with close button, scrollable list of older emails using MessageBubble |
| `src/pages/SenderDetail.tsx` | Modify | Split emails into latest + thread, manage `threadOpen` state, render two-column layout |
| `src/components/MessageBubble.tsx` | Modify | Add optional `compact` prop to reduce padding/hide some elements for sidebar use |

---

### Task 1: Add `compact` prop to MessageBubble

**Files:**
- Modify: `src/components/MessageBubble.tsx`

- [ ] **Step 1: Add `compact` prop to interface and component signature**

In `src/components/MessageBubble.tsx`, add `compact?: boolean` to the `MessageBubbleProps` interface and destructure it with a default of `false`:

```tsx
interface MessageBubbleProps {
  email: Email;
  senderEmail: string;
  onOpenHtml: (email: Email) => void;
  onMarkRead: (email: Email) => void;
  onReply: (emailId: string) => void;
  onDelete: (emailId: string) => void;
  compact?: boolean;
}
```

In the component signature:

```tsx
export default function MessageBubble({
  email,
  senderEmail,
  onOpenHtml,
  onMarkRead,
  onReply,
  onDelete,
  compact = false,
}: MessageBubbleProps) {
```

- [ ] **Step 2: Apply compact styles**

Change the outer `<div>` padding to be smaller when compact:

```tsx
<div
  className={`group ${compact ? "px-3 py-1.5" : "px-4 sm:px-6 py-2"} hover:bg-hover/50 transition-colors ${
    isUnread ? "bg-accent/5" : ""
  }`}
  onClick={handleClick}
>
```

When `compact` is true, use a shorter truncation length. Replace the constants section with:

```tsx
const truncateLength = compact ? 160 : TRUNCATE_LENGTH;

const isTruncated = text.length > truncateLength && !expanded;
const displayText = isTruncated
  ? text.slice(0, truncateLength).trimEnd() + "..."
  : text;
```

- [ ] **Step 3: Verify the app still compiles**

Run: `yarn dev`

Open the inbox in the browser and confirm existing email display is unchanged (compact defaults to false).

- [ ] **Step 4: Commit**

```bash
git add src/components/MessageBubble.tsx
git commit -m "feat: add compact prop to MessageBubble for sidebar use"
```

---

### Task 2: Create ThreadSidebar component

**Files:**
- Create: `src/components/ThreadSidebar.tsx`

- [ ] **Step 1: Create the ThreadSidebar component**

Create `src/components/ThreadSidebar.tsx`:

```tsx
import { X } from "lucide-react";
import { ScrollArea } from "@/components/ui/scroll-area";
import MessageBubble from "@/components/MessageBubble";
import type { Email } from "@/lib/api";

interface ThreadSidebarProps {
  emails: Email[];
  senderEmail: string;
  onOpenHtml: (email: Email) => void;
  onMarkRead: (email: Email) => void;
  onReply: (emailId: string) => void;
  onDelete: (emailId: string) => void;
  onClose: () => void;
}

export default function ThreadSidebar({
  emails,
  senderEmail,
  onOpenHtml,
  onMarkRead,
  onReply,
  onDelete,
  onClose,
}: ThreadSidebarProps) {
  // Display in chronological order (oldest first)
  const chronological = [...emails].reverse();

  return (
    <div className="flex h-full w-80 shrink-0 flex-col border-l border-border-dark bg-panel">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border-dark px-4 py-3">
        <h3 className="text-xs font-semibold text-text-primary">Thread</h3>
        <button
          onClick={onClose}
          className="rounded p-0.5 text-text-tertiary hover:bg-hover hover:text-text-secondary"
        >
          <X size={14} />
        </button>
      </div>

      {/* Email list */}
      <ScrollArea className="flex-1">
        <div className="divide-y divide-border-dark">
          {chronological.map((email) => (
            <MessageBubble
              key={email.id}
              email={email}
              senderEmail={senderEmail}
              onOpenHtml={onOpenHtml}
              onMarkRead={onMarkRead}
              onReply={onReply}
              onDelete={onDelete}
              compact
            />
          ))}
        </div>
      </ScrollArea>
    </div>
  );
}
```

- [ ] **Step 2: Verify it compiles**

Run: `yarn dev`

No visual change yet since the component isn't mounted. Just confirm no build errors.

- [ ] **Step 3: Commit**

```bash
git add src/components/ThreadSidebar.tsx
git commit -m "feat: add ThreadSidebar component for historical email thread"
```

---

### Task 3: Rewrite SenderDetail to use thread layout

**Files:**
- Modify: `src/pages/SenderDetail.tsx`

- [ ] **Step 1: Add threadOpen state and split emails**

In `SenderDetail`, add state for the thread sidebar. After the existing `replyToEmailId` state, add:

```tsx
const [threadOpen, setThreadOpen] = useState(false);
```

Replace the `chronologicalEmails` line (`const chronologicalEmails = [...emails].reverse();`) with:

```tsx
// Latest email is first in the array (API returns newest first)
const latestEmail = emails[0] ?? null;
const threadEmails = emails.slice(1); // older emails for sidebar
```

- [ ] **Step 2: Add ThreadSidebar import**

At the top of the file, add:

```tsx
import ThreadSidebar from "@/components/ThreadSidebar";
import { MessageSquare } from "lucide-react";
```

- [ ] **Step 3: Replace the conversation section with the new layout**

Replace the entire `{/* Conversation */}` `<ScrollArea>` block (lines 173-193 in current file) with:

```tsx
{/* Conversation — main email + thread sidebar */}
<div className="flex flex-1 overflow-hidden">
  {/* Main email area */}
  <div className="flex flex-1 flex-col min-w-0">
    <ScrollArea className="flex-1">
      {latestEmail ? (
        <div className="px-4 sm:px-6 py-4">
          {/* Thread indicator */}
          {threadEmails.length > 0 && (
            <button
              onClick={() => setThreadOpen(!threadOpen)}
              className="mb-3 flex items-center gap-1.5 text-xs text-accent hover:underline"
            >
              <MessageSquare size={12} />
              {threadEmails.length} earlier message{threadEmails.length !== 1 ? "s" : ""}
            </button>
          )}

          {/* Latest email display */}
          <MessageBubble
            email={latestEmail}
            senderEmail={sender.email}
            onOpenHtml={setHtmlPreviewEmail}
            onMarkRead={handleMarkRead}
            onReply={setReplyToEmailId}
            onDelete={handleDelete}
          />
        </div>
      ) : (
        <p className="py-4 text-center text-xs text-text-tertiary">
          No emails found.
        </p>
      )}
    </ScrollArea>

    {/* Reply Composer stays in main area */}
    {replyToEmailId && (
      <ReplyComposer
        emailId={replyToEmailId}
        senderName={sender.name}
        senderEmail={sender.email}
        recipients={recipients}
        onClose={() => setReplyToEmailId(null)}
        onSent={refetchEmails}
      />
    )}
  </div>

  {/* Thread sidebar */}
  {threadOpen && threadEmails.length > 0 && (
    <ThreadSidebar
      emails={threadEmails}
      senderEmail={sender.email}
      onOpenHtml={setHtmlPreviewEmail}
      onMarkRead={handleMarkRead}
      onReply={setReplyToEmailId}
      onDelete={handleDelete}
      onClose={() => setThreadOpen(false)}
    />
  )}
</div>
```

- [ ] **Step 4: Remove the old ReplyComposer block**

The ReplyComposer was previously rendered after the ScrollArea (lines 196-205). Since it's now inside the main email area div (Step 3), delete the old block that's outside the new layout. Make sure ReplyComposer only appears once in the file.

- [ ] **Step 5: Reset threadOpen when sender changes**

In the `useEffect` that runs when `sender.id` changes (the one that calls `setLoading(true)`, `setRecipientFilter("")`, `setReplyToEmailId(null)`), add:

```tsx
setThreadOpen(false);
```

- [ ] **Step 6: Verify the full layout works**

Run: `yarn dev`

Test in browser:
1. Select a sender with multiple emails — confirm latest email shows prominently with "N earlier messages" button
2. Click the thread indicator — confirm sidebar opens with older emails
3. Click X on sidebar — confirm it closes
4. Select a sender with 1 email — confirm no thread indicator
5. Click Reply — confirm composer appears at the bottom of the main area
6. Switch senders — confirm sidebar closes and new sender's latest email shows

- [ ] **Step 7: Commit**

```bash
git add src/pages/SenderDetail.tsx
git commit -m "feat: replace flat email list with thread sidebar layout"
```

---

### Task 4: Mobile responsive behavior

**Files:**
- Modify: `src/pages/SenderDetail.tsx`
- Modify: `src/components/ThreadSidebar.tsx`

- [ ] **Step 1: Make ThreadSidebar overlay on mobile**

In `src/components/ThreadSidebar.tsx`, update the outer div classes to overlay on mobile:

```tsx
<div className="flex h-full w-80 shrink-0 flex-col border-l border-border-dark bg-panel
  max-md:absolute max-md:right-0 max-md:top-0 max-md:z-10 max-md:w-full max-md:border-l-0">
```

- [ ] **Step 2: Make the conversation wrapper position-relative for mobile overlay**

In `src/pages/SenderDetail.tsx`, add `relative` to the conversation flex container:

```tsx
<div className="relative flex flex-1 overflow-hidden">
```

- [ ] **Step 3: Verify mobile behavior**

Run: `yarn dev`

Resize the browser to a narrow width (< 768px). Open a thread — the sidebar should overlay the full width instead of squishing the main content.

- [ ] **Step 4: Commit**

```bash
git add src/pages/SenderDetail.tsx src/components/ThreadSidebar.tsx
git commit -m "feat: mobile overlay for thread sidebar"
```
