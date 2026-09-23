import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { getAgentStatus, type AgentModelEnv } from "../lib/agent/provider";
import { json200Response } from "../lib/helpers";
import { bearerSecurity } from "../lib/openapi-auth";
import type { Variables } from "../variables";

export const agentStatusRouter = new OpenAPIHono<{
  Bindings: CloudflareBindings;
  Variables: Variables;
}>();

const AgentStatusSchema = z.object({
  configured: z.boolean(),
  provider: z.enum(["anthropic", "openai", "workers-ai"]).nullable(),
  model: z.string().nullable(),
});

const getStatusRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Agent"],
  security: bearerSecurity,
  description:
    "Report whether the native mail agent is configured, without exposing provider credentials.",
  responses: {
    ...json200Response(AgentStatusSchema, "Agent configuration status"),
  },
});

agentStatusRouter.openapi(getStatusRoute, async (c) => {
  return c.json(getAgentStatus(c.env as AgentModelEnv), 200);
});
