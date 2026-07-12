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
});

export const multipartParseErrorResponses = {
  400: {
    description:
      "Missing or invalid `payload` JSON, or too many attachment files (max 50).",
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
