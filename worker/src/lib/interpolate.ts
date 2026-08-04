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
 * Names are `[\w.]+`, so `{{not-a-var}}` does not match and survives as literal
 * text — the pre-rewrite behavior, which an existing test pins.
 */
const TAG =
  /\{\{\{\s*([#^/]?)\s*([\w.]+)\s*(\?)?\s*((?:\|\s*\w+\s*)*)\}\}\}|\{\{\s*([#^/]?)\s*([\w.]+)\s*(\?)?\s*((?:\|\s*\w+\s*)*)\}\}/g;

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

    const filters = (filterClause ?? "")
      .split("|")
      .map((f) => f.trim())
      .filter(Boolean);
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
function applyFilters(value: string, filters: string[]): string {
  return filters.reduce((acc, f) => FILTERS[f](acc), value);
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
 */
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
      name in frame
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

function renderNodes(nodes: Node[], stack: Frame[]): string {
  let out = "";
  for (const node of nodes) {
    if (node.kind === "text") {
      out += node.value;
      continue;
    }
    if (node.kind === "var") {
      const { found, value } = lookup(stack, node.name);
      if (!found) {
        // Optional tags collapse to nothing; required ones survive verbatim so
        // `renderTemplate`'s check is what fails the send, not a silent blank.
        out += node.optional ? "" : node.source;
        continue;
      }
      const text = node.raw ? stringify(value) : escapeHtml(stringify(value));
      out += applyFilters(text, node.filters);
      continue;
    }
    out += renderSection(node, stack);
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
): string {
  const { value } = lookup(stack, node.name);
  const truthy = isTruthy(value);

  if (node.inverted) return truthy ? "" : renderNodes(node.children, stack);
  if (!truthy) return "";

  if (Array.isArray(value)) {
    return value
      .map((item) => renderNodes(node.children, [...stack, item]))
      .join("");
  }
  if (value && typeof value === "object") {
    return renderNodes(node.children, [...stack, value]);
  }
  return renderNodes(node.children, stack);
}

/**
 * Render a template against a set of variables.
 *
 * Values are HTML-escaped by default; `{{{name}}}` opts a value out for
 * pre-rendered HTML chunks. Escaping applies to substituted values only — the
 * template's own markup and prose pass through untouched.
 */
export function interpolate(
  template: string,
  variables: TemplateVariables,
): string {
  return renderNodes(parse(template), [variables]);
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
  const sections: TemplateAnalysis["sections"] = [];

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
      (node.inverted || node.optional ? optional : required).add(node.name);
      const inner = new Set<string>();
      collectInner(node.children, inner);
      sections.push({
        name: node.name,
        inverted: node.inverted,
        variables: Array.from(inner),
      });
    }
  }

  for (const source of sources) walkTopLevel(parse(source));

  // A name that is required somewhere is required overall.
  for (const name of required) optional.delete(name);

  return {
    required: Array.from(required),
    optional: Array.from(optional),
    sections,
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
  const missingVariables = requiredVariables.filter((v) => !(v in variables));
  if (missingVariables.length > 0) {
    return { ok: false, missingVariables, requiredVariables };
  }

  return {
    ok: true,
    subject: interpolate(template.subject, variables),
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
