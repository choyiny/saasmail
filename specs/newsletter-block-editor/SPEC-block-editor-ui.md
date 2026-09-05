# Spec: block-editor-ui

> Module `block-editor-ui` of [the newsletter block editor map](./README.md).
> Shared commands, structure, style, testing and boundaries live there.
> Depends on `template-formats` and `image-assets`.

## Objective

A visual editing surface in `TemplateEditorPage` that produces a valid block
document. The author arranges blocks and sees the compiled email; they never
see HTML unless they ask for it.

## Assumptions

1. **Tiptap, not Editor.js.** Tiptap is already a dependency (`@tiptap/react`,
   `@tiptap/starter-kit`, `@tiptap/pm` — `package.json:63-67`) and is used by
   `TiptapEditor.tsx` for inbox replies. Keila runs a **hard fork of Editor.js
   pinned to a commit** (`git+https://github.com/pentacent/editor.js.git#743eaa8f`)
   — adopting Editor.js would mean either taking that liability or rebuilding
   their custom blocks against upstream.
2. `TiptapEditor.tsx` is **not** reused. It serves the inbox: it emits browser
   HTML and inlines images as base64. Sharing it would drag newsletter concerns
   into the reply composer. A new `src/components/blocks/` tree, same library.
3. The existing editor page shell — header, variable chips, view toggle,
   preview iframe, syntax card — is kept. This adds a surface, it does not
   replace the page.

## Mapping blocks to Tiptap

| Block       | Tiptap node                                    |
| ----------- | ---------------------------------------------- |
| `paragraph` | StarterKit `paragraph`                         |
| `heading`   | StarterKit `heading`, levels restricted to 1–3 |
| `list`      | StarterKit `bulletList` / `orderedList`        |
| `quote`     | StarterKit `blockquote` + a caption attribute  |
| `image`     | custom atom node, `src` from `image-assets`    |
| `button`    | custom atom node (`label`, `href`, `full`)     |
| `separator` | StarterKit `horizontalRule`                    |

Inline marks are restricted to the compiler's allowlist: bold, italic,
underline, strike, link, and a colour mark. StarterKit's `code`, `codeBlock`
and `image` are disabled — `code` has no sane email rendering and the built-in
image node would bypass the asset upload.

Serialization is a walk of the ProseMirror document producing
`BlockDocument`, in `src/components/blocks/serialize.ts`. It is the inverse of
the compiler and gets its own unit tests under `vitest.config.web.ts`.

## Editing surface

- A **block palette** — insert button, image, separator — plus a slash command,
  since the palette is discoverable and the slash command is fast.
- **Per-block controls** on hover: move up/down, delete, alignment.
- **Image insertion** uploads to `POST /api/newsletter-assets` and stores the
  returned URL. A drop or paste of an image file uploads it; it never becomes a
  data URI. The 5 MB rejection surfaces as an inline error on the block, not a
  toast that disappears.
- **Variable insertion** stays exactly as today: `{{name}}` is typed as text.
  The compiler treats it as opaque, and the existing chip analysis reads it out
  of the compiled HTML, so the Required/Optional/Sections groups keep working
  with no change.

## Preview

The existing iframe stays. It renders `compile(doc)` — the same compiler the
worker runs, imported directly. This is the payoff for keeping the compiler
pure and dependency-free: the preview is not an approximation of the email, it
is the email.

Debounce compilation; do not compile per keystroke.

## Format toggle

The view toggle gains the format dimension. A `block` template shows
`Blocks | Preview`; an `html` template shows today's `Code | Split | Preview`.

Switching a block template to HTML is the one-way conversion from
`SPEC-template-formats.md` and must be confirmed by a dialog that says the
block structure will be lost. Switching an HTML template to blocks is not
offered — the option is absent rather than present and disabled, because a
disabled control invites a support question with no good answer.

## Success criteria

- [ ] Creating a template with each of the seven block types round-trips:
      save, reload, and the editor shows the same document.
- [ ] `serialize(editor)` output validates against `BlockDocumentSchema` for
      every fixture, including an empty document.
- [ ] Pasting formatted rich text from a browser yields only allowlisted marks.
- [ ] Pasting an image file uploads it and inserts an `https://` URL; no
      `data:` URI appears in the serialized document.
- [ ] The preview iframe output is byte-identical to what the worker compiles
      and stores for the same document.
- [ ] A `{{name}}` typed into a paragraph appears in the Required chip group.
- [ ] E2E (`yarn test:e2e`): create a block template, add a heading, a
      paragraph with a link, an image and a button, save, and assert the stored
      `bodyHtml` contains the button href and the asset URL.
- [ ] `yarn test --maxWorkers=4` stays green (94 files / 1096 tests at baseline);
      `npx tsc --noEmit -p tsconfig.app.json` stays at 6 errors.

## Explicitly out of scope for v1

Multi-column layout, social-icon rows, markdown and MJML editors, block
templates as reusable "sections", and drag-and-drop reordering (the move
up/down controls cover it and are accessible by default).

## Decisions

Resolved 2026-09-04.

1. **The campaign flow is unchanged in v1.** A campaign still selects a template
   slug. Block authoring probably makes "one template per campaign" the common
   case, which will make the indirection feel like a detour — but that is a guess
   about behaviour, and the cheap move is to ship and watch rather than design a
   shortcut for a workflow nobody has used yet.
2. **Frontend typecheck baseline is 6 errors — measured, not assumed.**
   `npx tsc --noEmit -p tsconfig.app.json` reports exactly 6 pre-existing errors,
   in `ChatInboxSection`, `PublicLayout`, `PushOptInBanner`, `lib/push`,
   `OnboardingPage` and `SettingsPage`. "No new errors" means the count stays at 6. Note that `yarn tsc --noEmit` checks nothing at all and cannot be used as a
   gate here — see [the map](./README.md).
