import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { count } from "drizzle-orm";
import { gmailAccounts } from "../db/gmail-accounts.schema";
import { json200Response } from "../lib/helpers";
import {
  OAUTH_PROVIDERS,
  ProviderConfigError,
  clearProviderConfig,
  describeProvider,
  encryptionKeyOf,
  saveProviderConfig,
  type OAuthProvider,
} from "../lib/oauth-providers";
import { gmailRedirectUri } from "./admin-gmail-router";
import { outlookRedirectUri } from "./admin-outlook-router";
import { outlookAccounts } from "../db/outlook-accounts.schema";
import type { Variables } from "../variables";

/**
 * OAuth app settings for the mailbox providers, edited from the Inboxes page.
 * Admin-only (mounted under /api/admin). The client secret goes in and never
 * comes back out: responses say only whether one is stored.
 */
export const adminIntegrationsRouter = new OpenAPIHono<{
  Bindings: CloudflareBindings & { BASE_URL?: string };
  Variables: Variables;
}>();

const ProviderParam = z.object({ provider: z.enum(OAUTH_PROVIDERS) });

const ProviderSchema = z.object({
  provider: z.enum(OAUTH_PROVIDERS),
  /** Usable right now: settings present and TOKEN_ENCRYPTION_KEY set. */
  configured: z.boolean(),
  /** "env" for Google settings still coming from wrangler vars. */
  source: z.enum(["database", "env"]).nullable(),
  clientId: z.string().nullable(),
  hasClientSecret: z.boolean(),
  /** Microsoft only; null means any work, school or personal account. */
  tenant: z.string().nullable(),
  /** The exact URI to register with the provider as an allowed redirect. */
  redirectUri: z.string(),
  /**
   * Mailboxes connected through this provider. Their grants belong to the
   * current OAuth app, so changing the client id means reconnecting them.
   */
  connectedMailboxes: z.number(),
  updatedAt: z.number().nullable(),
});

const ListSchema = z.object({
  /**
   * TOKEN_ENCRYPTION_KEY is set. It stays a wrangler secret — it encrypts
   * everything stored here — so without it nothing can be saved.
   */
  encryptionKeyConfigured: z.boolean(),
  providers: z.array(ProviderSchema),
});

function redirectUriFor(
  provider: OAuthProvider,
  env: { BASE_URL?: string },
): string {
  return provider === "google"
    ? gmailRedirectUri(env)
    : outlookRedirectUri(env);
}

async function connectedCount(
  db: Parameters<typeof describeProvider>[0],
  provider: OAuthProvider,
): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(provider === "google" ? gmailAccounts : outlookAccounts);
  return row?.n ?? 0;
}

async function describe(
  db: Parameters<typeof describeProvider>[0],
  env: CloudflareBindings & { BASE_URL?: string },
  provider: OAuthProvider,
): Promise<z.infer<typeof ProviderSchema>> {
  const d = await describeProvider(db, env, provider);
  return {
    provider,
    configured: d.configured,
    source: d.source,
    clientId: d.clientId,
    hasClientSecret: d.hasClientSecret,
    tenant: d.tenant,
    redirectUri: redirectUriFor(provider, env),
    connectedMailboxes: await connectedCount(db, provider),
    updatedAt: d.updatedAt,
  };
}

const listRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Admin Integrations"],
  description: "OAuth app settings for each mailbox provider.",
  responses: { ...json200Response(ListSchema, "Provider settings") },
});

adminIntegrationsRouter.openapi(listRoute, async (c) => {
  const db = c.get("db");
  const providers = [];
  for (const provider of OAUTH_PROVIDERS) {
    providers.push(await describe(db, c.env, provider));
  }
  return c.json(
    { encryptionKeyConfigured: encryptionKeyOf(c.env) !== null, providers },
    200,
  );
});

const ErrorSchema = z.object({ error: z.string() });

const putRoute = createRoute({
  method: "put",
  path: "/{provider}",
  tags: ["Admin Integrations"],
  description:
    "Save a provider's OAuth client. Omit `clientSecret` to keep the stored one.",
  request: {
    params: ProviderParam,
    body: {
      content: {
        "application/json": {
          schema: z.object({
            clientId: z.string().trim().min(1).max(512),
            clientSecret: z.string().min(1).max(2048).optional(),
            tenant: z
              .string()
              .trim()
              .max(128)
              .regex(/^[A-Za-z0-9.-]*$/, "Not a tenant id or domain")
              .nullable()
              .optional(),
          }),
        },
      },
    },
  },
  responses: {
    ...json200Response(ProviderSchema, "Saved"),
    400: {
      description: "Missing secret",
      content: { "application/json": { schema: ErrorSchema } },
    },
    503: {
      description: "TOKEN_ENCRYPTION_KEY is not set",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

adminIntegrationsRouter.openapi(putRoute, async (c) => {
  const { provider } = c.req.valid("param");
  const body = c.req.valid("json");
  const db = c.get("db");
  if (encryptionKeyOf(c.env) === null) {
    return c.json(
      {
        error:
          "TOKEN_ENCRYPTION_KEY is not set, so secrets cannot be stored. Set it with `wrangler secret put TOKEN_ENCRYPTION_KEY` (32 random bytes, base64) and redeploy.",
      },
      503,
    );
  }
  try {
    await saveProviderConfig(db, c.env, provider, body, c.get("user").id);
  } catch (err) {
    if (err instanceof ProviderConfigError) {
      return c.json({ error: err.message }, 400);
    }
    throw err;
  }
  return c.json(await describe(db, c.env, provider), 200);
});

const deleteRoute = createRoute({
  method: "delete",
  path: "/{provider}",
  tags: ["Admin Integrations"],
  description:
    "Remove a provider's stored OAuth client. Google falls back to its env vars, if set.",
  request: { params: ProviderParam },
  responses: { ...json200Response(ProviderSchema, "Removed") },
});

adminIntegrationsRouter.openapi(deleteRoute, async (c) => {
  const { provider } = c.req.valid("param");
  const db = c.get("db");
  await clearProviderConfig(db, provider);
  return c.json(await describe(db, c.env, provider), 200);
});
