/**
 * Browser-side template analysis and preview rendering.
 *
 * This is a deliberate, hand-kept-in-sync duplicate of the tokenize → parse →
 * render pipeline in `worker/src/lib/interpolate.ts`. Worker code is not
 * importable from the browser bundle (it pulls in Cloudflare-only globals
 * elsewhere in the worker tree), so the editor gets its own copy of just the
 * grammar and semantics it needs: what a template requires, and what it
 * looks like once filled in.
 *
 * KEEP THESE TWO FILES IN SYNC. If you change tag grammar, escaping rules,
 * filters, or section semantics in `interpolate.ts`, mirror the change here
 * — `worker/src/__tests__/interpolate*.test.ts` is the source of truth this
 * file must agree with. There is no shared package (yet); this comment is
 * the contract.
 */

/** Any value a template variable can carry. Mirrors `TemplateValue`. */
type TemplateValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | TemplateValue[]
  | { [key: string]: TemplateValue };

/** Describes what a template needs and offers, for the editor UI. */
export interface TemplateAnalysis {
  /** Top-level names the caller must supply, or the send fails. */
  required: string[];
  /** Names that render empty when absent: `{{key?}}` and inverted sections. */
  optional: string[];
  /** Sections and the names their bodies reference (informational only —
   *  those inner names resolve per item at render time, never validated). */
  sections: Array<{ name: string; inverted: boolean; variables: string[] }>;
}

/** Thrown for unbalanced sections or an unknown filter — mirrors `TemplateParseError`. */
class TemplateSyntaxError extends Error {}

/**
 * Escape the five characters significant in HTML text and both attribute
 * quoting styles. Mirrors `escapeHtml` in interpolate.ts exactly.
 */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Value filters. Mirrors the fixed one-entry registry in interpolate.ts. */
const FILTERS: Record<string, (s: string) => string> = {
  nl2br: (s) => s.replace(/\r\n|\r|\n/g, "<br>"),
};

type Token =
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
 * Same two-alternate grammar as interpolate.ts's `TAG`: a strict `{{{...}}}`
 * raw form and a strict `{{...}}` form, each requiring an exact matching
 * brace count. A name is `\w+` or a bare `.` — no whitespace anywhere inside
 * the tag, no dots in a real name. `{{ spaced }}` and `{{a.b}}` are left
 * alone as literal text, exactly like the renderer, so the editor never
 * flags a name the API wouldn't actually require.
 */
const TAG =
  /\{\{\{([#^/]?)(\w+|\.)(\?)?((?:\|\w+)*)\}\}\}|\{\{([#^/]?)(\w+|\.)(\?)?((?:\|\w+)*)\}\}/g;

function tokenize(template: string): Token[] {
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

    const filters = (filterClause ?? "").split("|").filter(Boolean);
    for (const f of filters) {
      if (!(f in FILTERS)) {
        throw new TemplateSyntaxError(
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

type Node =
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

/** Mirrors `MAX_SECTION_DEPTH` in interpolate.ts. */
const MAX_SECTION_DEPTH = 64;

/** Fold the token stream into a tree. Mirrors `parse` in interpolate.ts. */
function parse(template: string): Node[] {
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
          throw new TemplateSyntaxError(
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
          throw new TemplateSyntaxError(
            `Unexpected ${token.source} — no section is open here.`,
          );
        }
        if (open.node.name !== token.name) {
          throw new TemplateSyntaxError(
            `${token.source} does not match the open section ${open.source}.`,
          );
        }
        break;
      }
    }
  }

  if (stack.length > 0) {
    throw new TemplateSyntaxError(
      `Unclosed section ${stack[stack.length - 1].source} — add a matching {{/${stack[stack.length - 1].node.name}}}.`,
    );
  }

  return root;
}

/**
 * Describe what a template needs and offers. Mirrors `analyzeTemplate` in
 * interpolate.ts, including the recursive descendant collection: a
 * section's `variables` list includes names from sub-sections nested inside
 * it too, because only the outermost section of a nest is a top-level
 * caller contract — the same reason nested sections don't get their own
 * top-level `sections` entry here either.
 */
export function analyzeTemplateClient(...sources: string[]): TemplateAnalysis {
  const required = new Set<string>();
  const optional = new Set<string>();
  const sectionsByName = new Map<
    string,
    TemplateAnalysis["sections"][number]
  >();

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
 * Placeholder values so the live preview renders sections as content
 * instead of showing literal `{{#items}}` tags. Two items per section so a
 * loop visibly repeats rather than looking like a single conditional block.
 */
export function sampleValues(
  analysis: TemplateAnalysis,
): Record<string, unknown> {
  const vars: Record<string, unknown> = {};
  for (const name of [...analysis.required, ...analysis.optional]) {
    vars[name] = `<${name}>`;
  }
  for (const section of analysis.sections) {
    vars[section.name] = [0, 1].map(() =>
      Object.fromEntries(section.variables.map((v) => [v, `<${v}>`])),
    );
  }
  return vars;
}

/* ------------------------------- rendering ------------------------------- */
/* Mirrors renderNodes/renderSection/lookup/isTruthy/stringify in
 * interpolate.ts. Preview only ever renders the HTML body, so — unlike the
 * worker, which also renders a plain-text subject — this always escapes. */

type Frame = TemplateValue;

interface Lookup {
  found: boolean;
  value: TemplateValue;
}

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

function isTruthy(value: TemplateValue): boolean {
  if (Array.isArray(value)) return value.length > 0;
  if (value === null || value === undefined) return false;
  if (typeof value === "object") return true;
  return Boolean(value);
}

function applyFilters(value: string, filters: string[]): string {
  return filters.reduce((acc, f) => FILTERS[f](acc), value);
}

function renderNodes(
  nodes: Node[],
  stack: Frame[],
  inSection: boolean,
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
        out += node.optional || inSection ? "" : node.source;
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

function renderSection(
  node: Extract<Node, { kind: "section" }>,
  stack: Frame[],
): string {
  const { value } = lookup(stack, node.name);
  const truthy = isTruthy(value);
  // A section body is always "in section" once entered, at any depth.
  const inner = true;

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

/**
 * Render a template against sample values for the live preview. Throws on
 * an unbalanced section or unknown filter (mid-edit is a normal state to be
 * in) — callers should catch and fall back to showing the raw source.
 */
export function renderPreview(
  template: string,
  variables: Record<string, unknown>,
): string {
  return renderNodes(parse(template), [variables as TemplateValue], false);
}
