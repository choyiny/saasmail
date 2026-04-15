# Inbox Redesign — Design Spec

## Overview

Three changes to the email display experience: fix inline attachments (CID images), redesign the sender detail view as a Slack-style conversation, and render full HTML emails on a white background in a modal.

## Inline Attachment Fix

### Problem

Inline images (`<img src="cid:image001.png">`) don't display because:

- The `attachments` table has no `contentId` column to map CID references
- The email handler doesn't extract Content-ID from parsed attachments
- The HTML body isn't rewritten to replace `cid:` URLs with serveable URLs
- The attachments API forces download (`Content-Disposition: attachment`) instead of inline display

### Solution

1. **Schema:** Add nullable `contentId` text column to `attachments` table
2. **Email handler:** When storing attachments, check for Content-ID header and save it. After all attachments are stored, rewrite `cid:` references in the email's `bodyHtml` to point to `/api/attachments/{id}/inline`
3. **Attachments router:** Add `GET /api/attachments/{id}/inline` endpoint that serves the file with `Content-Disposition: inline` instead of `attachment`
4. **Migration:** Add the `contentId` column

## Slack-Style Conversation View

Replaces the current accordion-style SenderDetail with a chat-like layout.

### Message Bubbles

- **Received emails:** Left-aligned bubble with sender email as attribution
- **Sent emails:** Right-aligned bubble with "You" + the `fromAddress` as attribution
- Each bubble shows:
  - Sender attribution + timestamp at top
  - Plain text body, truncated to ~4 lines with "show more" to expand inline
  - Non-inline attachments listed as download links below the text
  - Small expand icon (top-right corner) opens the full HTML modal
  - Unread indicator (bold/dot) for unread received emails — clicking the bubble marks it read

### Recipient Filter

- Dropdown in the SenderDetail header bar (next to the sender name/email)
- Filters the conversation to only show emails sent to/from a specific recipient address
- Populated from the unique recipient addresses found in that sender's emails

### Full HTML Modal

- Opens from the expand icon on any message
- Shows the full rendered HTML email body on a **white background** (consistent with email viewers)
- Uses DOMPurify for sanitization
- Inline images display correctly via the CID rewrite
- Modal has dark-themed chrome (frame/header/close button) with white content area
- Uses `prose prose-sm` classes (non-inverted) inside the white container
- Dismissible via X button, clicking outside, or Escape
