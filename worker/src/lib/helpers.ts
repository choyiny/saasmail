import { z } from "zod";

/** Escape LIKE wildcards (%, _, \) so user input is matched literally. */
export function escapeLike(value: string): string {
  return value.replace(/[%_\\]/g, "\\$&");
}

/**
 * Escape a user query for FTS5 MATCH by wrapping each token in double quotes
 * so special FTS5 operators are treated as literals.
 */
export function escapeFts(value: string): string {
  return value
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => `"${t.replace(/"/g, '""')}"`)
    .join(" ");
}

export function json200Response(schema: z.ZodType, description: string) {
  return {
    200: {
      description,
      content: {
        "application/json": {
          schema,
        },
      },
    },
  };
}

export function json201Response(schema: z.ZodType, description: string) {
  return {
    201: {
      description,
      content: {
        "application/json": {
          schema,
        },
      },
    },
  };
}
