import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { inArray } from "drizzle-orm";
import { appSettings } from "../db/app-settings.schema";
import { json200Response } from "../lib/helpers";
import { isDevEnvironment } from "../lib/is-dev";
import type { Variables } from "../variables";

export const bootstrapRouter = new OpenAPIHono<{
  Bindings: CloudflareBindings;
  Variables: Variables;
}>();

const HealthSchema = z.object({
  status: z.literal("ok").openapi({ example: "ok" }),
});

const healthRoute = createRoute({
  method: "get",
  path: "/health",
  tags: ["Bootstrap"],
  description:
    "Liveness probe. No authentication required — safe for load balancers and uptime checks.",
  responses: {
    ...json200Response(HealthSchema, "Service is healthy"),
  },
});

bootstrapRouter.openapi(healthRoute, (c) => c.json({ status: "ok" as const }));

const ConfigSchema = z.object({
  passkeyRequired: z.boolean().openapi({
    description:
      "Whether session users must register a WebAuthn passkey before using the API. Always false in local dev.",
  }),
  brandName: z.string().openapi({
    description:
      'Instance display name from app settings. Defaults to "saasmail" when unset.',
    example: "saasmail",
  }),
  webmcpEnabled: z.boolean().openapi({
    description:
      "Whether the web UI registers WebMCP tools for in-page AI agents. Defaults to true; set app_settings key 'webmcp_enabled' to 'false' to disable.",
  }),
});

const configRoute = createRoute({
  method: "get",
  path: "/config",
  tags: ["Bootstrap"],
  description:
    "Public runtime configuration consumed by the web UI on startup. No authentication required.",
  responses: {
    ...json200Response(ConfigSchema, "Runtime configuration"),
  },
});

bootstrapRouter.openapi(configRoute, async (c) => {
  const db = c.get("db");
  // One round-trip for both settings this unauthenticated route reads on
  // every app load.
  const rows = await db
    .select({ key: appSettings.key, value: appSettings.value })
    .from(appSettings)
    .where(inArray(appSettings.key, ["brand_name", "webmcp_enabled"]));
  const brandNameValue = rows.find((r) => r.key === "brand_name")?.value;
  const brandName =
    brandNameValue && brandNameValue.length > 0 ? brandNameValue : "saasmail";
  const webmcpEnabled =
    rows.find((r) => r.key === "webmcp_enabled")?.value !== "false";
  return c.json({
    passkeyRequired: !isDevEnvironment(c.env),
    brandName,
    webmcpEnabled,
  });
});
