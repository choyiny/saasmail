import { describe, it, expect } from "vitest";
import { z } from "@hono/zod-openapi";
import {
  templateValueSchema,
  templateVariablesSchema,
  MAX_VARIABLE_DEPTH,
} from "../lib/template-variables-schema";

/**
 * The depth guard exists because Zod's recursive descent through a
 * self-referencing `z.lazy` has no bound of its own: a payload of a few KB but
 * thousands of levels deep overflows the stack before any handler runs, and a
 * `RangeError` is not a `ZodError`, so nothing upstream turns it into a 400.
 *
 * The HTTP routes compose `templateVariablesSchema`, which runs an iterative
 * pre-walk first. The MCP tools were widened to accept nested values at the
 * same time but composed the bare recursive value schema, leaving that one
 * surface with the crash the guard was written to close.
 */

/** Build `{k: [[[...]]]}` nested `depth` levels deep. */
function nested(depth: number): Record<string, unknown> {
  let v: unknown = "x";
  for (let i = 0; i < depth; i++) v = [v];
  return { k: v };
}

describe("template variables depth guard", () => {
  it("rejects an over-deep payload with a clean error, not a stack overflow", () => {
    const result = templateVariablesSchema.safeParse(
      nested(MAX_VARIABLE_DEPTH + 10),
    );
    expect(result.success).toBe(false);
  });

  it("accepts a payload within the limit", () => {
    expect(templateVariablesSchema.safeParse(nested(5)).success).toBe(true);
  });

  it("demonstrates why the bare value schema must not be used alone", () => {
    // Pinning the hazard rather than the fix: this is the composition the MCP
    // tools used to have, and it is why they now share the guarded schema.
    const unguarded = z.record(z.string(), templateValueSchema);
    expect(() => unguarded.safeParse(nested(5000))).toThrow(RangeError);
  });
});

describe("MCP tool inputs share the guarded schema", () => {
  /**
   * Asserted against the module source rather than by invoking the MCP server,
   * which needs a full transport and an authenticated session to stand up. The
   * property that matters is a composition choice, and it is exactly the kind
   * of thing that silently regresses when a fourth tool is added by copying an
   * existing one.
   */
  it("no tool composes the unguarded recursive value schema", async () => {
    const source = await import("../mcp/server?raw").then(
      (m) => (m as unknown as { default: string }).default,
    );
    expect(source).not.toMatch(
      /z\s*\.record\(\s*z\.string\(\)\s*,\s*mcpTemplateValueSchema/,
    );
  });
});
