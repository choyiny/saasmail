/**
 * Block document → email HTML.
 *
 * Pure, synchronous and dependency-free by contract: the worker runs it on
 * template save, and the editor imports the same module to render its preview.
 * That is what makes the preview the email rather than an approximation of it.
 *
 * The compiler **never** interprets `{{…}}`. A variable typed into a block is
 * literal text here; it survives into the compiled HTML and is interpolated per
 * recipient downstream, exactly as it is for a hand-written HTML template.
 * Keila applies Liquid recursively over every string in the block JSON before
 * rendering; we deliberately do not, so no template engine ever touches a URL
 * or an image `src`.
 */

import type { Block, BlockDocument } from "./schema";
import {
  emitButton,
  emitHeading,
  emitImage,
  emitList,
  emitParagraph,
  emitQuote,
  emitSeparator,
} from "./emitters";
import { wrapDocument } from "./shell";
import { resolveTheme, type Theme } from "./theme";

/**
 * The emitter table. `satisfies` makes a missing block type a compile error —
 * verified by deleting an entry and watching TS1360 fire.
 *
 * Note what does *not* enforce it today: `tsconfig.app.json` includes `src`
 * only, and there is no worker typecheck gate at all (see the plan's
 * verification baseline), so no CI check reads this file. It becomes a real
 * gate once the editor imports the compiler for its preview. Until then the
 * safety net is `blocks-compile.test.ts`, which compiles every block type.
 */
const EMITTERS = {
  paragraph: emitParagraph,
  heading: emitHeading,
  image: emitImage,
  button: emitButton,
  list: emitList,
  quote: emitQuote,
  separator: emitSeparator,
} satisfies {
  [K in Block["type"]]: (
    block: Extract<Block, { type: K }>,
    theme: Theme,
  ) => string;
};

/**
 * Compile one block to its table row.
 *
 * The cast is load-bearing: worker strict mode is off, so indexing the table by
 * `block.type` does not narrow `block` to the matching variant. The `satisfies`
 * clause above is what actually proves the table is total and correctly typed;
 * this cast only gets the value past the indexed call.
 */
function emit(block: Block, theme: Theme): string {
  const emitter = EMITTERS[block.type] as (b: Block, t: Theme) => string;
  return emitter(block, theme);
}

/**
 * Compile a validated block document into a complete HTML email.
 *
 * Total for any document that passed `BlockDocumentSchema`, and deterministic:
 * the same document compiles to the same bytes on every call, which is what
 * lets the golden tests assert byte equality.
 */
export function compile(doc: BlockDocument, preheader = ""): string {
  const theme = resolveTheme(doc.theme);
  const rows = doc.blocks.map((block) => emit(block, theme)).join("\n");
  return wrapDocument(rows, theme, preheader);
}
