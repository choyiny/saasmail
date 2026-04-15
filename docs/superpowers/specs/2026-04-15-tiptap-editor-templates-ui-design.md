# Tiptap Editor & Templates UI Design

## Overview

Add a shared Tiptap rich text editor component, a templates management UI (list + full-page editor), and replace the compose modal's textarea with the Tiptap editor.

## Shared TiptapEditor Component

- File: `src/components/TiptapEditor.tsx`
- Wraps `@tiptap/react` with `StarterKit` extension (bold, italic, lists, headings, blockquote, code, horizontal rule)
- Props: `content: string` (initial HTML), `onUpdate: (html: string) => void`
- Basic toolbar with formatting buttons (bold, italic, heading, bullet list, ordered list)
- Outputs HTML via `editor.getHTML()`
- Styled to match existing UI (neutral colors, border, focus ring)

## Templates List Page (`/templates`)

- File: `src/pages/TemplatesPage.tsx`
- Accessible via "Templates" link in the InboxPage header (next to "Compose" button)
- Fetches templates via `GET /api/email-templates`
- Displays a table/list with columns: Name, Slug, Subject
- "New Template" button navigates to `/templates/new`
- Each row: click to edit (`/templates/:slug/edit`), delete button with confirmation
- Delete calls `DELETE /api/email-templates/:slug`

## Template Editor Page

- File: `src/pages/TemplateEditorPage.tsx`
- Used for both create (`/templates/new`) and edit (`/templates/:slug/edit`)
- Determines mode from URL: if `slug` param exists, fetch template and populate fields; otherwise blank form
- Fields:
  - Name (text input)
  - Slug (text input, editable only on create, disabled on edit)
  - Subject (text input, supports `{{variable}}` as plain text)
  - Body (TiptapEditor component)
- Save button:
  - Create mode: `POST /api/email-templates` with `{ slug, name, subject, bodyHtml }`
  - Edit mode: `PUT /api/email-templates/:slug` with `{ name, subject, bodyHtml }`
- On success, navigate back to `/templates`
- Back link at top to return to `/templates`

## Compose Modal Update

- File: `src/pages/ComposeModal.tsx`
- Replace `<Textarea>` for message body with `<TiptapEditor>`
- Remove the newline-to-`<br/>` conversion logic since Tiptap outputs HTML directly
- Pass editor HTML as `bodyHtml` to the send/reply API calls

## API Client Additions

Add to `src/lib/api.ts`:

```ts
type EmailTemplate = {
  id: string;
  slug: string;
  name: string;
  subject: string;
  bodyHtml: string;
  createdAt: number;
  updatedAt: number;
};

function fetchTemplates(): Promise<EmailTemplate[]>;
function fetchTemplate(slug: string): Promise<EmailTemplate>;
function createTemplate(data: {
  slug: string;
  name: string;
  subject: string;
  bodyHtml: string;
}): Promise<EmailTemplate>;
function updateTemplate(
  slug: string,
  data: { name?: string; subject?: string; bodyHtml?: string },
): Promise<EmailTemplate>;
function deleteTemplate(slug: string): Promise<{ success: boolean }>;
```

## Routing Changes

In `App.tsx`, add inside AuthGuard:

- `/templates` — `TemplatesPage`
- `/templates/new` — `TemplateEditorPage`
- `/templates/:slug/edit` — `TemplateEditorPage`

The existing `/*` catch-all for InboxPage must be reordered so these specific routes match first.

## Dependencies

New npm packages:

- `@tiptap/react`
- `@tiptap/starter-kit`
- `@tiptap/pm`

## Out of Scope

- No special visual treatment for `{{variable}}` tokens — typed as plain text
- No template preview/send from the UI
- No template versioning
