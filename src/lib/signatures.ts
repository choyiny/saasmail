/**
 * Helpers around the per-inbox HTML signature feature: the HTML/text
 * strippers the chat bubble uses when "Hide signatures in chat" is on.
 *
 * The preference itself is an account setting
 * (`layoutSettings.common.hideSignatures`, see useCommonSettings).
 */

/**
 * Strip the trailing signature block from an HTML email body. We look for
 * either a `<div data-signature>…</div>` (our own auto-attached marker) or
 * a `-- ` (RFC 3676) plain-text-style separator promoted to a block.
 */
export function stripSignatureFromHtml(html: string): string {
  if (!html) return html;
  // Cut anything from the first `<div data-signature` onward — that's
  // our marker for auto-attached signatures.
  const markerIdx = html.search(/<div[^>]*\bdata-signature\b/i);
  if (markerIdx >= 0) return html.slice(0, markerIdx).trimEnd();

  // Fallback: strip everything from a `-- ` separator at the start of a
  // block. Matches "<p>-- </p>" / "<p>--&nbsp;</p>" / "<br>-- ".
  const dashSepIdx = html.search(/<(p|div)[^>]*>\s*--(\s|&nbsp;|&#160;)/i);
  if (dashSepIdx >= 0) return html.slice(0, dashSepIdx).trimEnd();
  return html;
}

/** Same idea but for the plain-text body. */
export function stripSignatureFromText(text: string): string {
  if (!text) return text;
  // Standard "-- " line is the canonical email signature separator.
  const lines = text.split(/\r?\n/);
  const sepIdx = lines.findIndex((l) => l === "-- " || l === "--");
  if (sepIdx >= 0) {
    return lines.slice(0, sepIdx).join("\n").trimEnd();
  }
  return text;
}
