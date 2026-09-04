/**
 * Derive a readable text/plain part from rendered campaign HTML.
 *
 * Runs **once per campaign**, at snapshot time — not per recipient — so it can
 * afford to be careful. Written by hand rather than added as a dependency.
 *
 * Why bother at all: the existing transactional template path sends HTML-only
 * (`bodyText: null`), which is defensible for a one-off receipt. At marketing
 * scale it is not — an HTML-only bulk send is a spam signal, and without a text
 * part `send.ts`'s plain-text unsubscribe footer never runs, so text-only
 * readers get no way out.
 */

/** Block-level tags that should produce a line break in the text version. */
const BLOCK_TAGS =
  /<\/?(?:p|div|h[1-6]|li|tr|table|section|article|header|footer|blockquote|pre)\b[^>]*>/gi;

const DECODE: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'",
  "&nbsp;": " ",
};

function decodeEntities(s: string): string {
  return s
    .replace(/&(?:amp|lt|gt|quot|#39|apos|nbsp);/g, (m) => DECODE[m] ?? m)
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) =>
      String.fromCodePoint(Number.parseInt(hex, 16)),
    );
}

export function htmlToText(html: string): string {
  let text = html;

  // Drop anything whose content is not prose. Done first so their contents
  // cannot leak into the output as stray CSS or JS.
  text = text.replace(/<(script|style|head|template)\b[\s\S]*?<\/\1>/gi, "");
  text = text.replace(/<!--[\s\S]*?-->/g, "");

  // A link becomes "label (href)" so the destination survives — the whole point
  // of a text part is that it is readable without rendering.
  text = text.replace(
    /<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi,
    (_full, href: string, label: string) => {
      const cleanLabel = label.replace(/<[^>]+>/g, "").trim();
      if (cleanLabel === "") return href;
      // Don't duplicate when the label already *is* the URL.
      return cleanLabel === href ? href : `${cleanLabel} (${href})`;
    },
  );

  text = text.replace(/<br\s*\/?>/gi, "\n");
  text = text.replace(/<hr\s*\/?>/gi, "\n---\n");
  text = text.replace(BLOCK_TAGS, "\n");
  // Anything left is inline markup with no textual meaning.
  text = text.replace(/<[^>]+>/g, "");

  text = decodeEntities(text);

  return (
    text
      .split("\n")
      .map((line) => line.replace(/[ \t ]+/g, " ").trim())
      // Collapse runs of blank lines to a single one.
      .reduce<string[]>((acc, line) => {
        if (line === "" && acc[acc.length - 1] === "") return acc;
        acc.push(line);
        return acc;
      }, [])
      .join("\n")
      .trim()
  );
}
