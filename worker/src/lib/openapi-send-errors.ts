import { z } from "@hono/zod-openapi";

export const ErrorSchema = z.object({
  error: z.string(),
});

/**
 * JSON error bodies on multipart send paths (parseSendBody / sendParseErrorResponse)
 * and reply/template validation failures that share the same `{ error }` shape.
 */
export const SendPathErrorSchema = z.object({
  error: z.string(),
  detail: z.string().optional(),
  limit: z.number().int().optional(),
  provided: z.number().int().optional(),
  limitBytes: z.number().int().optional(),
  providedBytes: z.number().int().optional(),
  missingVariables: z.array(z.string()).optional(),
  requiredVariables: z.array(z.string()).optional(),
  code: z.string().optional().openapi({
    description:
      "Set for a refused idempotency key: `INVALID_IDEMPOTENCY_KEY`.",
  }),
});

const IdempotencyErrorSchema = z.object({
  error: z.string(),
  code: z.string(),
});

/**
 * The answers of a send route that took an `Idempotency-Key`: the key is
 * still in use by a running request, or was used for a different one.
 */
export const idempotencyConflictResponses = {
  409: {
    description:
      "A request with this idempotency key is still running (`IDEMPOTENCY_IN_PROGRESS`). Retry after the `Retry-After` seconds.",
    headers: z.object({
      "Retry-After": z.string().openapi({
        description: "Seconds to wait before retrying with the same key.",
        example: "2",
      }),
    }),
    content: { "application/json": { schema: IdempotencyErrorSchema } },
  },
  422: {
    description:
      "This idempotency key was already used for a different request (`IDEMPOTENCY_KEY_REUSED`). Use a new key for a new message.",
    content: { "application/json": { schema: IdempotencyErrorSchema } },
  },
};

/** The answer of a send route over the caller's daily limit. */
export const dailySendLimitResponses = {
  429: {
    description:
      "The caller reached the daily send limit for this channel (`DAILY_SEND_LIMIT_REACHED`; web sessions and API keys are counted separately). Nothing was sent. The limit resets at midnight UTC: retry after the `Retry-After` seconds.",
    headers: z.object({
      "Retry-After": z.string().openapi({
        description: "Seconds to the next UTC midnight.",
        example: "3600",
      }),
    }),
    content: {
      "application/json": {
        schema: z.object({
          error: z.string(),
          code: z.literal("DAILY_SEND_LIMIT_REACHED"),
          retryAfter: z.number().int(),
        }),
      },
    },
  },
};

/**
 * The 201 of a send route that takes an `Idempotency-Key`, with the header
 * that marks a replayed answer.
 */
export function idempotent201Response(schema: z.ZodType, description: string) {
  return {
    201: {
      description: `${description}. A retry with the same key returns this same answer with \`Idempotency-Replayed: true\`; a send whose request failed after the provider accepted it answers \`{ id, status, incomplete: true }\`.`,
      headers: z.object({
        "Idempotency-Replayed": z.string().optional().openapi({
          description:
            "`true` when this is the stored answer to an earlier request with the same key.",
          example: "true",
        }),
      }),
      content: { "application/json": { schema } },
    },
  };
}

/** The `Idempotency-Key` request header, for the send routes' OpenAPI. */
export const idempotencyKeyHeader = z.object({
  "idempotency-key": z.string().optional().openapi({
    description:
      "A key you generate per intended message (a UUID) and send again on every retry of it. A retry with the same key and the same request returns the first answer, with `Idempotency-Replayed: true`, instead of sending again. Kept 24 hours. 1–255 printable ASCII characters; wins over `idempotencyKey` in the payload.",
    example: "5b8f0c1e-6c3d-4b9a-9d2e-7f1a2b3c4d5e",
  }),
});

export const multipartParseErrorResponses = {
  400: {
    description:
      "Body is not multipart/form-data, `payload` JSON is missing or invalid, or there are too many attachment files (max 50).",
    content: {
      "application/json": { schema: SendPathErrorSchema },
    },
  },
  413: {
    description: "Total attachment size exceeds the provider limit.",
    content: {
      "application/json": { schema: SendPathErrorSchema },
    },
  },
};

export const inboxForbiddenResponse = {
  403: {
    description:
      "fromAddress is not an inbox this API key is permitted to send from.",
    content: {
      "application/json": { schema: ErrorSchema },
    },
  },
};

export const replyValidationErrorResponse = {
  400: {
    description:
      "Multipart parse failure, missing bodyHtml/templateSlug, or missing required template variables.",
    content: {
      "application/json": { schema: SendPathErrorSchema },
    },
  },
};

export const replyNotFoundResponse = {
  404: {
    description:
      "Original email or person not found, sent email has no associated person, or template slug not found.",
    content: {
      "application/json": { schema: ErrorSchema },
    },
  },
};
