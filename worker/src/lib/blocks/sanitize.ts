/**
 * Inline-HTML sanitizer for block documents.
 *
 * Threat model
 * ------------
 * `data.html` and list items carry rich text authored in the block editor and
 * are emitted **raw** into compiled campaign HTML. That HTML is stored, frozen
 * into a campaign snapshot, and mailed to every subscriber. The template API
 * also accepts block documents directly, so a client-side sanitizer is not a
 * control — this runs on every write path.
 *
 * Why not `sanitizeSignatureHtml`
 * -------------------------------
 * That sanitizer is a *denylist* over `HTMLRewriter`, which makes it async and
 * Workers-only. The block compiler is pure and synchronous by contract (it runs
 * unchanged in the browser to render the editor preview), so neither property
 * is available here. The allowlist is also far narrower — eight tags — which
 * makes a stricter construction affordable.
 *
 * Strategy: allowlist, and **re-emit rather than patch**
 * -----------------------------------------------------
 * Nothing from the input reaches the output verbatim. The scanner walks the
 * string, and every token is either rebuilt from a known-good shape or dropped:
 *
 *   - Text is escaped, always.
 *   - An allowlisted tag is re-emitted from its parsed name and the subset of
 *     its attributes that survive validation. Attribute values are re-quoted
 *     and escaped.
 *   - Everything else — unknown tags, comments, doctypes, processing
 *     instructions, stray closers — is dropped, with any text between the tags
 *     kept and escaped.
 *
 * Because the output is constructed rather than filtered, a parser
 * disagreement between this scanner and a mail client cannot smuggle markup
 * through: a construct this scanner misreads becomes escaped text, not a tag.
 *
 * `{{variable}}` passes through untouched — braces are not HTML, and the
 * compiler never interprets them. See `docs/templates.md`.
 */

/** Tags that may appear, mapped to the attributes each may keep. */
const ALLOWED_ATTRS: Record<string, ReadonlySet<string>> = {
  b: new Set(),
  strong: new Set(),
  i: new Set(),
  em: new Set(),
  u: new Set(),
  s: new Set(),
  br: new Set(),
  a: new Set(["href"]),
  span: new Set(["style"]),
};

/** Elements with no closing tag. `br` is the only one we allow. */
const VOID_TAGS = new Set(["br"]);

/** Schemes permitted in an `href`. Everything else is dropped. */
const SAFE_HREF = /^(?:https?:\/\/|mailto:)/i;

/** An href that begins with a template tag is resolved at interpolation time. */
const TEMPLATE_TAG_PREFIX = /^\s*\{\{/;

/** `#rgb`, `#rrggbb`, or `rgb()` / `rgba()` with numeric arguments. */
const SAFE_COLOR =
  /^(?:#[0-9a-f]{3}|#[0-9a-f]{6}|rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*(?:,\s*(?:0|1|0?\.\d+)\s*)?\))$/i;

/** A well-formed character reference, which escaping must leave alone. */
const ENTITY = /^&(?:#\d{1,7}|#x[0-9a-f]{1,6}|[a-z][a-z0-9]{1,31});/i;

/**
 * Escape text for an HTML body.
 *
 * A bare `&` is escaped, but an existing well-formed character reference is
 * preserved — the editor emits `&amp;` and `&nbsp;`, and blindly escaping
 * would render them visibly as `&amp;amp;` after a save/load round trip.
 * Escaping is therefore idempotent, which the tests assert.
 */
function escapeText(input: string): string {
  let out = "";
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (ch === "&") {
      const rest = input.slice(i);
      const entity = ENTITY.exec(rest);
      if (entity) {
        out += entity[0];
        i += entity[0].length - 1;
      } else {
        out += "&amp;";
      }
    } else if (ch === "<") {
      out += "&lt;";
    } else if (ch === ">") {
      out += "&gt;";
    } else {
      out += ch;
    }
  }
  return out;
}

/** Escape a value destined for a double-quoted attribute. */
function escapeAttr(value: string): string {
  return escapeText(value).replace(/"/g, "&quot;");
}

/**
 * Strip characters that let a URL smuggle a scheme past `SAFE_HREF` —
 * tabs, newlines and other C0 controls are ignored by URL parsers, so
 * `java\nscript:` would otherwise survive the check and execute.
 */
function normalizeUrl(raw: string): string {
  return raw.replace(/[\u0000-\u0020\u007f]/g, "");
}

/** Validate one attribute, returning the value to emit or null to drop it. */
function cleanAttribute(
  tag: string,
  name: string,
  value: string,
): string | null {
  if (tag === "a" && name === "href") {
    const url = normalizeUrl(value);
    // A link whose target starts with a template tag has no scheme yet — it is
    // resolved at interpolation time. `{{unsubscribe_url}}` is the case that
    // matters: it appears in prose in almost every campaign, and a scheme check
    // here would silently strip the one link the mail is required to carry.
    // See the matching note on `UrlSchema` in `schema.ts`.
    if (TEMPLATE_TAG_PREFIX.test(url)) return url;
    return SAFE_HREF.test(url) ? url : null;
  }
  if (tag === "span" && name === "style") {
    // Only `color` survives, and only with a value we can prove is a colour.
    // Anything else — `expression()`, `url()`, a second declaration — is not
    // reconstructed, so it cannot reach the output.
    const match = /(?:^|;)\s*color\s*:\s*([^;]+)/i.exec(value);
    if (!match) return null;
    const color = match[1].trim();
    return SAFE_COLOR.test(color) ? `color:${color}` : null;
  }
  return null;
}

/** One parsed attribute from a start tag. */
const ATTR_RE =
  /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>=`]+)))?/g;

function emitStartTag(tag: string, attrText: string): string {
  const allowed = ALLOWED_ATTRS[tag];
  let out = `<${tag}`;
  if (allowed.size > 0) {
    ATTR_RE.lastIndex = 0;
    const seen = new Set<string>();
    let m: RegExpExecArray | null;
    while ((m = ATTR_RE.exec(attrText)) !== null) {
      const name = m[1].toLowerCase();
      if (!allowed.has(name) || seen.has(name)) continue;
      const raw = m[2] ?? m[3] ?? m[4] ?? "";
      const cleaned = cleanAttribute(tag, name, raw);
      if (cleaned === null) continue;
      seen.add(name);
      out += ` ${name}="${escapeAttr(cleaned)}"`;
    }
  }
  return out + ">";
}

/**
 * Sanitize an inline-HTML fragment. Never throws. Idempotent: sanitizing the
 * output again produces the same string, which is what makes it safe to run on
 * every write without the content drifting.
 */
export function sanitizeInlineHtml(input: string): string {
  if (!input) return "";

  let out = "";
  const open: string[] = [];
  let i = 0;

  while (i < input.length) {
    const lt = input.indexOf("<", i);
    if (lt === -1) {
      out += escapeText(input.slice(i));
      break;
    }
    if (lt > i) out += escapeText(input.slice(i, lt));

    const rest = input.slice(lt);

    // Comments, CDATA, doctypes and processing instructions are dropped whole.
    if (rest.startsWith("<!--")) {
      const end = input.indexOf("-->", lt + 4);
      i = end === -1 ? input.length : end + 3;
      continue;
    }
    if (rest.startsWith("<!") || rest.startsWith("<?")) {
      const end = input.indexOf(">", lt + 1);
      i = end === -1 ? input.length : end + 1;
      continue;
    }

    const close = /^<\/\s*([a-zA-Z][a-zA-Z0-9]*)\s*>/.exec(rest);
    if (close) {
      const tag = close[1].toLowerCase();
      i = lt + close[0].length;
      // Ignore a closer with no matching opener; close through any tags left
      // open inside it so the output stays balanced.
      const depth = open.lastIndexOf(tag);
      if (depth !== -1) {
        for (let d = open.length - 1; d >= depth; d--) out += `</${open[d]}>`;
        open.length = depth;
      }
      continue;
    }

    const start = /^<([a-zA-Z][a-zA-Z0-9]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/.exec(
      rest,
    );
    if (start) {
      const tag = start[1].toLowerCase();
      i = lt + start[0].length;
      if (!Object.prototype.hasOwnProperty.call(ALLOWED_ATTRS, tag)) continue;
      out += emitStartTag(tag, start[2] ?? "");
      if (!VOID_TAGS.has(tag)) open.push(tag);
      continue;
    }

    // A `<` that begins nothing parseable is literal text.
    out += "&lt;";
    i = lt + 1;
  }

  for (let d = open.length - 1; d >= 0; d--) out += `</${open[d]}>`;
  return out;
}
