import { z } from "zod";

// ── Enums ─────────────────────────────────────────────────────────────────

export const agentModeEnum = z.enum([
  "first_thread_reply",
  "every_mail_reply",
  "draft_only",
]);

// ── Output field shape ─────────────────────────────────────────────────────

export const outputFieldSchema = z.object({
  name: z
    .string()
    .regex(/^\w+$/, "Field names must be alphanumeric/underscore"),
  description: z.string().min(1),
});

export type OutputField = z.infer<typeof outputFieldSchema>;

// ── Response shapes ────────────────────────────────────────────────────────

export const agentDefinitionResponse = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  modelId: z.string(),
  systemPrompt: z.string(),
  outputFields: z.array(outputFieldSchema),
  maxRunsPerHour: z.number(),
  isActive: z.boolean(),
  createdAt: z.number(),
  updatedAt: z.number(),
});

export const agentAssignmentResponse = z.object({
  id: z.string(),
  agentId: z.string(),
  mailbox: z.string().nullable(),
  personId: z.string().nullable(),
  templateSlug: z.string(),
  mode: agentModeEnum,
  isActive: z.boolean(),
  createdAt: z.number(),
  updatedAt: z.number(),
  agentName: z.string(),
  templateName: z.string(),
});

export const agentRunResponse = z.object({
  id: z.string(),
  assignmentId: z.string(),
  emailId: z.string(),
  personId: z.string(),
  status: z.string(),
  action: z.string().nullable(),
  sentEmailId: z.string().nullable(),
  draftId: z.string().nullable(),
  modelId: z.string().nullable(),
  inputTokens: z.number().nullable(),
  outputTokens: z.number().nullable(),
  errorMessage: z.string().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
});

export const draftResponse = z.object({
  id: z.string(),
  personId: z.string(),
  agentRunId: z.string(),
  fromAddress: z.string(),
  toAddress: z.string(),
  subject: z.string(),
  bodyHtml: z.string().nullable(),
  inReplyTo: z.string().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
});

// ── Utility: JSON Schema ↔ outputFields conversion ─────────────────────────

export type OutputSchemaJson = {
  type: "object";
  properties: Record<string, { type: string; description?: string }>;
  required: string[];
};

/**
 * Convert an array of output fields into a stored JSON Schema string.
 * All fields are typed as "string" (v1 constraint).
 */
export function fieldsToJsonSchema(fields: OutputField[]): string {
  const properties: Record<string, { type: string; description: string }> = {};
  for (const f of fields) {
    properties[f.name] = { type: "string", description: f.description };
  }
  return JSON.stringify({
    type: "object",
    properties,
    required: fields.map((f) => f.name),
  });
}

/**
 * Parse a stored JSON Schema string back into an array of output fields.
 */
export function jsonSchemaToFields(raw: string): OutputField[] {
  try {
    const schema = JSON.parse(raw) as OutputSchemaJson;
    return Object.entries(schema.properties ?? {}).map(([name, def]) => ({
      name,
      description: def.description ?? "",
    }));
  } catch {
    return [];
  }
}
