import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { eq } from "drizzle-orm";
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
  const row = await db
    .select({ value: appSettings.value })
    .from(appSettings)
    .where(eq(appSettings.key, "brand_name"))
    .limit(1);
  const brandName =
    row.length > 0 && row[0].value && row[0].value.length > 0
      ? row[0].value
      : "saasmail";
  return c.json({
    passkeyRequired: !isDevEnvironment(c.env),
    brandName,
  });
});
