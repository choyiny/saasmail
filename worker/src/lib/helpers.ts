import { z } from "zod";

/**
 * Cloudflare D1 hard-caps bound parameters at 100 per statement.
 * Miniflare / vitest-pool-workers do NOT enforce this — green local tests
 * can still 500 on a real instance once an `IN (...)` list grows.
 */
export const D1_MAX_BOUND_PARAMS = 100;

/**
 * Split `items` so each chunk's binds stay under D1's 100-parameter cap.
 * `bindsPerItem` is how many `?` placeholders one item contributes in the
 * statement (e.g. 2 when the same id list appears in both halves of a UNION).
 * Leaves one slot of headroom (`floor(max/binds) - 1`) like other D1
 * chunkers in the stack.
 */
export function chunkForD1BoundParams<T>(
  items: T[],
  bindsPerItem: number,
  maxBinds: number = D1_MAX_BOUND_PARAMS,
): T[][] {
  if (items.length === 0) return [];
  if (bindsPerItem < 1) {
    throw new Error("bindsPerItem must be >= 1");
  }
  const chunkSize = Math.max(1, Math.floor(maxBinds / bindsPerItem) - 1);
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += chunkSize) {
    chunks.push(items.slice(i, i + chunkSize));
  }
  return chunks;
}

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
