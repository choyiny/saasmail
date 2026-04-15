import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { eq, and } from "drizzle-orm";
import {
  oauthClients,
  oauthConsents,
  oauthAccessTokens,
  oauthRefreshTokens,
} from "../db/auth.schema";
import { json200Response } from "../lib/helpers";
import type { Variables } from "../variables";

export const oauthAppsRouter = new OpenAPIHono<{
  Bindings: CloudflareBindings;
  Variables: Variables;
}>();

const OAuthAppSchema = z.object({
  clientId: z.string(),
  name: z.string().nullable(),
  createdAt: z.any(),
});

// --- LIST OAuth apps for current user ---
const listRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["OAuth Apps"],
  description: "List OAuth applications authorized by the current user.",
  responses: {
    ...json200Response(z.array(OAuthAppSchema), "List of OAuth apps"),
  },
});

oauthAppsRouter.openapi(listRoute, async (c) => {
  const db = c.get("db");
  const user = c.get("user");

  // Query consents to find clients this user has authorized
  const consentRows = await db
    .select({ clientId: oauthConsents.clientId })
    .from(oauthConsents)
    .where(eq(oauthConsents.userId, user.id));

  if (consentRows.length === 0) {
    return c.json([], 200);
  }

  // For each consent, get the client info
  const apps = [];
  for (const consent of consentRows) {
    const clientRows = await db
      .select({
        clientId: oauthClients.clientId,
        name: oauthClients.name,
        createdAt: oauthClients.createdAt,
      })
      .from(oauthClients)
      .where(eq(oauthClients.clientId, consent.clientId))
      .limit(1);

    if (clientRows.length > 0) {
      apps.push(clientRows[0]);
    }
  }

  return c.json(apps, 200);
});

// --- REVOKE an OAuth app ---
const revokeRoute = createRoute({
  method: "delete",
  path: "/{clientId}",
  tags: ["OAuth Apps"],
  description: "Revoke an OAuth application and delete its tokens/consents.",
  request: {
    params: z.object({ clientId: z.string() }),
  },
  responses: {
    ...json200Response(z.object({ success: z.boolean() }), "App revoked"),
  },
});

oauthAppsRouter.openapi(revokeRoute, async (c) => {
  const db = c.get("db");
  const user = c.get("user");
  const { clientId } = c.req.valid("param");

  // Delete consent for this user + client
  await db
    .delete(oauthConsents)
    .where(
      and(
        eq(oauthConsents.userId, user.id),
        eq(oauthConsents.clientId, clientId),
      ),
    );

  // Delete access tokens for this user + client
  await db
    .delete(oauthAccessTokens)
    .where(
      and(
        eq(oauthAccessTokens.userId, user.id),
        eq(oauthAccessTokens.clientId, clientId),
      ),
    );

  // Delete refresh tokens for this user + client
  await db
    .delete(oauthRefreshTokens)
    .where(
      and(
        eq(oauthRefreshTokens.userId, user.id),
        eq(oauthRefreshTokens.clientId, clientId),
      ),
    );

  return c.json({ success: true }, 200);
});
