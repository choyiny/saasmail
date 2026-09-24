import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { and, desc, eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { mailAgentInstanceName } from "../agent/identity";
import { agentSessions } from "../db/agent-sessions.schema";
import { json200Response, json201Response } from "../lib/helpers";
import { bearerSecurity } from "../lib/openapi-auth";
import type { Variables } from "../variables";

export const agentSessionsRouter = new OpenAPIHono<{
  Bindings: CloudflareBindings;
  Variables: Variables;
}>();

const AgentSessionSchema = z.object({
  id: z.string(),
  title: z.string().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
  archivedAt: z.number().nullable(),
  instanceName: z.string(),
});

const ErrorSchema = z.object({ error: z.string() });

function sessionResponse(row: typeof agentSessions.$inferSelect) {
  return {
    id: row.id,
    title: row.title,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    archivedAt: row.archivedAt,
    instanceName: mailAgentInstanceName(row.userId, row.id),
  };
}

const listSessionsRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Agent"],
  security: bearerSecurity,
  description: "List the authenticated user's agent sessions.",
  responses: {
    500: { description: "Internal server error" },
    ...json200Response(
      z.object({ sessions: z.array(AgentSessionSchema) }),
      "Agent sessions",
    ),
  },
});

agentSessionsRouter.openapi(listSessionsRoute, async (c) => {
  const db = c.get("db");
  const user = c.get("user");
  const rows = await db
    .select()
    .from(agentSessions)
    .where(eq(agentSessions.userId, user.id))
    .orderBy(desc(agentSessions.updatedAt));

  return c.json({ sessions: rows.map(sessionResponse) }, 200);
});

const createSessionRoute = createRoute({
  method: "post",
  path: "/",
  tags: ["Agent"],
  security: bearerSecurity,
  description: "Create an agent chat session for the authenticated user.",
  request: {
    body: {
      required: false,
      content: {
        "application/json": {
          schema: z.object({ title: z.string().max(200).optional() }),
        },
      },
    },
  },
  responses: {
    500: { description: "Internal server error" },
    ...json201Response(AgentSessionSchema, "Created agent session"),
  },
});

agentSessionsRouter.openapi(createSessionRoute, async (c) => {
  const db = c.get("db");
  const user = c.get("user");
  const body = c.req.valid("json") ?? {};
  const now = Math.floor(Date.now() / 1000);
  const row = {
    id: nanoid(),
    userId: user.id,
    title: body.title ?? null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
  };

  await db.insert(agentSessions).values(row);
  return c.json(sessionResponse(row), 201);
});

const patchBody = z
  .object({
    title: z.string().max(200).nullable().optional(),
    archived: z.boolean().optional(),
  })
  .refine(
    (body) => body.title !== undefined || body.archived !== undefined,
    "must update at least one field",
  );

const patchSessionRoute = createRoute({
  method: "patch",
  path: "/{id}",
  tags: ["Agent"],
  security: bearerSecurity,
  description: "Update one of the authenticated user's agent sessions.",
  request: {
    params: z.object({ id: z.string().min(1) }),
    body: {
      required: true,
      content: { "application/json": { schema: patchBody } },
    },
  },
  responses: {
    500: { description: "Internal server error" },
    ...json200Response(AgentSessionSchema, "Updated agent session"),
    404: {
      description: "Session not found",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

agentSessionsRouter.openapi(patchSessionRoute, async (c) => {
  const db = c.get("db");
  const user = c.get("user");
  const { id } = c.req.valid("param");
  const body = c.req.valid("json");

  const rows = await db
    .select()
    .from(agentSessions)
    .where(and(eq(agentSessions.id, id), eq(agentSessions.userId, user.id)))
    .limit(1);

  if (rows.length === 0) {
    return c.json({ error: "Agent session not found" }, 404);
  }

  const now = Math.floor(Date.now() / 1000);
  await db
    .update(agentSessions)
    .set({
      ...(body.title !== undefined ? { title: body.title } : {}),
      ...(body.archived !== undefined
        ? { archivedAt: body.archived ? now : null }
        : {}),
      updatedAt: now,
    })
    .where(and(eq(agentSessions.id, id), eq(agentSessions.userId, user.id)));

  const [updated] = await db
    .select()
    .from(agentSessions)
    .where(and(eq(agentSessions.id, id), eq(agentSessions.userId, user.id)))
    .limit(1);

  return c.json(sessionResponse(updated), 200);
});

const deleteSessionRoute = createRoute({
  method: "delete",
  path: "/{id}",
  tags: ["Agent"],
  security: bearerSecurity,
  description: "Delete one of the authenticated user's agent sessions.",
  request: { params: z.object({ id: z.string().min(1) }) },
  responses: {
    500: { description: "Internal server error" },
    ...json200Response(z.object({ success: z.literal(true) }), "Deleted"),
    404: {
      description: "Session not found",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

agentSessionsRouter.openapi(deleteSessionRoute, async (c) => {
  const db = c.get("db");
  const user = c.get("user");
  const { id } = c.req.valid("param");

  const rows = await db
    .select({ id: agentSessions.id })
    .from(agentSessions)
    .where(and(eq(agentSessions.id, id), eq(agentSessions.userId, user.id)))
    .limit(1);

  if (rows.length === 0) {
    return c.json({ error: "Agent session not found" }, 404);
  }

  await db
    .delete(agentSessions)
    .where(and(eq(agentSessions.id, id), eq(agentSessions.userId, user.id)));

  return c.json({ success: true as const }, 200);
});
