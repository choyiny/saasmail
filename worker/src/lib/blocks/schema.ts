/**
 * Block document schema.
 *
 * Defined in Zod rather than as a hand-written TypeScript union, for two
 * reasons that both matter:
 *
 *   1. `worker/tsconfig.json` sets no `strict`, so a discriminated union does
 *      **not** narrow under `switch (block.type)` in worker code. Zod's
 *      `z.infer` produces types that narrow correctly regardless.
 *   2. The template API accepts block documents from clients, so this has to
 *      be a runtime validator anyway. Deriving the types from the validator
 *      keeps the two from drifting.
 *
 * Sanitization is wired in as a `.transform()` on `InlineHtml`, so there is no
 * code path that validates a document without also sanitizing it.
 */

import { z } from "zod";
import { sanitizeInlineHtml } from "./sanitize";

/** Per-block horizontal alignment. Flattened onto the block rather than
 *  nested in a `tunes` object — we are not bound to Editor.js's plugin shape. */
export const AlignSchema = z.enum(["left", "center", "right"]);

/** Ceiling on one rich-text field. A newsletter paragraph is prose, not a
 *  document; the cap keeps sanitization O(n) with a known n. */
export const MAX_INLINE_HTML = 10_000;
export const MAX_BLOCKS = 500;
export const MAX_LIST_ITEMS = 200;

/**
 * Rich text. Validated for length, then sanitized to the eight-tag allowlist.
 * The output is what gets stored and emitted — the raw input never survives.
 */
export const InlineHtmlSchema = z
  .string()
  .max(
    MAX_INLINE_HTML,
    `Inline HTML exceeds the ${MAX_INLINE_HTML} character limit`,
  )
  .transform(sanitizeInlineHtml);

/**
 * A link or image target.
 *
 * `data:` is refused rather than sanitized away. A data URI in a newsletter is
 * a correctness bug, not a security one: Gmail strips data-URI images, and the
 * bytes would be duplicated into every recipient's copy of the message. Failing
 * the write is how the editor learns to upload instead.
 *
 * A URL that *begins* with a template tag is accepted with no scheme check,
 * because it does not have a scheme yet. `{{unsubscribe_url}}` is the case that
 * forces this — every campaign email carries it (see `docs/newsletters.md`), so
 * a schema that demanded `https://` here would reject the one link every
 * newsletter is legally required to have.
 *
 * That does mean a variable could interpolate to `javascript:`. This is not a
 * new exposure: a hand-written HTML template has always been able to put a
 * variable in an `href`, and the values come from the operator or the send API,
 * not from a subscriber. The compiler's contract is that it does not interpret
 * `{{…}}` — deciding what a variable may expand to belongs to the interpolation
 * layer, and adding a second opinion here would only make the two disagree.
 */
const TEMPLATE_TAG_PREFIX = /^\s*\{\{/;

export const UrlSchema = z
  .string()
  .min(1)
  .max(2_000)
  // The `data:` check is declared first so it is the issue reported when both
  // fail. A pasted data URI is the single most likely mistake here — it is what
  // the inbox editor produces — and "upload the file instead" is a far more
  // actionable diagnostic than "URL must be http(s)".
  .refine((u) => !/^\s*data:/i.test(u), {
    message: "data: URIs are not allowed in a block document — upload the file",
  })
  .refine(
    (u) =>
      TEMPLATE_TAG_PREFIX.test(u) || /^(?:https?:\/\/|mailto:)/i.test(u.trim()),
    { message: "URL must be http(s), mailto, or start with a {{variable}}" },
  );

const BlockId = z.string().min(1).max(64);

/** Every block carries `data`, even when empty, so an emitter can rely on it. */
export const BlockSchema = z.discriminatedUnion("type", [
  z.object({
    id: BlockId,
    type: z.literal("paragraph"),
    data: z.object({ html: InlineHtmlSchema }),
    align: AlignSchema.optional(),
  }),
  z.object({
    id: BlockId,
    type: z.literal("heading"),
    data: z.object({
      level: z.union([z.literal(1), z.literal(2), z.literal(3)]),
      html: InlineHtmlSchema,
    }),
    align: AlignSchema.optional(),
  }),
  z.object({
    id: BlockId,
    type: z.literal("image"),
    data: z.object({
      src: UrlSchema,
      alt: z.string().max(500).default(""),
      width: z
        .string()
        .regex(/^\d{1,4}(?:px|%)$/, "width must look like `320px` or `100%`")
        .optional(),
      href: UrlSchema.optional(),
      caption: z.string().max(500).optional(),
    }),
    align: AlignSchema.optional(),
  }),
  z.object({
    id: BlockId,
    type: z.literal("button"),
    data: z.object({
      label: z.string().min(1).max(200),
      href: UrlSchema,
      full: z.boolean().optional(),
    }),
    align: AlignSchema.optional(),
  }),
  z.object({
    id: BlockId,
    type: z.literal("list"),
    data: z.object({
      ordered: z.boolean(),
      items: z.array(InlineHtmlSchema).max(MAX_LIST_ITEMS),
    }),
  }),
  z.object({
    id: BlockId,
    type: z.literal("quote"),
    data: z.object({
      html: InlineHtmlSchema,
      caption: z.string().max(500).optional(),
    }),
  }),
  z.object({
    id: BlockId,
    type: z.literal("separator"),
    data: z.object({}),
  }),
]);

/** Colours are interpolated into a `style` attribute, so an unvalidated value
 *  is a CSS-injection hole. Only two literal forms are accepted. */
const ColorSchema = z
  .string()
  .regex(/^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i, "colour must be #rgb or #rrggbb");

const LengthSchema = z
  .string()
  .regex(/^\d{1,4}(?:px|%)$/, "length must look like `600px` or `100%`");

export const ThemeOverridesSchema = z
  .object({
    fontStack: z.enum(["system", "serif", "mono"]),
    fontSize: LengthSchema,
    textColor: ColorSchema,
    mutedColor: ColorSchema,
    linkColor: ColorSchema,
    pageBg: ColorSchema,
    contentBg: ColorSchema,
    contentWidth: LengthSchema,
    headingColor: ColorSchema,
    buttonBg: ColorSchema,
    buttonColor: ColorSchema,
    buttonRadius: LengthSchema,
  })
  .partial();

export const BlockDocumentSchema = z.object({
  version: z.literal(1),
  theme: ThemeOverridesSchema.optional(),
  blocks: z
    .array(BlockSchema)
    .max(MAX_BLOCKS, `A document may hold at most ${MAX_BLOCKS} blocks`),
});

export type Align = z.infer<typeof AlignSchema>;
export type Block = z.infer<typeof BlockSchema>;
export type BlockDocument = z.infer<typeof BlockDocumentSchema>;
export type ThemeOverrides = z.infer<typeof ThemeOverridesSchema>;

/** Narrow a block to one variant. Written as a helper because worker strict
 *  mode is off and `Extract` on a `switch` does not narrow there. */
export type BlockOf<T extends Block["type"]> = Extract<Block, { type: T }>;
