# Slack-Style Reply Composer

## Summary

Replace the reply modal (`ComposeModal` in reply mode) with an inline reply composer fixed at the bottom of the `SenderDetail` panel. Add support for replying with email templates (with auto-filled variables) and choosing which "from" address to send from.

## Current State

- Reply is triggered via `onReply(emailId)` in `InboxPage`, which opens `ComposeModal` as a dialog overlay
- `ComposeModal` handles both new compose and reply; reply mode disables To/Subject fields
- Single `RESEND_EMAIL_FROM` env var determines the sender address for all outgoing email
- Templates exist but are only used via API or sequences, not available during manual reply

## Design

### 1. New Component: `ReplyComposer`

**Location:** `src/components/ReplyComposer.tsx`

A bottom-docked composer that renders inside `SenderDetail` below the message scroll area.

**Props:**

```typescript
interface ReplyComposerProps {
  emailId: string; // email being replied to
  senderName: string | null; // for auto-filling template variables
  senderEmail: string; // for auto-filling template variables
  recipients: string[]; // available "from" addresses
  onClose: () => void; // dismiss the composer
  onSent: () => void; // callback after successful send (refresh emails)
}
```

**Layout (top to bottom):**

1. **Header bar** — "Reply" label + close (X) button
2. **From picker** — dropdown showing available recipient addresses, defaults to first one
3. **Tab toggle** — two tabs: "Freeform" | "Template"
4. **Content area** — depends on active tab (see below)
5. **Footer** — Send button + error display

**Freeform tab:**

- TiptapEditor instance for rich text editing (same as current reply)

**Template tab:**

- Dropdown to select a template (fetched via `fetchTemplates()`)
- On selection: show a read-only HTML preview of the template body
- Below preview: input fields for each detected `{{variable}}` in the template
- Auto-fill logic: if variable name matches `name` → use `senderName`, if `email` → use `senderEmail`. All fields are editable.
- Template subject is shown but not editable (it comes from the template)

### 2. Changes to `SenderDetail`

- Remove `onReply` prop (reply state is now local)
- Add local state: `replyToEmailId: string | null`
- Pass `onReply` to `MessageBubble` that sets `replyToEmailId`
- Layout becomes:
  ```
  <div className="flex h-full flex-col">
    {/* Header */}
    {/* Sequence status */}
    <ScrollArea className="flex-1 min-h-0">
      {/* Messages */}
    </ScrollArea>
    {replyToEmailId && (
      <ReplyComposer ... />
    )}
  </div>
  ```
- Collect unique recipient addresses from emails (already done for the filter dropdown) and pass to `ReplyComposer` as `recipients`
- Add `onSent` callback that refetches emails for the current sender

### 3. Changes to `InboxPage`

- Remove `replyToEmailId` state and `handleReply` function
- Remove `replyToEmailId` prop from `ComposeModal` (keep modal for new compose only)
- Remove `onReply` prop from `SenderDetail`

### 4. Changes to `ComposeModal`

- Remove all reply-related logic (`replyToEmailId` prop, reply mode, `fetchEmail` call)
- Simplify to compose-only modal

### 5. Changes to `MessageBubble`

- No interface change — still calls `onReply(emailId)`, but now the handler is in `SenderDetail` instead of `InboxPage`

### 6. Backend: Extend Reply Endpoint

**File:** `worker/src/routers/send-router.ts`

Extend the `POST /reply/{emailId}` request schema:

```typescript
z.object({
  bodyHtml: z.string().optional(),
  bodyText: z.string().optional(),
  fromAddress: z.string().email().optional(),
  templateSlug: z.string().optional(),
  variables: z.record(z.string()).optional(),
});
```

**Logic changes:**

- If `fromAddress` is provided, use it instead of `RESEND_EMAIL_FROM` (validate it's a known recipient address from the emails table)
- If `templateSlug` is provided, fetch the template, render it by replacing `{{var}}` with values from `variables`, and use the rendered HTML as the body. Template subject replaces the auto-generated "Re: ..." subject.
- If neither `templateSlug` nor `bodyHtml` is provided, return 400
- If `templateSlug` is provided with missing required variables, return 400

### 7. Frontend API: Extend `replyToEmail`

```typescript
export async function replyToEmail(
  emailId: string,
  data: {
    bodyHtml?: string;
    bodyText?: string;
    fromAddress?: string;
    templateSlug?: string;
    variables?: Record<string, string>;
  },
): Promise<{ id: string }> {
  return apiFetch(`/api/send/reply/${emailId}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
}
```

## What Gets Removed

- Reply mode in `ComposeModal` (all `replyToEmailId`/`isReply` branches)
- `replyToEmailId` state in `InboxPage`
- `onReply` prop on `SenderDetail` (replaced by internal state)

## What Stays the Same

- `ComposeModal` continues to work for new compose (opened from sidebar)
- `MessageBubble` interface unchanged
- All existing API endpoints remain backward-compatible (new fields are optional)

## Error Handling

- Network errors display inline in the composer footer
- Template fetch failure shows error in template dropdown area
- Missing template variables returns 400 from backend with list of missing vars
- Invalid `fromAddress` returns 400 from backend

## Testing Considerations

- Reply with freeform text (existing flow, new UI)
- Reply with template + variables
- Reply with different from address
- Auto-fill of template variables from sender data
- Composer open/close lifecycle
- Backend validation of fromAddress against known recipients
- Backend template rendering with variable substitution
