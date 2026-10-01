/**
 * Theme tokens for compiled block documents.
 *
 * Keila reaches for a real CSS inliner (Floki walking selectors over the parsed
 * document) because its theme CSS is user-editable with arbitrary selectors.
 * Ours is a fixed token set, so each emitter interpolates the tokens it needs
 * directly. That removes an entire subsystem — and with it `HTMLRewriter`'s
 * selector-subset limits and its lack of specificity resolution.
 *
 * Every value here lands inside a `style` attribute, so every value is
 * validated at the schema boundary. See `ThemeOverridesSchema`.
 */

import type { ThemeOverrides } from "./schema";

/**
 * Font stacks are an allowlist, not free text — the value lands in `style`.
 *
 * Family names are quoted with **single** quotes, deliberately. These strings
 * are interpolated into `style="…"`, so a family written `"Segoe UI"` would
 * close the attribute and corrupt every element that carries a font. CSS treats
 * both quote characters identically, so single quotes cost nothing.
 */
export const FONT_STACKS = {
  system:
    "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
  serif: "Georgia, Cambria, 'Times New Roman', Times, serif",
  mono: "ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace",
} as const;

export type Theme = {
  fontFamily: string;
  fontSize: string;
  lineHeight: string;
  textColor: string;
  mutedColor: string;
  linkColor: string;
  pageBg: string;
  contentBg: string;
  contentWidth: string;
  headingColor: string;
  h1Size: string;
  h2Size: string;
  h3Size: string;
  buttonBg: string;
  buttonColor: string;
  buttonRadius: string;
  blockSpacing: string;
};

/**
 * `contentBg` is deliberately an off-white rather than `#ffffff`.
 *
 * Gmail and Outlook force-invert colours in dark mode with no reliable opt-out,
 * and pure white behind dark text is the pairing their algorithms handle worst
 * — it tends to inverted-grey text on near-black. A slightly warm off-white
 * survives inversion legibly. This is the concrete consequence of accepting
 * forced inversion in v1 (see `SPEC-block-compiler.md`, decision 1).
 */
export const DEFAULT_THEME: Theme = {
  fontFamily: FONT_STACKS.system,
  fontSize: "16px",
  lineHeight: "26px",
  textColor: "#1f2937",
  mutedColor: "#6b7280",
  linkColor: "#1d4ed8",
  pageBg: "#f3f4f6",
  contentBg: "#fafaf9",
  contentWidth: "600px",
  headingColor: "#111827",
  h1Size: "30px",
  h2Size: "24px",
  h3Size: "19px",
  buttonBg: "#1d4ed8",
  buttonColor: "#ffffff",
  buttonRadius: "6px",
  blockSpacing: "16px",
};

/**
 * Merge validated overrides onto the defaults.
 *
 * `fontStack` is a key into `FONT_STACKS` rather than a free-text family, so a
 * caller cannot inject arbitrary CSS through it.
 */
export function resolveTheme(overrides?: ThemeOverrides): Theme {
  if (!overrides) return DEFAULT_THEME;
  const { fontStack, ...rest } = overrides;
  return {
    ...DEFAULT_THEME,
    ...(fontStack ? { fontFamily: FONT_STACKS[fontStack] } : {}),
    ...rest,
  };
}
