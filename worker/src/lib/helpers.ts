import { z } from "zod";

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
