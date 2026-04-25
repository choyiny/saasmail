import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { and, desc, eq, sql } from "drizzle-orm";
import { agentRuns } from "../db/agent-runs.schema";
import { json200Response } from "../lib/helpers";
import { agentRunResponse } from "./agents-schemas";
import type { Variables } from "../variables";

export const agentRunsRouter = new OpenAPIHono<{
  Bindings: CloudflareBindings;
  Variables: Variables;
}>();

const listRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Agent Runs"],
  description: "List agent runs with optional filters.",
  request: {
    query: z.object({
      assignmentId: z.string().optional(),
      personId: z.string().optional(),
      status: z.string().optional(),
      limit: z.coerce.number().int().min(1).max(100).default(50),
      offset: z.coerce.number().int().min(0).default(0),
    }),
  },
  responses: {
    ...json200Response(
      z.object({ runs: z.array(agentRunResponse), total: z.number() }),
      "Paginated agent runs",
    ),
  },
});

agentRunsRouter.openapi(listRoute, async (c) => {
  const db = c.get("db");
  const { assignmentId, personId, status, limit, offset } =
    c.req.valid("query");

  const conditions = [
    assignmentId ? eq(agentRuns.assignmentId, assignmentId) : undefined,
    personId ? eq(agentRuns.personId, personId) : undefined,
    status ? eq(agentRuns.status, status) : undefined,
  ].filter(Boolean) as ReturnType<typeof eq>[];

  const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

  const [rows, countRows] = await Promise.all([
    db
      .select()
      .from(agentRuns)
      .where(whereClause)
      .orderBy(desc(agentRuns.createdAt))
      .limit(limit)
      .offset(offset),
    db
      .select({ count: sql<number>`count(*)` })
      .from(agentRuns)
      .where(whereClause),
  ]);

  return c.json(
    {
      runs: rows.map((r) => ({
        ...r,
        action: r.action ?? null,
        sentEmailId: r.sentEmailId ?? null,
        draftId: r.draftId ?? null,
        modelId: r.modelId ?? null,
        inputTokens: r.inputTokens ?? null,
        outputTokens: r.outputTokens ?? null,
        errorMessage: r.errorMessage ?? null,
      })),
      total: countRows[0]?.count ?? 0,
    },
    200,
  );
});

const getRoute = createRoute({
  method: "get",
  path: "/{id}",
  tags: ["Agent Runs"],
  description: "Get a single agent run.",
  request: { params: z.object({ id: z.string() }) },
  responses: {
    ...json200Response(agentRunResponse, "Agent run"),
  },
});

agentRunsRouter.openapi(getRoute, async (c) => {
  const db = c.get("db");
  const { id } = c.req.valid("param");
  const rows = await db
    .select()
    .from(agentRuns)
    .where(eq(agentRuns.id, id))
    .limit(1);
  if (rows.length === 0) return c.json({ error: "Not found" }, 404);
  const r = rows[0];
  return c.json(
    {
      ...r,
      action: r.action ?? null,
      sentEmailId: r.sentEmailId ?? null,
      draftId: r.draftId ?? null,
      modelId: r.modelId ?? null,
      inputTokens: r.inputTokens ?? null,
      outputTokens: r.outputTokens ?? null,
      errorMessage: r.errorMessage ?? null,
    },
    200,
  );
});
