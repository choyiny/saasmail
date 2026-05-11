/**
 * Server-side sanitizer for per-inbox `signature_html`.
 *
 * Threat model
 * ------------
 * Signatures are authored by an admin (TipTap UI) but rendered into
 * every member's compose drawer via dangerouslySetInnerHTML AND
 * concatenated into outbound email bodies sent to external recipients.
 * A compromised admin token therefore escalates to:
 *   1) Stored XSS for every member viewing a compose/reply tray.
 *   2) HTML payload in every outbound email this org sends.
 *
 * Strategy
 * --------
 * Denylist via Cloudflare's built-in HTMLRewriter — no extra
 * dependencies, no postcss bundle hit, Worker-native streaming
 * parser. We strip:
 *
 *   - Dangerous tags wholesale (script/style/iframe/object/embed/
 *     form/input/button/meta/link/svg/math/video/audio/source).
 *   - Every `on*` event-handler attribute on every element.
 *   - `style` attributes (CSS can carry expression()/url()/data: in
 *     legacy renderers; for signatures the loss is acceptable).
 *   - `javascript:` and non-http(s)/data: image URLs in `href`/`src`.
 *
 * Client-side render still wraps the result with `sanitizeEmailHtml`
 * (DOMPurify) as defense in depth — if a payload slips this layer it
 * still won't execute in any browser path. The server sanitizer
 * additionally protects the *outgoing-email* path that bypasses the
 * browser sanitizer entirely.
 */

const DENY_TAGS = new Set([
  "script",
  "style",
  "iframe",
  "object",
  "embed",
  "form",
  "input",
  "button",
  "select",
  "textarea",
  "meta",
  "link",
  "base",
  "svg",
  "math",
  "video",
  "audio",
  "source",
  "track",
  "noscript",
  "frame",
  "frameset",
]);

/** Maximum stored length for a signature. Cheap DoS guard + sanity
 *  cap; the user-facing editor is for short HTML, not full pages. */
export const MAX_SIGNATURE_HTML_LENGTH = 20_000;

/**
 * Sanitize a signature HTML blob into a safe-to-render-and-send
 * string. Returns the cleaned HTML; never throws on malformed input.
 * Idempotent — running it twice produces the same output.
 *
 * NOTE: HTMLRewriter requires a streaming Response source, hence the
 * Response wrapper + text() at the end. We wrap the input in a known
 * envelope so we can strip it back out without depending on
 * HTMLRewriter's normalization choices (it does not add html/head/
 * body when handed a fragment, but the wrapper makes the boundaries
 * unambiguous regardless of HTMLRewriter version).
 */
export async function sanitizeSignatureHtml(input: string): Promise<string> {
  if (!input) return "";
  // Hard length cap before parsing — keeps us O(n) with a known n.
  const trimmed =
    input.length > MAX_SIGNATURE_HTML_LENGTH
      ? input.slice(0, MAX_SIGNATURE_HTML_LENGTH)
      : input;

  const SENTINEL_OPEN = "<saasmail-sig-root>";
  const SENTINEL_CLOSE = "</saasmail-sig-root>";
  const wrapped = `${SENTINEL_OPEN}${trimmed}${SENTINEL_CLOSE}`;

  const response = new Response(wrapped, {
    headers: { "content-type": "text/html" },
  });

  const transformed = new HTMLRewriter()
    .on("*", {
      element(el) {
        const tag = el.tagName.toLowerCase();
        // Skip our sentinel wrapper itself.
        if (tag === "saasmail-sig-root") return;

        if (DENY_TAGS.has(tag)) {
          el.remove();
          return;
        }

        // Iterate a snapshot of attributes so removals during the loop
        // don't desync the iterator (HTMLRewriter's attribute iterator
        // is live).
        const attrs: Array<[string, string]> = [];
        for (const [name, value] of el.attributes) {
          attrs.push([name, value]);
        }
        for (const [name, value] of attrs) {
          const lower = name.toLowerCase();
          // Event handlers — onclick, onload, onerror, … always
          // dangerous. Strip every on* attribute.
          if (lower.startsWith("on")) {
            el.removeAttribute(name);
            continue;
          }
          // Strip style — CSS expressions + url(javascript:…) can
          // both execute in older renderers; not worth the surface.
          if (lower === "style") {
            el.removeAttribute(name);
            continue;
          }
          // href: block javascript: / vbscript: / data: schemes.
          if (lower === "href") {
            const v = value.trim().toLowerCase();
            if (
              v.startsWith("javascript:") ||
              v.startsWith("vbscript:") ||
              v.startsWith("data:")
            ) {
              el.removeAttribute(name);
            }
            continue;
          }
          // src: same, except data:image/* (inline images) is allowed.
          if (lower === "src") {
            const v = value.trim().toLowerCase();
            const isDangerous =
              v.startsWith("javascript:") || v.startsWith("vbscript:");
            const isDataNotImage =
              v.startsWith("data:") && !v.startsWith("data:image/");
            if (isDangerous || isDataNotImage) {
              el.removeAttribute(name);
            }
            continue;
          }
          // srcset can carry data: payloads too — strip to be safe.
          if (lower === "srcset") {
            el.removeAttribute(name);
            continue;
          }
        }
      },
    })
    .transform(response);

  const cleaned = await transformed.text();

  // Strip the sentinel wrapper. HTMLRewriter preserves custom tags as
  // literal text, so the open/close markers are still in the output.
  const openIdx = cleaned.indexOf(SENTINEL_OPEN);
  const closeIdx = cleaned.lastIndexOf(SENTINEL_CLOSE);
  if (openIdx === -1 || closeIdx === -1) {
    return cleaned; // pathological — return whatever we got, still sanitized
  }
  return cleaned.slice(openIdx + SENTINEL_OPEN.length, closeIdx);
}
