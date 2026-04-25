import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { and, desc, eq, isNull, or } from "drizzle-orm";
import { nanoid } from "nanoid";
import { agentAssignments } from "../db/agent-assignments.schema";
import { agentDefinitions } from "../db/agent-definitions.schema";
import { emailTemplates } from "../db/email-templates.schema";
import { extractVariables } from "../lib/interpolate";
import { json200Response, json201Response } from "../lib/helpers";
import {
  agentAssignmentResponse,
  agentModeEnum,
  jsonSchemaToFields,
} from "./agents-schemas";
import type { Variables } from "../variables";

export const agentAssignmentsRouter = new OpenAPIHono<{
  Bindings: CloudflareBindings;
  Variables: Variables;
}>();

function rowToResponse(
  row: typeof agentAssignments.$inferSelect & {
    agentName: string | null;
    templateName: string | null;
  },
) {
  return {
    ...row,
    isActive: !!row.isActive,
    agentName: row.agentName ?? "",
    templateName: row.templateName ?? "",
  };
}

const listRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Agent Assignments"],
  description: "List agent assignments. Filter by agentId via query param.",
  request: {
    query: z.object({ agentId: z.string().optional() }),
  },
  responses: {
    ...json200Response(z.array(agentAssignmentResponse), "Agent assignments"),
  },
});

agentAssignmentsRouter.openapi(listRoute, async (c) => {
  const db = c.get("db");
  const { agentId } = c.req.valid("query");

  const rows = await db
    .select({
      id: agentAssignments.id,
      agentId: agentAssignments.agentId,
      mailbox: agentAssignments.mailbox,
      personId: agentAssignments.personId,
      templateSlug: agentAssignments.templateSlug,
      mode: agentAssignments.mode,
      isActive: agentAssignments.isActive,
      createdAt: agentAssignments.createdAt,
      updatedAt: agentAssignments.updatedAt,
      agentName: agentDefinitions.name,
      templateName: emailTemplates.name,
    })
    .from(agentAssignments)
    .leftJoin(
      agentDefinitions,
      eq(agentAssignments.agentId, agentDefinitions.id),
    )
    .leftJoin(
      emailTemplates,
      eq(agentAssignments.templateSlug, emailTemplates.slug),
    )
    .where(agentId ? eq(agentAssignments.agentId, agentId) : undefined)
    .orderBy(desc(agentAssignments.createdAt));

  return c.json(rows.map(rowToResponse), 200);
});

const createRoute_ = createRoute({
  method: "post",
  path: "/",
  tags: ["Agent Assignments"],
  description: "Create an agent assignment.",
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            agentId: z.string(),
            mailbox: z.string().email().nullable().optional(),
            personId: z.string().nullable().optional(),
            templateSlug: z.string().min(1),
            mode: agentModeEnum,
            isActive: z.boolean().default(true),
          }),
        },
      },
    },
  },
  responses: {
    ...json201Response(agentAssignmentResponse, "Created assignment"),
    422: {
      description: "Template uses variables not in agent outputSchema",
      content: {
        "application/json": {
          schema: z.object({ error: z.string(), missing: z.array(z.string()) }),
        },
      },
    },
    409: {
      description: "Scope conflict",
      content: {
        "application/json": {
          schema: z.object({ error: z.string(), existingId: z.string() }),
        },
      },
    },
  },
});

agentAssignmentsRouter.openapi(createRoute_, async (c) => {
  const db = c.get("db");
  const { agentId, mailbox, personId, templateSlug, mode, isActive } =
    c.req.valid("json");

  // Load agent definition
  const [agentDef] = await db
    .select()
    .from(agentDefinitions)
    .where(eq(agentDefinitions.id, agentId))
    .limit(1);
  if (!agentDef) return c.json({ error: "Agent definition not found" }, 404);

  // Load template
  const [template] = await db
    .select()
    .from(emailTemplates)
    .where(eq(emailTemplates.slug, templateSlug))
    .limit(1);
  if (!template) return c.json({ error: "Template not found" }, 404);

  // Validate template vars are a subset of outputSchema keys
  const schemaFields = jsonSchemaToFields(agentDef.outputSchemaJson);
  const schemaKeys = new Set(schemaFields.map((f) => f.name));
  const templateVars = [
    ...extractVariables(template.subject),
    ...extractVariables(template.bodyHtml),
  ];
  const missing = templateVars.filter((v) => !schemaKeys.has(v));
  if (missing.length > 0) {
    return c.json(
      {
        error: `Template uses variables not in agent outputSchema: ${missing.join(", ")}`,
        missing,
      },
      422,
    );
  }

  // Scope uniqueness check (application-level — SQLite NULLs can't use UNIQUE)
  const resolvedMailbox = mailbox ?? null;
  const resolvedPersonId = personId ?? null;

  const existing = await db
    .select({ id: agentAssignments.id })
    .from(agentAssignments)
    .where(
      and(
        eq(agentAssignments.isActive, 1),
        resolvedMailbox !== null
          ? eq(agentAssignments.mailbox, resolvedMailbox)
          : isNull(agentAssignments.mailbox),
        resolvedPersonId !== null
          ? eq(agentAssignments.personId, resolvedPersonId)
          : isNull(agentAssignments.personId),
      ),
    )
    .limit(1);

  if (existing.length > 0) {
    return c.json(
      {
        error: "An active assignment already exists for this scope",
        existingId: existing[0].id,
      },
      409,
    );
  }

  const now = Math.floor(Date.now() / 1000);
  const row = {
    id: nanoid(),
    agentId,
    mailbox: resolvedMailbox,
    personId: resolvedPersonId,
    templateSlug,
    mode,
    isActive: isActive ? 1 : 0,
    createdAt: now,
    updatedAt: now,
  };
  await db.insert(agentAssignments).values(row);

  return c.json(
    {
      ...row,
      isActive: !!row.isActive,
      agentName: agentDef.name,
      templateName: template.name,
    },
    201,
  );
});

const getRoute = createRoute({
  method: "get",
  path: "/{id}",
  tags: ["Agent Assignments"],
  description: "Get an assignment by ID.",
  request: { params: z.object({ id: z.string() }) },
  responses: {
    ...json200Response(agentAssignmentResponse, "Assignment"),
  },
});

agentAssignmentsRouter.openapi(getRoute, async (c) => {
  const db = c.get("db");
  const { id } = c.req.valid("param");

  const rows = await db
    .select({
      id: agentAssignments.id,
      agentId: agentAssignments.agentId,
      mailbox: agentAssignments.mailbox,
      personId: agentAssignments.personId,
      templateSlug: agentAssignments.templateSlug,
      mode: agentAssignments.mode,
      isActive: agentAssignments.isActive,
      createdAt: agentAssignments.createdAt,
      updatedAt: agentAssignments.updatedAt,
      agentName: agentDefinitions.name,
      templateName: emailTemplates.name,
    })
    .from(agentAssignments)
    .leftJoin(
      agentDefinitions,
      eq(agentAssignments.agentId, agentDefinitions.id),
    )
    .leftJoin(
      emailTemplates,
      eq(agentAssignments.templateSlug, emailTemplates.slug),
    )
    .where(eq(agentAssignments.id, id))
    .limit(1);

  if (rows.length === 0) return c.json({ error: "Not found" }, 404);
  return c.json(rowToResponse(rows[0]), 200);
});

const updateRoute = createRoute({
  method: "put",
  path: "/{id}",
  tags: ["Agent Assignments"],
  description: "Update an assignment.",
  request: {
    params: z.object({ id: z.string() }),
    body: {
      content: {
        "application/json": {
          schema: z.object({
            templateSlug: z.string().optional(),
            mode: agentModeEnum.optional(),
            isActive: z.boolean().optional(),
            mailbox: z.string().email().nullable().optional(),
            personId: z.string().nullable().optional(),
          }),
        },
      },
    },
  },
  responses: {
    ...json200Response(agentAssignmentResponse, "Updated assignment"),
  },
});

agentAssignmentsRouter.openapi(updateRoute, async (c) => {
  const db = c.get("db");
  const { id } = c.req.valid("param");
  const updates = c.req.valid("json");
  const now = Math.floor(Date.now() / 1000);

  const [existing] = await db
    .select()
    .from(agentAssignments)
    .where(eq(agentAssignments.id, id))
    .limit(1);
  if (!existing) return c.json({ error: "Not found" }, 404);

  // If templateSlug is changing, re-validate template vars
  if (updates.templateSlug) {
    const [agentDef] = await db
      .select()
      .from(agentDefinitions)
      .where(eq(agentDefinitions.id, existing.agentId))
      .limit(1);
    const [template] = await db
      .select()
      .from(emailTemplates)
      .where(eq(emailTemplates.slug, updates.templateSlug))
      .limit(1);
    if (!template) return c.json({ error: "Template not found" }, 404);
    if (agentDef) {
      const schemaKeys = new Set(
        jsonSchemaToFields(agentDef.outputSchemaJson).map((f) => f.name),
      );
      const templateVars = [
        ...extractVariables(template.subject),
        ...extractVariables(template.bodyHtml),
      ];
      const missing = templateVars.filter((v) => !schemaKeys.has(v));
      if (missing.length > 0) {
        return c.json(
          {
            error: `Template uses variables not in agent outputSchema: ${missing.join(", ")}`,
            missing,
          },
          422,
        );
      }
    }
  }

  const dbUpdates: Record<string, unknown> = { updatedAt: now };
  if (updates.templateSlug !== undefined)
    dbUpdates.templateSlug = updates.templateSlug;
  if (updates.mode !== undefined) dbUpdates.mode = updates.mode;
  if (updates.isActive !== undefined)
    dbUpdates.isActive = updates.isActive ? 1 : 0;
  if (updates.mailbox !== undefined) dbUpdates.mailbox = updates.mailbox;
  if (updates.personId !== undefined) dbUpdates.personId = updates.personId;

  await db
    .update(agentAssignments)
    .set(dbUpdates)
    .where(eq(agentAssignments.id, id));

  const rows = await db
    .select({
      id: agentAssignments.id,
      agentId: agentAssignments.agentId,
      mailbox: agentAssignments.mailbox,
      personId: agentAssignments.personId,
      templateSlug: agentAssignments.templateSlug,
      mode: agentAssignments.mode,
      isActive: agentAssignments.isActive,
      createdAt: agentAssignments.createdAt,
      updatedAt: agentAssignments.updatedAt,
      agentName: agentDefinitions.name,
      templateName: emailTemplates.name,
    })
    .from(agentAssignments)
    .leftJoin(
      agentDefinitions,
      eq(agentAssignments.agentId, agentDefinitions.id),
    )
    .leftJoin(
      emailTemplates,
      eq(agentAssignments.templateSlug, emailTemplates.slug),
    )
    .where(eq(agentAssignments.id, id))
    .limit(1);

  return c.json(rowToResponse(rows[0]), 200);
});

const deleteRoute = createRoute({
  method: "delete",
  path: "/{id}",
  tags: ["Agent Assignments"],
  description: "Delete an assignment.",
  request: { params: z.object({ id: z.string() }) },
  responses: {
    ...json200Response(z.object({ success: z.boolean() }), "Deleted"),
  },
});

agentAssignmentsRouter.openapi(deleteRoute, async (c) => {
  const db = c.get("db");
  const { id } = c.req.valid("param");
  const [existing] = await db
    .select()
    .from(agentAssignments)
    .where(eq(agentAssignments.id, id))
    .limit(1);
  if (!existing) return c.json({ error: "Not found" }, 404);
  await db.delete(agentAssignments).where(eq(agentAssignments.id, id));
  return c.json({ success: true }, 200);
});
