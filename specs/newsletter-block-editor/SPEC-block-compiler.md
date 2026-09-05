# Spec: block-compiler

> Module `block-compiler` of [the newsletter block editor map](./README.md).
> Shared commands, structure, style, testing and boundaries live there.

## Objective

A pure, dependency-free TypeScript module that turns a **block document** into
email-safe HTML. No I/O, no database, no network. It runs in the worker (at
template save) and in the browser (for live preview) from the same source.

Success looks like: an author arranges seven kinds of block and the output
renders correctly in Gmail, Apple Mail, and Outlook 2016+ without anyone
writing a `<table>`.

## Assumptions

1. Seven block types in v1. **No multi-column layout** — in Keila that single
   block is 170 of the ~310 lines of per-block emission code (55%), and it
   multiplies the Outlook test matrix.
2. A 600px content column on a full-width background. Single template shell.
3. Theme is a **fixed token set**, not user-authored CSS.
4. The compiler is synchronous and total: it never throws on a document that
   passed schema validation.

## Schema: Zod, not a TS union

Worker strict mode is off, so a hand-written discriminated union will not
narrow under `switch (block.type)`. Zod is already a worker dependency
(`@hono/zod-openapi`), gives runtime validation at the API boundary — which we
need anyway — and produces correctly narrowed types via `z.infer`.

```ts
// worker/src/lib/blocks/schema.ts
const Align = z.enum(["left", "center", "right"]);

const InlineHtml = z.string().max(10_000); // sanitized separately, see below
const Url = z
  .string()
  .url()
  .max(2_000)
  .refine((u) => !/^data:/i.test(u), {
    message: "data: URIs are not allowed in a block document",
  });

export const BlockSchema = z.discriminatedUnion("type", [
  z.object({
    id: z.string(),
    type: z.literal("paragraph"),
    data: z.object({ html: InlineHtml }),
    align: Align.optional(),
  }),
  z.object({
    id: z.string(),
    type: z.literal("heading"),
    data: z.object({
      level: z.union([z.literal(1), z.literal(2), z.literal(3)]),
      html: InlineHtml,
    }),
    align: Align.optional(),
  }),
  z.object({
    id: z.string(),
    type: z.literal("image"),
    data: z.object({
      src: Url,
      alt: z.string().max(500),
      width: z
        .string()
        .regex(/^\d{1,4}(px|%)$/)
        .optional(),
      href: Url.optional(),
      caption: z.string().max(500).optional(),
    }),
    align: Align.optional(),
  }),
  z.object({
    id: z.string(),
    type: z.literal("button"),
    data: z.object({
      label: z.string().min(1).max(200),
      href: Url,
      full: z.boolean().optional(),
    }),
    align: Align.optional(),
  }),
  z.object({
    id: z.string(),
    type: z.literal("list"),
    data: z.object({
      ordered: z.boolean(),
      items: z.array(InlineHtml).max(200),
    }),
  }),
  z.object({
    id: z.string(),
    type: z.literal("quote"),
    data: z.object({
      html: InlineHtml,
      caption: z.string().max(500).optional(),
    }),
  }),
  z.object({
    id: z.string(),
    type: z.literal("separator"),
    data: z.object({}),
  }),
]);

export const BlockDocumentSchema = z.object({
  version: z.literal(1),
  theme: ThemeOverridesSchema.optional(),
  blocks: z.array(BlockSchema).max(500),
});
```

Note the deliberate flattening: alignment is a first-class optional field on
the block. Keila carries it in a nested `tunes` object because Editor.js's
plugin API forces that shape; we are not bound by it.

`version: 1` is present so a future shape change is a migration rather than a
guess. `data: {}` on `separator` keeps every block uniform — an emitter always
receives `data`.

## Inline HTML is a security boundary

`data.html` and list `items` carry rich text from Tiptap: bold, italic, links.
They are emitted **raw** into the output, so they must be sanitized on the way
in, server-side, on every write path — the template API accepts block JSON, so
client-side sanitization alone is not a control.

Allowlist, and nothing else:

| Allowed                       | Notes                                     |
| ----------------------------- | ----------------------------------------- |
| `b` `strong` `i` `em` `u` `s` | no attributes                             |
| `a`                           | `href` only; `http(s)` and `mailto:` only |
| `br`                          | void                                      |
| `span`                        | `style` limited to `color:<hex\|rgb>`     |

Everything else is stripped, contents preserved. `javascript:`, `data:`, and
`vbscript:` hrefs are dropped. Sanitization lives in
`worker/src/lib/blocks/sanitize.ts` and must be a Zod `.transform()` on
`InlineHtml`, so there is no path that validates without sanitizing.

`{{name}}` survives sanitization untouched — braces are not HTML.

## Emitter contract

One function per block type, registered in a table:

```ts
// worker/src/lib/blocks/emitters.ts
type Emitter<B> = (block: B, theme: Theme) => string;

export const EMITTERS = {
  paragraph: emitParagraph,
  heading: emitHeading,
  image: emitImage,
  button: emitButton,
  list: emitList,
  quote: emitQuote,
  separator: emitSeparator,
} satisfies { [K in Block["type"]]: Emitter<Extract<Block, { type: K }>> };
```

Each emitter returns exactly **one `<tr>`**, so the document is a single table
and block order is row order. This is Keila's structure and it is the right one
— it is what makes each emitter independently readable and testable.

```html
<tr class="block block--paragraph">
  <td style="…">…</td>
</tr>
```

Class names are emitted alongside inline styles. They are not used for
styling — they are there so the preview iframe and future tooling can address
blocks, and so the compiled HTML is legible when someone opens it.

## Theme: tokens interpolated at emit time, no CSS inliner

**This supersedes the `HTMLRewriter`-based inliner suggested earlier.**

Keila needs a real CSS inliner (`Html.apply_inline_styles`, Floki) because its
theme CSS is user-editable with arbitrary selectors. Ours is not. With a fixed
token set, each emitter can interpolate the tokens it needs directly — which
removes an entire subsystem along with `HTMLRewriter`'s selector-subset limits
and its lack of specificity resolution.

```ts
export type Theme = {
  fontFamily: string;
  fontSize: string;
  lineHeight: string;
  textColor: string;
  mutedColor: string;
  linkColor: string;
  pageBg: string;
  contentBg: string;
  contentWidth: string; // "600px"
  headingColor: string;
  h1Size: string;
  h2Size: string;
  h3Size: string;
  buttonBg: string;
  buttonColor: string;
  buttonRadius: string;
  blockSpacing: string;
};
```

`ThemeOverrides` is `Partial<Theme>` with every value constrained — colours to
`#rrggbb`, lengths to `\d+(px|%)`, `fontFamily` to an allowlist of stacks. A
theme value is interpolated into a `style` attribute, so an unvalidated one is
a CSS-injection hole.

Media queries cannot be inlined and stay in a `<style>` block in the shell —
that is the only stylesheet in the output, and it carries mobile stacking and
`@media (prefers-color-scheme: dark)` only.

The shell (`worker/src/lib/blocks/shell.ts`) provides the doctype, the
`mso` conditional wrapper, the 600px centred table, and the preheader span.

## Plain text

Unchanged. `snapshotCampaign` already derives the text part with
`htmlToText(bodyHtml)` (`campaign-sender.ts:105`). A block-aware text
serializer would be a second path to maintain for no gain in output quality.

## Success criteria

- [ ] `compile(doc: BlockDocument): string` is pure, synchronous, and total for
      any document that passes `BlockDocumentSchema`.
- [ ] Golden-file tests: a fixture document per block type, plus one kitchen-sink
      document, compile byte-identically to committed expectations.
- [ ] `analyzeTemplate(subject, compile(doc))` returns no parse error for every
      fixture, and reports `{{name}}` placed in a paragraph, a button label, and
      a button `href` as a required variable.
- [ ] Sanitizer tests: `<script>`, `onerror=`, `javascript:` href, `data:` href,
      and a `style` carrying `expression()` are all neutralised, with visible
      text preserved.
- [ ] A `data:` image `src` is rejected by the schema, not silently emitted.
- [ ] Output contains no `<style>` other than the shell's, and no `class`
      attribute is load-bearing for appearance.
- [ ] `yarn test --maxWorkers=4` stays green (94 files / 1096 tests at baseline);
      `npx tsc --noEmit -p tsconfig.app.json` stays at 6 errors.

## Decisions

Resolved 2026-09-04. Recorded rather than deleted, so a later reader sees what
was traded away.

1. **Dark mode — accept forced inversion in v1.** Gmail and Outlook invert
   colours with no reliable opt-out, so a `prefers-color-scheme` block buys
   correctness in Apple Mail alone while adding a second palette to maintain.
   Consequence for the theme tokens: avoid pure `#ffffff` behind dark text,
   which is the pairing that inverts worst.
2. **Outlook buttons — square bulletproof table, no VML in v1.** A
   `<table>`-wrapped anchor with cell padding renders correctly everywhere;
   only the corner radius is lost in Outlook 2016. VML roughly doubles the
   button emitter and is purely additive later, so this is not a one-way door.
