import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { desc, eq, sql } from "drizzle-orm";
import {
  oauthClients,
  oauthAccessTokens,
  oauthRefreshTokens,
  oauthConsents,
} from "../db/auth.schema";
import { json200Response } from "../lib/helpers";
import { bearerSecurity } from "../lib/openapi-auth";
import type { Variables } from "../variables";

export const oauthAppsRouter = new OpenAPIHono<{
  Bindings: CloudflareBindings;
  Variables: Variables;
}>();

const OAuthAppSchema = z.object({
  clientId: z.string(),
  name: z.string().nullable(),
  uri: z.string().nullable(),
  disabled: z.boolean(),
  createdAt: z.number().nullable(),
  activeTokens: z.number().openapi({
    description: "Unexpired access tokens currently held by this client.",
  }),
  consentCount: z.number().openapi({
    description: "Users who have granted this client access.",
  }),
});

const listRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["OAuth Apps"],
  security: bearerSecurity,
  description:
    "List OAuth clients registered against this instance, with how many users have consented and how many live tokens each holds. Registration is open to any caller (MCP clients self-register), so this is the surface for spotting one you don't recognise.",
  responses: {
    ...json200Response(z.array(OAuthAppSchema), "Registered OAuth clients"),
  },
});

oauthAppsRouter.openapi(listRoute, async (c) => {
  const db = c.get("db");
  const now = Date.now();

  const rows = await db
    .select({
      clientId: oauthClients.clientId,
      name: oauthClients.name,
      uri: oauthClients.uri,
      disabled: oauthClients.disabled,
      createdAt: oauthClients.createdAt,
    })
    .from(oauthClients)
    .orderBy(desc(oauthClients.createdAt));

  // Counted in one pass each rather than per client, so the list stays a
  // constant number of round-trips as clients accumulate.
  const tokenCounts = await db.all<{ client_id: string; n: number }>(sql`
    SELECT client_id, COUNT(*) AS n FROM oauth_access_tokens
    WHERE expires_at IS NULL OR expires_at > ${now}
    GROUP BY client_id
  `);
  const consentCounts = await db.all<{ client_id: string; n: number }>(sql`
    SELECT client_id, COUNT(*) AS n FROM oauth_consents GROUP BY client_id
  `);

  const tokensBy = new Map(tokenCounts.map((r) => [r.client_id, r.n]));
  const consentsBy = new Map(consentCounts.map((r) => [r.client_id, r.n]));

  return c.json(
    rows.map((r) => ({
      clientId: r.clientId,
      name: r.name,
      uri: r.uri,
      disabled: Boolean(r.disabled),
      createdAt: r.createdAt ? Number(r.createdAt) : null,
      activeTokens: tokensBy.get(r.clientId) ?? 0,
      consentCount: consentsBy.get(r.clientId) ?? 0,
    })),
    200,
  );
});

const revokeRoute = createRoute({
  method: "delete",
  path: "/{clientId}",
  tags: ["OAuth Apps"],
  security: bearerSecurity,
  description:
    "Revoke an OAuth client: deletes its access tokens, refresh tokens, consents, and the client itself. Any MCP connection using it stops working on its next call.",
  request: { params: z.object({ clientId: z.string() }) },
  responses: {
    ...json200Response(
      z.object({
        success: z.boolean(),
        accessTokensRevoked: z.number(),
        refreshTokensRevoked: z.number(),
      }),
      "Client revoked",
    ),
    404: {
      description: "No such client",
      content: {
        "application/json": { schema: z.object({ error: z.string() }) },
      },
    },
  },
});

oauthAppsRouter.openapi(revokeRoute, async (c) => {
  const db = c.get("db");
  const { clientId } = c.req.valid("param");

  const existing = await db
    .select({ clientId: oauthClients.clientId })
    .from(oauthClients)
    .where(eq(oauthClients.clientId, clientId))
    .limit(1);
  if (existing.length === 0) {
    return c.json({ error: "Client not found" }, 404);
  }

  const access = await db
    .select({ id: oauthAccessTokens.id })
    .from(oauthAccessTokens)
    .where(eq(oauthAccessTokens.clientId, clientId));
  const refresh = await db
    .select({ id: oauthRefreshTokens.id })
    .from(oauthRefreshTokens)
    .where(eq(oauthRefreshTokens.clientId, clientId));

  // Tokens are verified offline against JWKS, so deleting rows does not by
  // itself stop an access token before it expires. Removing the client is what
  // actually cuts the connection off: the MCP path resolves the client on every
  // call, and the refresh grant has nothing left to exchange against.
  await db
    .delete(oauthAccessTokens)
    .where(eq(oauthAccessTokens.clientId, clientId));
  await db
    .delete(oauthRefreshTokens)
    .where(eq(oauthRefreshTokens.clientId, clientId));
  await db.delete(oauthConsents).where(eq(oauthConsents.clientId, clientId));
  await db.delete(oauthClients).where(eq(oauthClients.clientId, clientId));

  return c.json(
    {
      success: true,
      accessTokensRevoked: access.length,
      refreshTokensRevoked: refresh.length,
    },
    200,
  );
});
