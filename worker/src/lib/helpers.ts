import { z } from "zod";

/** Escape LIKE wildcards (%, _, \) so user input is matched literally. */
export function escapeLike(value: string): string {
  return value.replace(/[%_\\]/g, "\\$&");
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
