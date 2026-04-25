import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { agentDefinitions } from "../db/agent-definitions.schema";
import { agentAssignments } from "../db/agent-assignments.schema";
import { json200Response, json201Response } from "../lib/helpers";
import {
  agentDefinitionResponse,
  outputFieldSchema,
  fieldsToJsonSchema,
  jsonSchemaToFields,
} from "./agents-schemas";
import type { Variables } from "../variables";

export const agentDefinitionsRouter = new OpenAPIHono<{
  Bindings: CloudflareBindings;
  Variables: Variables;
}>();

const createRoute_ = createRoute({
  method: "post",
  path: "/",
  tags: ["Agents"],
  description: "Create an agent definition.",
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            name: z.string().min(1).max(100),
            description: z.string().optional(),
            modelId: z
              .string()
              .min(1)
              .default("@cf/meta/llama-3.3-70b-instruct"),
            systemPrompt: z.string().min(1),
            outputFields: z.array(outputFieldSchema).min(1),
            maxRunsPerHour: z.number().int().min(1).max(100).default(10),
            isActive: z.boolean().default(true),
          }),
        },
      },
    },
  },
  responses: {
    ...json201Response(agentDefinitionResponse, "Created agent definition"),
  },
});

agentDefinitionsRouter.openapi(createRoute_, async (c) => {
  const db = c.get("db");
  const {
    name,
    description,
    modelId,
    systemPrompt,
    outputFields,
    maxRunsPerHour,
    isActive,
  } = c.req.valid("json");
  const now = Math.floor(Date.now() / 1000);
  const row = {
    id: nanoid(),
    name,
    description: description ?? null,
    modelId,
    systemPrompt,
    outputSchemaJson: fieldsToJsonSchema(outputFields),
    maxRunsPerHour,
    isActive: isActive ? 1 : 0,
    createdAt: now,
    updatedAt: now,
  };
  await db.insert(agentDefinitions).values(row);
  return c.json({ ...row, outputFields, isActive: !!row.isActive }, 201);
});

const listRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Agents"],
  description: "List all agent definitions.",
  responses: {
    ...json200Response(z.array(agentDefinitionResponse), "Agent definitions"),
  },
});

agentDefinitionsRouter.openapi(listRoute, async (c) => {
  const db = c.get("db");
  const rows = await db.select().from(agentDefinitions);
  return c.json(
    rows.map((r) => ({
      ...r,
      outputFields: jsonSchemaToFields(r.outputSchemaJson),
      isActive: !!r.isActive,
    })),
    200,
  );
});

const getRoute = createRoute({
  method: "get",
  path: "/{id}",
  tags: ["Agents"],
  description: "Get an agent definition by ID.",
  request: { params: z.object({ id: z.string() }) },
  responses: {
    ...json200Response(agentDefinitionResponse, "Agent definition"),
  },
});

agentDefinitionsRouter.openapi(getRoute, async (c) => {
  const db = c.get("db");
  const { id } = c.req.valid("param");
  const rows = await db
    .select()
    .from(agentDefinitions)
    .where(eq(agentDefinitions.id, id))
    .limit(1);
  if (rows.length === 0) return c.json({ error: "Not found" }, 404);
  const r = rows[0];
  return c.json(
    {
      ...r,
      outputFields: jsonSchemaToFields(r.outputSchemaJson),
      isActive: !!r.isActive,
    },
    200,
  );
});

const updateRoute = createRoute({
  method: "put",
  path: "/{id}",
  tags: ["Agents"],
  description: "Update an agent definition.",
  request: {
    params: z.object({ id: z.string() }),
    body: {
      content: {
        "application/json": {
          schema: z.object({
            name: z.string().min(1).max(100).optional(),
            description: z.string().nullable().optional(),
            modelId: z.string().min(1).optional(),
            systemPrompt: z.string().min(1).optional(),
            outputFields: z.array(outputFieldSchema).min(1).optional(),
            maxRunsPerHour: z.number().int().min(1).max(100).optional(),
            isActive: z.boolean().optional(),
          }),
        },
      },
    },
  },
  responses: {
    ...json200Response(agentDefinitionResponse, "Updated agent definition"),
  },
});

agentDefinitionsRouter.openapi(updateRoute, async (c) => {
  const db = c.get("db");
  const { id } = c.req.valid("param");
  const updates = c.req.valid("json");
  const now = Math.floor(Date.now() / 1000);

  const existing = await db
    .select()
    .from(agentDefinitions)
    .where(eq(agentDefinitions.id, id))
    .limit(1);
  if (existing.length === 0) return c.json({ error: "Not found" }, 404);

  const dbUpdates: Record<string, unknown> = { updatedAt: now };
  if (updates.name !== undefined) dbUpdates.name = updates.name;
  if (updates.description !== undefined)
    dbUpdates.description = updates.description;
  if (updates.modelId !== undefined) dbUpdates.modelId = updates.modelId;
  if (updates.systemPrompt !== undefined)
    dbUpdates.systemPrompt = updates.systemPrompt;
  if (updates.outputFields !== undefined)
    dbUpdates.outputSchemaJson = fieldsToJsonSchema(updates.outputFields);
  if (updates.maxRunsPerHour !== undefined)
    dbUpdates.maxRunsPerHour = updates.maxRunsPerHour;
  if (updates.isActive !== undefined)
    dbUpdates.isActive = updates.isActive ? 1 : 0;

  await db
    .update(agentDefinitions)
    .set(dbUpdates)
    .where(eq(agentDefinitions.id, id));

  const updated = await db
    .select()
    .from(agentDefinitions)
    .where(eq(agentDefinitions.id, id))
    .limit(1);
  const r = updated[0];
  return c.json(
    {
      ...r,
      outputFields: jsonSchemaToFields(r.outputSchemaJson),
      isActive: !!r.isActive,
    },
    200,
  );
});

const deleteRoute = createRoute({
  method: "delete",
  path: "/{id}",
  tags: ["Agents"],
  description: "Delete an agent definition. Fails if active assignments exist.",
  request: { params: z.object({ id: z.string() }) },
  responses: {
    ...json200Response(z.object({ success: z.boolean() }), "Deleted"),
  },
});

agentDefinitionsRouter.openapi(deleteRoute, async (c) => {
  const db = c.get("db");
  const { id } = c.req.valid("param");

  const existing = await db
    .select()
    .from(agentDefinitions)
    .where(eq(agentDefinitions.id, id))
    .limit(1);
  if (existing.length === 0) return c.json({ error: "Not found" }, 404);

  const activeAssignments = await db
    .select({ id: agentAssignments.id })
    .from(agentAssignments)
    .where(eq(agentAssignments.agentId, id))
    .limit(1);

  if (activeAssignments.length > 0) {
    return c.json(
      { error: "Delete or deactivate all assignments for this agent first" },
      409,
    );
  }

  await db.delete(agentDefinitions).where(eq(agentDefinitions.id, id));
  return c.json({ success: true }, 200);
});
