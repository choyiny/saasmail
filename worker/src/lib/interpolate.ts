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
 * Tag grammar, in order: optional third `{` for raw output, an optional
 * `#`/`^`/`/` sigil, the name (word characters, or a bare `.` for the current
 * item), an optional `?` marking it optional, zero or more `|filter` clauses,
 * and a matching third `}` when the tag opened with one.
 *
 * Names are `[\w.]+`, so `{{not-a-var}}` does not match and survives as literal
 * text — the pre-rewrite behavior, which an existing test pins.
 */
const TAG =
  /\{\{(\{)?\s*([#^/]?)\s*([\w.]+)\s*(\?)?\s*((?:\|\s*\w+\s*)*)(\})?\}\}/g;

export function tokenize(template: string): Token[] {
  const tokens: Token[] = [];
  let lastIndex = 0;
  TAG.lastIndex = 0;

  let match: RegExpExecArray | null;
  while ((match = TAG.exec(template)) !== null) {
    const [source, rawOpen, sigil, name, optional, filterClause, rawClose] =
      match;

    // A tag that opened with `{{{` must close with `}}}`. When the brace counts
    // disagree it is not a tag at all — emit it as text.
    if (Boolean(rawOpen) !== Boolean(rawClose)) continue;

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
      raw: Boolean(rawOpen),
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

/**
 * Replace {{variableName}} tokens with values from the variables object.
 * Unmatched tokens are left as-is.
 */
export function interpolate(
  template: string,
  variables: Record<string, string>,
): string {
  return template.replace(VARIABLE_REGEX, (match, key) => {
    return key in variables ? variables[key] : match;
  });
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
