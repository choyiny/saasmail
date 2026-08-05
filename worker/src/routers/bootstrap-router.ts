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

/**
 * What this build of saasmail can do, for clients that are not shipped with it.
 *
 * The web UI is deployed from the same commit as the worker, so it never has to
 * ask. A third-party or native client is a separate artifact talking to whatever
 * version an operator happens to be running, and without this it can only
 * discover a missing capability by attempting it and interpreting the failure —
 * which is indistinguishable from a bug, a misconfiguration, or a revoked
 * grant. Advertising them lets a client say "this server needs a newer saasmail"
 * instead of failing mysteriously halfway through a flow.
 *
 * Add a key here when a capability lands; never remove one, since a client may
 * branch on its absence.
 */
const CapabilitiesSchema = z
  .object({
    oauthApi: z.boolean().openapi({
      description:
        "Whether `/api/*` accepts OAuth 2.1 access tokens. When false, only a session cookie or an `sk_` API key will authenticate, and a token that authorizes successfully will still be rejected by every API route.",
    }),
    oauthStream: z.boolean().openapi({
      description:
        "Whether `GET /api/notifications/stream` accepts a bearer-authenticated upgrade without a browser `Origin` header. When false, a native client cannot open the realtime stream.",
    }),
  })
  .openapi({ description: "Capabilities this deployment supports." });

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
  apiVersion: z.number().int().openapi({
    description:
      "Monotonic version of the HTTP API contract, incremented when a capability is added. A client too old to understand this server, or too new for it, can compare rather than probe.",
    example: 1,
  }),
  capabilities: CapabilitiesSchema,
});

/**
 * Bumped whenever a capability is added below. Deliberately independent of the
 * package version, which moves for reasons a client does not care about.
 */
const API_VERSION = 1;

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
    apiVersion: API_VERSION,
    capabilities: {
      oauthApi: true,
      oauthStream: true,
    },
  });
});
