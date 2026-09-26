/**
 * One emitter per block type.
 *
 * Each returns exactly **one `<tr>`**, so the compiled document is a single
 * table and block order is row order. That is Keila's structure and it is the
 * right one: it keeps every emitter independently readable and independently
 * golden-testable, and it is the only nesting Outlook renders predictably.
 *
 * Class names are emitted alongside the inline styles. They carry no styling —
 * they exist so the preview surface can address a block, and so the compiled
 * HTML is legible to a human who opens it.
 *
 * Font properties are repeated on every cell rather than inherited from
 * `<body>`. Outlook's Word engine does not inherit them reliably, and a cell
 * that forgets falls back to Times New Roman.
 */

import type { Align, BlockOf } from "./schema";
import { escapeHtml } from "./shell";
import type { Theme } from "./theme";

/** Horizontal padding on every content cell; `sm-px` narrows it on mobile. */
const GUTTER = "32px";

function textStyle(theme: Theme): string {
  return `font-family:${theme.fontFamily};font-size:${theme.fontSize};line-height:${theme.lineHeight};color:${theme.textColor};`;
}

function cellStyle(theme: Theme, align?: Align): string {
  return (
    `padding:${theme.blockSpacing} ${GUTTER};` +
    textStyle(theme) +
    (align ? `text-align:${align};` : "")
  );
}

function row(kind: string, inner: string): string {
  return `<tr class="block block--${kind}">${inner}</tr>`;
}

export function emitParagraph(
  block: BlockOf<"paragraph">,
  theme: Theme,
): string {
  return row(
    "paragraph",
    `<td class="sm-px" style="${cellStyle(theme, block.align)}">` +
      `<p style="margin:0;">${block.data.html}</p>` +
      `</td>`,
  );
}

export function emitHeading(block: BlockOf<"heading">, theme: Theme): string {
  const size = [theme.h1Size, theme.h2Size, theme.h3Size][block.data.level - 1];
  const level = block.data.level;
  return row(
    "heading",
    `<td class="sm-px" style="${cellStyle(theme, block.align)}">` +
      `<h${level} style="margin:0;font-size:${size};line-height:1.25;font-weight:bold;color:${theme.headingColor};">` +
      block.data.html +
      `</h${level}></td>`,
  );
}

export function emitQuote(block: BlockOf<"quote">, theme: Theme): string {
  const caption = block.data.caption
    ? `<div style="margin-top:8px;font-size:14px;color:${theme.mutedColor};">— ${escapeHtml(block.data.caption)}</div>`
    : "";
  return row(
    "quote",
    `<td class="sm-px" style="${cellStyle(theme)}">` +
      `<blockquote style="margin:0;padding-left:16px;border-left:3px solid ${theme.mutedColor};color:${theme.mutedColor};">` +
      block.data.html +
      `</blockquote>${caption}</td>`,
  );
}

export function emitSeparator(
  _block: BlockOf<"separator">,
  theme: Theme,
): string {
  // A bordered cell rather than `<hr>`: Outlook gives `<hr>` its own margins
  // that no stylesheet can reach.
  return row(
    "separator",
    `<td class="sm-px" style="padding:${theme.blockSpacing} ${GUTTER};">` +
      `<div style="height:1px;line-height:1px;font-size:0;background-color:${theme.mutedColor};opacity:0.25;">&nbsp;</div>` +
      `</td>`,
  );
}

export function emitList(block: BlockOf<"list">, theme: Theme): string {
  const tag = block.data.ordered ? "ol" : "ul";
  const items = block.data.items
    .map((item) => `<li style="margin:0 0 6px 0;">${item}</li>`)
    .join("");
  return row(
    "list",
    `<td class="sm-px" style="${cellStyle(theme)}">` +
      `<${tag} style="margin:0;padding-left:24px;">${items}</${tag}>` +
      `</td>`,
  );
}

export function emitImage(block: BlockOf<"image">, theme: Theme): string {
  const { src, alt, width, href, caption } = block.data;
  const align = block.align ?? "center";
  const margin =
    align === "center"
      ? "margin-left:auto;margin-right:auto;"
      : align === "right"
        ? "margin-left:auto;"
        : "margin-right:auto;";

  const img =
    `<img src="${escapeHtml(src)}" alt="${escapeHtml(alt)}"` +
    (width ? ` width="${escapeHtml(width.replace(/(px|%)$/, ""))}"` : "") +
    ` style="display:block;border:0;max-width:100%;height:auto;${width ? `width:${escapeHtml(width)};` : ""}${margin}">`;

  const linked = href
    ? `<a href="${escapeHtml(href)}" target="_blank">${img}</a>`
    : img;

  const cap = caption
    ? `<div style="margin-top:8px;font-size:14px;color:${theme.mutedColor};text-align:${align};">${escapeHtml(caption)}</div>`
    : "";

  return row(
    "image",
    `<td class="sm-px" align="${align}" style="padding:${theme.blockSpacing} ${GUTTER};${textStyle(theme)}">` +
      linked +
      cap +
      `</td>`,
  );
}

export function emitButton(block: BlockOf<"button">, theme: Theme): string {
  const { label, href, full } = block.data;
  const align = block.align ?? "center";
  // A square-cornered bulletproof table. VML would restore the radius in
  // Outlook 2016 and roughly double this emitter; it is purely additive later.
  // See `SPEC-block-compiler.md`, decision 2.
  return row(
    "button",
    `<td class="sm-px" align="${align}" style="padding:${theme.blockSpacing} ${GUTTER};">` +
      `<table role="presentation" cellpadding="0" cellspacing="0" border="0"` +
      ` style="${full ? "width:100%;" : "margin:auto;"}">` +
      `<tr><td align="center" style="background-color:${theme.buttonBg};border-radius:${theme.buttonRadius};">` +
      `<a href="${escapeHtml(href)}" target="_blank"` +
      ` style="display:inline-block;padding:12px 28px;font-family:${theme.fontFamily};font-size:${theme.fontSize};` +
      `line-height:1.2;font-weight:bold;color:${theme.buttonColor};text-decoration:none;border-radius:${theme.buttonRadius};">` +
      escapeHtml(label) +
      `</a></td></tr></table></td>`,
  );
}
