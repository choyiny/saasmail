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
 * Keeping the two forms from sharing a group is deliberate: an earlier
 * single-pattern version let a lone extra `{` or `}` sitting next to a
 * *different* tag get folded into that tag's brace count (e.g. matching
 * `{{{` + `name` + `}}` as a bogus "almost raw" tag), which is exactly the
 * situation that arises when a literal `{{`/`}}` happens to sit next to a
 * real tag. With this form, `{{{{x}}` fails the raw alternative outright
 * (only 2 of the 3 required opening braces belong to it) and falls through
 * to the plain alternative, which finds `{{x}}` starting two characters in.
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

    // Even with the two brace forms kept separate, a tag can still sit
    // directly against *extra* braces that belong to neither alternative —
    // e.g. the `{{` in `{{{{x}}` that isn't part of `{{x}}`, or the trailing
    // `}}` in `{{date}}}}`. An even run of those pairs off into its own
    // literal `{{`/`}}` text, exactly as the legacy regex would leave it.
    // An odd leftover (as in `{{{name}}`, one brace short of a raw close)
    // means the tag boundary itself is ambiguous, so the whole run —
    // leftover braces and the tag content alike — is left as literal text
    // rather than guessing which tag was meant.
    let leadStart = match.index;
    while (leadStart > 0 && template[leadStart - 1] === "{") leadStart--;
    const leadingExtra = match.index - leadStart;

    const matchEnd = match.index + source.length;
    let trailEnd = matchEnd;
    while (trailEnd < template.length && template[trailEnd] === "}") {
      trailEnd++;
    }
    const trailingExtra = trailEnd - matchEnd;

    if (leadingExtra % 2 !== 0 || trailingExtra % 2 !== 0) {
      // Retry from just past this match's own start — not `trailEnd` —
      // so a smaller, valid match nested inside the same brace run still
      // gets a chance. E.g. `{{{{url}}}}` rejects the 3-brace raw reading
      // (one stray `{` and one stray `}` outside it, both odd) but must
      // still find the plain `{{url}}` starting two characters later.
      TAG.lastIndex = match.index + 1;
      continue;
    }

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

const VARIABLE_REGEX = /\{\{(\w+)\}\}/g;

/**
 * Extract unique variable names from a template string.
 */
export function extractVariables(template: string): string[] {
  const vars = new Set<string>();
  let match: RegExpExecArray | null;
  while ((match = VARIABLE_REGEX.exec(template)) !== null) {
    vars.add(match[1]);
  }
  return Array.from(vars);
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

/** Placeholder until Task 5 — sections render as nothing. */
function renderSection(
  _node: Extract<Node, { kind: "section" }>,
  _stack: Frame[],
): string {
  return "";
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

export type RenderTemplateResult =
  | { ok: true; subject: string; bodyHtml: string }
  | { ok: false; missingVariables: string[]; requiredVariables: string[] };

/**
 * Validate that every variable a template references was supplied, then
 * interpolate its subject and body.
 *
 * Missing variables are reported rather than silently left as `{{token}}`
 * so callers can fail the send instead of mailing a half-rendered template.
 */
export function renderTemplate(
  template: { subject: string; bodyHtml: string },
  variables: Record<string, string>,
): RenderTemplateResult {
  const subjectVars = extractVariables(template.subject);
  const bodyVars = extractVariables(template.bodyHtml);
  const requiredVariables = Array.from(new Set([...subjectVars, ...bodyVars]));
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
