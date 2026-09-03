/**
 * Browser-side template analysis and preview rendering.
 *
 * The grammar and semantics come straight from the worker's renderer —
 * `worker/src/lib/interpolate.ts` imports nothing and touches no Cloudflare
 * globals, so it bundles for the browser as-is via the `@worker` alias. This
 * file adds only what the editor needs on top: sample values to preview
 * against.
 *
 * It used to be a hand-copied duplicate of the whole tokenize → parse →
 * render pipeline, kept correct by a comment. That drifted (the copy lost
 * the `escape` argument to `applyFilters`, and validated filter names with
 * `in`, which let `{{x|toString}}` through), and drift here is invisible:
 * the editor silently shows a preview and a chip strip that disagree with
 * what the send API actually accepts.
 */

import {
  analyzeTemplate,
  interpolate,
  TemplateParseError,
  type TemplateAnalysis,
} from "@worker/lib/interpolate";

export { TemplateParseError, type TemplateAnalysis };

/**
 * Describe what a template needs and offers, for the editor UI.
 *
 * Thin alias over the worker's `analyzeTemplate` so the editor and the
 * `/variables` endpoint can never disagree about what a template requires.
 * Throws `TemplateParseError` on an unbalanced section or unknown filter —
 * mid-edit is a normal state to be in, so callers should catch.
 */
export const analyzeTemplateClient = analyzeTemplate;

/**
 * Placeholder values so the live preview renders sections as content
 * instead of showing literal `{{#items}}` tags. Two items per section so a
 * loop visibly repeats rather than looking like a single conditional block.
 */
export function sampleValues(
  analysis: TemplateAnalysis,
): Record<string, unknown> {
  const vars: Record<string, unknown> = {};
  for (const name of [...analysis.required, ...analysis.optional]) {
    vars[name] = `<${name}>`;
  }
  for (const section of analysis.sections) {
    // An inverted section renders its body only when the value is FALSY, so
    // giving `{{^items}}` a sample array would hide the very branch the
    // author is trying to look at — the empty-state copy would never appear
    // in the preview. Leave it absent (and drop any scalar placeholder set
    // above, which would be truthy) so the empty state is what renders.
    if (section.inverted) {
      delete vars[section.name];
      continue;
    }
    vars[section.name] = [0, 1].map(() =>
      Object.fromEntries(section.variables.map((v) => [v, `<${v}>`])),
    );
  }
  return vars;
}

/**
 * The exact tag text for a section's chip. Must always be a string that
 * really appears in the template — never a syntax that contradicts it:
 *   - inverted (`{{^key}}`) always renders that way, `?` or not, since
 *     inversion alone already makes it optional.
 *   - a non-inverted section that's optional (`analysis.optional` includes
 *     it) got there via a trailing `?`, so it renders as `{{#key?}}`.
 *   - otherwise it's a plain required section, `{{#key}}`.
 */
export function sectionChipLabel(
  section: TemplateAnalysis["sections"][number],
  analysis: TemplateAnalysis,
): string {
  if (section.inverted) return `{{^${section.name}}}`;
  if (analysis.optional.includes(section.name)) return `{{#${section.name}?}}`;
  return `{{#${section.name}}}`;
}

/**
 * The tag text to display for any analyzed top-level name.
 *
 * Lives here rather than in a page component because the editor's chip strip
 * and the reply composer's variable prompts both need it and had drifted:
 * the composer labelled every section `{{#name}}`, including inverted ones,
 * which is the inverse of what the template actually says.
 */
export function chipLabel(name: string, analysis: TemplateAnalysis): string {
  const section = analysis.sections.find((s) => s.name === name);
  if (section) return sectionChipLabel(section, analysis);
  return analysis.optional.includes(name) ? `{{${name}?}}` : `{{${name}}}`;
}

/** Whether an analyzed name is a section rather than a scalar variable. */
export function isSectionName(
  analysis: TemplateAnalysis,
  name: string,
): boolean {
  return analysis.sections.some((s) => s.name === name);
}

/**
 * Render a template against sample values for the live preview. Throws on
 * an unbalanced section or unknown filter (mid-edit is a normal state to be
 * in) — callers should catch and fall back to showing the raw source.
 *
 * Always escapes: the preview only ever renders the HTML body, never the
 * plain-text subject the worker renders with `{ escape: false }`.
 */
export function renderPreview(
  template: string,
  variables: Record<string, unknown>,
): string {
  return interpolate(template, variables as Parameters<typeof interpolate>[1]);
}
