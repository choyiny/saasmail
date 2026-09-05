/**
 * Resolve what a template write should actually store.
 *
 * One helper for both `POST` and `PUT` because the format rules are the kind of
 * thing that silently diverges when written twice: the create path would gain a
 * check the update path lacks, and the difference would only surface as a
 * template whose `bodyHtml` no longer matches its `bodyJson`.
 *
 * The invariant this exists to protect: **`bodyHtml` is the rendering source
 * for every consumer**, and for a block template the server is the only thing
 * allowed to produce it. A client-supplied `bodyHtml` on a block template is
 * refused rather than merged, because if both were accepted the two
 * representations would drift and whichever the client happened to set is what
 * subscribers would receive.
 */

import { compile } from "./blocks/compile";
import { BlockDocumentSchema, type BlockDocument } from "./blocks/schema";

export type TemplateFormat = "html" | "block";

export type ResolvedBody = {
  format: TemplateFormat;
  bodyHtml: string;
  bodyJson: BlockDocument | null;
};

/** A refusal, carrying the status the route should answer with. */
export type BodyError = { status: 400 | 422; error: string };

export const isBodyError = (v: ResolvedBody | BodyError): v is BodyError =>
  "error" in v;

export type BodyInput = {
  format?: TemplateFormat;
  bodyHtml?: string;
  bodyJson?: unknown;
};

/** Parse and compile a block document, or explain why it cannot be stored. */
function compileBlockDocument(
  raw: unknown,
): { doc: BlockDocument; html: string } | BodyError {
  const parsed = BlockDocumentSchema.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const path = first?.path.join(".");
    return {
      status: 400,
      error: path
        ? `Invalid block document at \`${path}\`: ${first.message}`
        : `Invalid block document: ${first?.message ?? "unknown error"}`,
    };
  }
  // `parsed.data` is the *sanitized* document — `InlineHtmlSchema` transforms
  // during validation, so what gets stored is what the sanitizer produced, not
  // what the client sent.
  return { doc: parsed.data, html: compile(parsed.data) };
}

/**
 * Resolve a create.
 *
 * `format` defaults to `html`, so every existing caller keeps working unchanged.
 */
export function resolveCreateBody(input: BodyInput): ResolvedBody | BodyError {
  const format = input.format ?? "html";

  if (format === "block") {
    if (input.bodyHtml !== undefined) {
      return {
        status: 400,
        error:
          "bodyHtml is not accepted for a block template — it is compiled from bodyJson",
      };
    }
    if (input.bodyJson === undefined) {
      return {
        status: 400,
        error: "bodyJson is required for a block template",
      };
    }
    const compiled = compileBlockDocument(input.bodyJson);
    if ("error" in compiled) return compiled;
    return { format, bodyHtml: compiled.html, bodyJson: compiled.doc };
  }

  if (input.bodyJson !== undefined) {
    return {
      status: 400,
      error: "bodyJson is only accepted when format is 'block'",
    };
  }
  if (input.bodyHtml === undefined) {
    return { status: 400, error: "bodyHtml is required" };
  }
  return { format: "html", bodyHtml: input.bodyHtml, bodyJson: null };
}

/**
 * Resolve an update against the row as it exists.
 *
 * Both body fields are optional here, so the result is the merge — the caller
 * validates tags against *this* output, not against what was sent.
 */
export function resolveUpdateBody(
  input: BodyInput,
  existing: { format: TemplateFormat; bodyHtml: string; bodyJson: unknown },
): ResolvedBody | BodyError {
  const target = input.format ?? existing.format;

  // html → block is refused *when there is content to lose*. Parsing arbitrary
  // email HTML back into blocks is a lossy heuristic that would quietly discard
  // layout the author cannot see is gone.
  //
  // An empty body has nothing to lose, and refusing there would be actively
  // unhelpful: a campaign created blank starts as `html` by default, and the
  // operator's first act is to pick how they want to write it.
  if (target === "block" && existing.format === "html") {
    if (existing.bodyHtml.trim()) {
      return {
        status: 422,
        error:
          "Content written as HTML cannot be converted to blocks — start a new one instead",
      };
    }
    if (input.bodyJson === undefined) {
      return { format: "block", bodyHtml: "", bodyJson: null };
    }
    const compiled = compileBlockDocument(input.bodyJson);
    if ("error" in compiled) return compiled;
    return { format: "block", bodyHtml: compiled.html, bodyJson: compiled.doc };
  }

  // block → html is allowed and one-way: the already-compiled HTML is kept and
  // the block document is dropped. The UI confirms before sending this.
  if (target === "html" && existing.format === "block") {
    if (input.bodyJson !== undefined) {
      return {
        status: 400,
        error: "bodyJson is not accepted when converting a template to HTML",
      };
    }
    return {
      format: "html",
      bodyHtml: input.bodyHtml ?? existing.bodyHtml,
      bodyJson: null,
    };
  }

  if (target === "block") {
    if (input.bodyHtml !== undefined) {
      return {
        status: 400,
        error:
          "bodyHtml is not accepted for a block template — it is compiled from bodyJson",
      };
    }
    // An update that does not touch the body leaves both columns as they are.
    if (input.bodyJson === undefined) {
      return {
        format: "block",
        bodyHtml: existing.bodyHtml,
        bodyJson: (existing.bodyJson as BlockDocument | null) ?? null,
      };
    }
    const compiled = compileBlockDocument(input.bodyJson);
    if ("error" in compiled) return compiled;
    return { format: "block", bodyHtml: compiled.html, bodyJson: compiled.doc };
  }

  if (input.bodyJson !== undefined) {
    return {
      status: 400,
      error: "bodyJson is only accepted when format is 'block'",
    };
  }
  return {
    format: "html",
    bodyHtml: input.bodyHtml ?? existing.bodyHtml,
    bodyJson: null,
  };
}
