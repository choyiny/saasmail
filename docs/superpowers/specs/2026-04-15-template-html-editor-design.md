# Template HTML Editor Redesign

## Summary

Replace the Tiptap WYSIWYG editor in the template editor page with a CodeMirror 6 HTML source editor + live iframe preview, side by side. This gives full control over email HTML (tables, inline styles, custom attributes) while showing a real-time rendered preview. Variable detection UX is made more prominent.

## Motivation

Email templates require precise HTML control — tables for layout, inline styles for mail-client compatibility, and custom markup. Tiptap's schema-based approach strips HTML that doesn't match its configured extensions, making it unsuitable for email template authoring.

## Design

### Editor Component: `HtmlCodeEditor.tsx`

A new React component wrapping CodeMirror 6.

**Dependencies to add (yarn):**

- `codemirror`
- `@codemirror/lang-html`
- `@codemirror/state`
- `@codemirror/view`
- `@codemirror/theme-one-dark` (dark theme matching app aesthetic)

**Props:**

- `value: string` — current HTML content
- `onChange: (html: string) => void` — called on every edit
- `className?: string` — optional wrapper class

**Behavior:**

- Dark background using the one-dark theme (matches app's dark UI)
- HTML syntax highlighting
- Line numbers enabled
- Accepts pasted HTML as-is with no transformation
- Debounce not needed — CodeMirror handles this efficiently

### Live Preview: iframe

An `<iframe>` element beside the code editor renders the HTML in real-time.

- White background — shows what the recipient will see
- Uses `srcdoc` attribute bound to `bodyHtml` state
- Sandboxed: `sandbox="allow-same-origin"` to prevent script execution
- No additional libraries needed

### Page Layout

```
┌─────────────────────────────────────────────────────────┐
│  ← Templates / Edit Template             API Cancel Save │
├─────────────────────────────────────────────────────────┤
│  [Template Name input]                                   │
│  Slug: welcome-email       Subject: Welcome, {{name}}!  │
├─────────────────────────────────────────────────────────┤
│  Variables: {{name}} {{company}}                         │
│  ℹ Use {{variableName}} in subject or body to add        │
│    template variables                                    │
├────────────────────────┬────────────────────────────────┤
│  HTML Source            │  Preview                       │
│  (CodeMirror, dark bg)  │  (iframe, white bg)            │
│                         │                                │
│  <h1>Welcome,           │  Welcome, {{name}}!            │
│  {{name}}!</h1>          │                                │
│  <p>Thanks for...</p>   │  Thanks for joining...         │
│                         │                                │
└────────────────────────┴────────────────────────────────┘
```

- Top bar: unchanged (back button, API/Cancel/Save actions)
- Metadata section: unchanged (name, slug, subject inputs)
- Variable bar: new, persistent, between metadata and editor
- Editor area: 50/50 horizontal split, flex-1 to fill remaining height
- Small labels ("HTML Source" / "Preview") above each pane

### Variable UX

**Persistent variable bar** sits between the metadata fields and the editor split.

- Auto-detects `{{variableName}}` from both `subject` and `bodyHtml` using existing `extractVariables()` function
- **When variables exist:** displays accent-colored chips for each variable + smaller helper text
- **When no variables exist:** displays helper text: "Use `{{variableName}}` in subject or body to add template variables"
- The existing API Reference slide-over panel (`ApiSamplePanel`) is unchanged — it already shows variables in curl examples and error responses

### Files Changed

**Keep (used elsewhere):**

- `src/components/TiptapEditor.tsx` — still used by `ComposeModal` and `ReplyComposer`
- All `.notion-*` CSS rules in `src/index.css` — still needed for TiptapEditor

**Add:**

- `src/components/HtmlCodeEditor.tsx` — CodeMirror wrapper component

**Modify:**

- `src/pages/TemplateEditorPage.tsx` — new layout with split panes, CodeMirror + iframe, prominent variable bar
- `src/index.css` — remove Notion-style CSS (lines 32–227)

**Dependencies:**

- Keep: `@tiptap/*` packages (still used by ComposeModal and ReplyComposer)
- Add: `codemirror`, `@codemirror/lang-html`, `@codemirror/state`, `@codemirror/view`, `@codemirror/theme-one-dark`

### Error Handling

- If `bodyHtml` is empty, the iframe preview shows a blank white page (no special handling needed)
- CodeMirror gracefully handles invalid/malformed HTML — it's just a text editor
- The iframe sandbox prevents any injected scripts from executing

### Testing

- Verify pasting complex email HTML (tables, inline styles) into CodeMirror preserves it exactly
- Verify the iframe preview renders the HTML accurately
- Verify variable detection works from both subject and body fields
- Verify variable chips update in real-time as HTML is edited
- Verify save/load round-trips preserve the full HTML
