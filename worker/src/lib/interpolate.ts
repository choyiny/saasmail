/** Any value a template variable can carry. */
export type TemplateValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | TemplateValue[]
  | { [key: string]: TemplateValue };

export type TemplateVariables = Record<string, TemplateValue>;

/** Thrown when a template's section tags are unbalanced or a filter is unknown. */
export class TemplateParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TemplateParseError";
  }
}

/**
 * Escape the five characters that are significant in HTML text and in both
 * quoting styles for attribute values.
 *
 * This is one character stricter than the helper in `inbound-forward.ts`,
 * which omits `'` — single-quoted attributes are a real escape context in
 * email HTML, so a value landing in one must not be able to close it.
 */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Value filters. Deliberately a fixed one-entry registry, not a pipeline. */
const FILTERS: Record<string, (s: string) => string> = {
  nl2br: (s) => s.replace(/\r\n|\r|\n/g, "<br>"),
};

/**
 * Filters whose output is HTML and which are therefore skipped in plain-text
 * render mode (see `InterpolateOptions.escape`). `nl2br` emits a `<br>` tag;
 * running it while rendering a Subject header would put the literal characters
 * `<br>` in front of the recipient. Skipping leaves the value's own newlines
 * intact, which is the closest thing to "no formatting applied".
 */
const HTML_ONLY_FILTERS = new Set(["nl2br"]);

export type Token =
  | { kind: "text"; value: string }
  | {
      kind: "var";
      name: string;
      raw: boolean;
      optional: boolean;
      filters: string[];
      source: string;
    }
  | {
      kind: "open";
      name: string;
      inverted: boolean;
      optional: boolean;
      source: string;
    }
  | { kind: "close"; name: string; source: string };

/*
 * Tag grammar, as two fully separate alternatives rather than one pattern
 * with independently-optional third braces: a strict `{{{...}}}` raw form
 * and a strict `{{...}}` form. Each requires an exact, matching brace count
 * on both ends. In order within each: an optional `#`/`^`/`/` sigil, the
 * name (word characters, or a bare `.` for the current item), an optional
 * `?` marking it optional, and zero or more `|filter` clauses.
 *
 * Keeping the two forms from sharing a group means a lone extra `{` or `}`
 * sitting next to a *different* tag can no longer get folded into that
 * tag's brace count (an earlier single-pattern version did this, matching
 * `{{{` + `name` + `}}` as a bogus "almost raw" tag).
 *
 * This does NOT reproduce the legacy flat-regex reading of 3+ consecutive
 * braces, and cannot: the legacy renderer had no raw syntax, so it read
 * `{{{name}}}` as literal `{` + tag `{{name}}` + literal `}`. Supporting
 * `{{{raw}}}` means this tokenizer reads the same input as one raw tag
 * instead. Those two readings are mutually exclusive by construction —
 * any template with a 3+ brace run necessarily changes meaning under the
 * new syntax. That divergence is intentional and documented; see the
 * "brace-run behavior" tests in interpolate-compat.test.ts for exactly
 * what the new tokenizer does on inputs like `{{{name}}}` and
 * `{{{{name}}}}`, and the differential fuzz in the same file for why it
 * excludes 3+ brace runs from the legacy-identity check instead of
 * asserting a property the feature deliberately breaks.
 *
 * A name is `\w+` or a bare `.`, with NO whitespace anywhere inside the tag —
 * not between the braces and the sigil, the sigil and the name, the name and
 * `?`/`|`/the closing braces. That is deliberately as strict as the legacy
 * `/\{\{(\w+)\}\}/g`, which left `{{ spaced }}`, `{{dotted.name}}`, and
 * `{{not-a-var}}` alone as literal text. Being laxer would silently promote
 * prose like `{{ note }}` in a stored template into a REQUIRED variable and
 * start rejecting sends for a name the caller never heard of, and would read
 * `{{user.name}}` as a flat key literally named `"user.name"` rather than the
 * Mustache path it looks like. Neither is worth the convenience; anything
 * that does not match survives as text exactly as it did before the rewrite.
 */
const TAG =
  /\{\{\{([#^/]?)(\w+|\.)(\?)?((?:\|\w+)*)\}\}\}|\{\{([#^/]?)(\w+|\.)(\?)?((?:\|\w+)*)\}\}/g;

export function tokenize(template: string): Token[] {
  const tokens: Token[] = [];
  let lastIndex = 0;
  TAG.lastIndex = 0;

  let match: RegExpExecArray | null;
  while ((match = TAG.exec(template)) !== null) {
    const [
      source,
      rawSigil,
      rawName,
      rawOptional,
      rawFilterClause,
      plainSigil,
      plainName,
      plainOptional,
      plainFilterClause,
    ] = match;

    const raw = rawName !== undefined;
    const sigil = raw ? rawSigil : plainSigil;
    const name = raw ? rawName : plainName;
    const optional = raw ? rawOptional : plainOptional;
    const filterClause = raw ? rawFilterClause : plainFilterClause;

    if (match.index > lastIndex) {
      tokens.push({
        kind: "text",
        value: template.slice(lastIndex, match.index),
      });
    }
    lastIndex = match.index + source.length;

    if (sigil === "/") {
      tokens.push({ kind: "close", name, source });
      continue;
    }
    if (sigil === "#" || sigil === "^") {
      tokens.push({
        kind: "open",
        name,
        inverted: sigil === "^",
        optional: Boolean(optional),
        source,
      });
      continue;
    }

    // The clause is a run of `|name` with no whitespace, so splitting is
    // enough; the leading empty segment is what `filter(Boolean)` drops.
    const filters = (filterClause ?? "").split("|").filter(Boolean);
    for (const f of filters) {
      if (!(f in FILTERS)) {
        throw new TemplateParseError(
          `Unknown filter "${f}" in ${source}. Available filters: ${Object.keys(FILTERS).join(", ")}.`,
        );
      }
    }

    tokens.push({
      kind: "var",
      name,
      raw,
      optional: Boolean(optional),
      filters,
      source,
    });
  }

  if (lastIndex < template.length) {
    tokens.push({ kind: "text", value: template.slice(lastIndex) });
  }
  return tokens;
}

/** Apply a tag's filters to an already-escaped (or deliberately raw) value. */
function applyFilters(
  value: string,
  filters: string[],
  escape: boolean,
): string {
  return filters.reduce(
    (acc, f) => (!escape && HTML_ONLY_FILTERS.has(f) ? acc : FILTERS[f](acc)),
    value,
  );
}

/** A scope frame in the context stack. */
type Frame = TemplateValue;

interface Lookup {
  found: boolean;
  value: TemplateValue;
}

/**
 * Resolve a name against the context stack, innermost frame first, so a
 * section body can reference both its own item's fields and top-level values.
 *
 * Membership is `hasOwn`, not `in`: `in` walks the prototype chain, so
 * `{{constructor}}` / `{{toString}}` / `{{hasOwnProperty}}` would resolve to
 * built-in functions nobody supplied. Section frames come straight from
 * caller-supplied JSON, so this is the only line keeping inherited members out.
 */
function hasOwn(obj: object, name: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, name);
}

function lookup(stack: Frame[], name: string): Lookup {
  if (name === ".") {
    return { found: stack.length > 0, value: stack[stack.length - 1] };
  }
  for (let i = stack.length - 1; i >= 0; i--) {
    const frame = stack[i];
    if (
      frame &&
      typeof frame === "object" &&
      !Array.isArray(frame) &&
      hasOwn(frame, name)
    ) {
      return {
        found: true,
        value: (frame as Record<string, TemplateValue>)[name],
      };
    }
  }
  return { found: false, value: undefined };
}

function stringify(value: TemplateValue): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") return "";
  return String(value);
}

/** Render-time settings threaded down the tree. */
interface RenderContext {
  /** HTML-escape substituted values. False for plain-text output. */
  escape: boolean;
  /**
   * True while rendering a section body.
   *
   * It changes what an unresolved variable does. At top level, an unfound name
   * survives as its own source text because `renderTemplate` refuses to send
   * such a template at all — the verbatim `{{token}}` is a debugging signal
   * that never reaches a recipient. Inside a section it is the opposite: those
   * names resolve per item and are deliberately never `required`, so nothing
   * upstream catches them, and emitting the source would mail a literal
   * `{{empty_msg}}` to a customer. Inside a section, unfound renders empty.
   */
  inSection: boolean;
}

function renderNodes(
  nodes: Node[],
  stack: Frame[],
  ctx: RenderContext,
): string {
  let out = "";
  for (const node of nodes) {
    if (node.kind === "text") {
      out += node.value;
      continue;
    }
    if (node.kind === "var") {
      const { found, value } = lookup(stack, node.name);
      if (!found) {
        // Optional tags collapse to nothing; so do section-body tags (see
        // `RenderContext.inSection`). A required top-level one survives
        // verbatim so `renderTemplate`'s check fails the send rather than
        // mailing a silent blank.
        out += node.optional || ctx.inSection ? "" : node.source;
        continue;
      }
      const text =
        node.raw || !ctx.escape
          ? stringify(value)
          : escapeHtml(stringify(value));
      out += applyFilters(text, node.filters, ctx.escape);
      continue;
    }
    out += renderSection(node, stack, ctx);
  }
  return out;
}

/**
 * A section's value decides whether its body renders, and how many times.
 * Arrays are the interesting case: non-empty arrays iterate, empty arrays are
 * falsy — which is what makes `{{^items}}` a usable "nothing here yet" branch.
 */
function isTruthy(value: TemplateValue): boolean {
  if (Array.isArray(value)) return value.length > 0;
  if (value === null || value === undefined) return false;
  if (typeof value === "object") return true;
  return Boolean(value);
}

function renderSection(
  node: Extract<Node, { kind: "section" }>,
  stack: Frame[],
  ctx: RenderContext,
): string {
  const { value } = lookup(stack, node.name);
  const truthy = isTruthy(value);
  const inner: RenderContext = ctx.inSection
    ? ctx
    : { ...ctx, inSection: true };

  if (node.inverted)
    return truthy ? "" : renderNodes(node.children, stack, inner);
  if (!truthy) return "";

  if (Array.isArray(value)) {
    return value
      .map((item) => renderNodes(node.children, [...stack, item], inner))
      .join("");
  }
  if (value && typeof value === "object") {
    return renderNodes(node.children, [...stack, value], inner);
  }
  return renderNodes(node.children, stack, inner);
}

export interface InterpolateOptions {
  /**
   * HTML-escape substituted values. Defaults to true.
   *
   * Set false for plain-text output. A Subject header is plain text, not
   * HTML: escaping it would mail a literal `O&#39;Brien` to a recipient
   * whose name is `O'Brien`. In this mode `{{key}}` and `{{{key}}}` are
   * equivalent, and HTML-emitting filters such as `nl2br` are skipped.
   */
  escape?: boolean;
}

/**
 * Render a template against a set of variables.
 *
 * Values are HTML-escaped by default; `{{{name}}}` opts a value out for
 * pre-rendered HTML chunks, and `{ escape: false }` opts the whole render out
 * for plain-text destinations. Escaping applies to substituted values only —
 * the template's own markup and prose pass through untouched.
 */
export function interpolate(
  template: string,
  variables: TemplateVariables,
  options: InterpolateOptions = {},
): string {
  return renderNodes(parse(template), [variables], {
    escape: options.escape !== false,
    inSection: false,
  });
}

export interface TemplateAnalysis {
  /** Names the caller must supply or the send fails. */
  required: string[];
  /** Names that render empty when absent. */
  optional: string[];
  /** Sections and the names their bodies reference, for the editor and API. */
  sections: Array<{ name: string; inverted: boolean; variables: string[] }>;
}

/**
 * Describe what a template needs.
 *
 * The split matters: a name inside a section body resolves against the section
 * item at render time, so it is NOT something the caller supplies at the top
 * level. Reporting those as required would fail every send that uses a section.
 *
 * A regular `{{#items}}` IS required — absent, it renders nothing and a digest
 * goes out silently empty. An inverted `{{^items}}` is not, since handling
 * absence is its purpose. `{{#items?}}` opts a regular section out.
 */
export function analyzeTemplate(...sources: string[]): TemplateAnalysis {
  const required = new Set<string>();
  const optional = new Set<string>();
  // Keyed by name so the same section appearing in multiple sources (e.g. a
  // subject and body both using {{#items}}) merges into one entry instead of
  // being reported twice. A Map preserves insertion order, so output stays
  // stable by first appearance.
  const sectionsByName = new Map<
    string,
    TemplateAnalysis["sections"][number]
  >();

  /** Collect names referenced anywhere beneath a section, at any depth. */
  function collectInner(nodes: Node[], into: Set<string>): void {
    for (const node of nodes) {
      if (node.kind === "var") {
        if (node.name !== ".") into.add(node.name);
      } else if (node.kind === "section") {
        into.add(node.name);
        collectInner(node.children, into);
      }
    }
  }

  function walkTopLevel(nodes: Node[]): void {
    for (const node of nodes) {
      if (node.kind === "text") continue;
      if (node.kind === "var") {
        if (node.name === ".") continue;
        (node.optional ? optional : required).add(node.name);
        continue;
      }
      // `{{#.}}` iterates the current item, exactly as `{{.}}` renders it —
      // there is no top-level name to supply, so requiring "." would make the
      // template permanently unsendable.
      if (node.name !== ".") {
        (node.inverted || node.optional ? optional : required).add(node.name);
      }
      const inner = new Set<string>();
      collectInner(node.children, inner);

      const existing = sectionsByName.get(node.name);
      if (existing) {
        for (const v of inner) {
          if (!existing.variables.includes(v)) existing.variables.push(v);
        }
      } else {
        sectionsByName.set(node.name, {
          name: node.name,
          inverted: node.inverted,
          variables: Array.from(inner),
        });
      }
    }
  }

  for (const source of sources) walkTopLevel(parse(source));

  // A name that is required somewhere is required overall.
  for (const name of required) optional.delete(name);

  return {
    required: Array.from(required),
    optional: Array.from(optional),
    sections: Array.from(sectionsByName.values()),
  };
}

/**
 * Names a caller must supply. Kept as the pre-rewrite entry point so existing
 * call sites keep working; it is exactly the analysis's `required` set.
 */
export function extractVariables(template: string): string[] {
  return analyzeTemplate(template).required;
}

export type RenderTemplateResult =
  | { ok: true; subject: string; bodyHtml: string }
  | {
      ok: false;
      missingVariables: string[];
      requiredVariables: string[];
      parseError?: string;
    };

/**
 * Validate that every required variable was supplied, then render.
 *
 * Missing variables are reported rather than silently left as `{{token}}` so
 * callers fail the send instead of mailing a half-rendered template.
 */
export function renderTemplate(
  template: { subject: string; bodyHtml: string },
  variables: TemplateVariables,
): RenderTemplateResult {
  let analysis: TemplateAnalysis;
  try {
    analysis = analyzeTemplate(template.subject, template.bodyHtml);
  } catch (err) {
    if (err instanceof TemplateParseError) {
      return {
        ok: false,
        missingVariables: [],
        requiredVariables: [],
        parseError: err.message,
      };
    }
    throw err;
  }

  const requiredVariables = analysis.required;
  // `hasOwn`, not `in`: `in` would count inherited members like `constructor`
  // as "supplied" and let a send proceed with a variable nobody passed.
  const missingVariables = requiredVariables.filter(
    (v) => !Object.prototype.hasOwnProperty.call(variables, v),
  );
  if (missingVariables.length > 0) {
    return { ok: false, missingVariables, requiredVariables };
  }

  return {
    ok: true,
    // The subject is a plain-text header, not HTML — rendering it through the
    // escaping path would put `&amp;` and `&#39;` in front of a recipient.
    subject: interpolate(template.subject, variables, { escape: false }),
    bodyHtml: interpolate(template.bodyHtml, variables),
  };
}

export type Node =
  | { kind: "text"; value: string }
  | {
      kind: "var";
      name: string;
      raw: boolean;
      optional: boolean;
      filters: string[];
      source: string;
    }
  | {
      kind: "section";
      name: string;
      inverted: boolean;
      optional: boolean;
      children: Node[];
    };

/**
 * Maximum section nesting depth.
 *
 * `parse` itself is iterative, but rendering and `analyzeTemplate`'s inner
 * collection both recurse once per level, so an arbitrarily deep template
 * would overflow the stack — a `RangeError` escaping as an unhandled 500 from
 * `/variables` or a send, and workerd's stack is smaller than Node's. Nothing
 * validates a template's balance at save time, so an admin can store one.
 * Capping here turns that into a `TemplateParseError`, which every caller
 * already handles. Real templates nest a handful of levels; 64 is far beyond
 * anything hand-written.
 */
export const MAX_SECTION_DEPTH = 64;

/**
 * Fold the token stream into a tree.
 *
 * Unbalanced or mismatched section tags are a parse error rather than a
 * best-effort render: silently mis-nesting would produce a plausible-looking
 * email with the wrong content, which is worse than a failed send.
 */
export function parse(template: string): Node[] {
  const root: Node[] = [];
  const stack: Array<{
    node: Extract<Node, { kind: "section" }>;
    source: string;
  }> = [];

  const currentChildren = () =>
    stack.length === 0 ? root : stack[stack.length - 1].node.children;

  for (const token of tokenize(template)) {
    switch (token.kind) {
      case "text":
      case "var":
        currentChildren().push(token);
        break;
      case "open": {
        if (stack.length >= MAX_SECTION_DEPTH) {
          throw new TemplateParseError(
            `Sections nested too deeply at ${token.source} — the limit is ${MAX_SECTION_DEPTH} levels.`,
          );
        }
        const node: Extract<Node, { kind: "section" }> = {
          kind: "section",
          name: token.name,
          inverted: token.inverted,
          optional: token.optional,
          children: [],
        };
        currentChildren().push(node);
        stack.push({ node, source: token.source });
        break;
      }
      case "close": {
        const open = stack.pop();
        if (!open) {
          throw new TemplateParseError(
            `Unexpected ${token.source} — no section is open here.`,
          );
        }
        if (open.node.name !== token.name) {
          throw new TemplateParseError(
            `${token.source} does not match the open section ${open.source}.`,
          );
        }
        break;
      }
    }
  }

  if (stack.length > 0) {
    throw new TemplateParseError(
      `Unclosed section ${stack[stack.length - 1].source} — add a matching {{/${stack[stack.length - 1].node.name}}}.`,
    );
  }

  return root;
}
