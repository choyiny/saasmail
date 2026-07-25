import type { Hono } from "hono";
import { StreamableHTTPTransport } from "@hono/mcp";
import {
  oauthProviderAuthServerMetadata,
  oauthProviderOpenIdConfigMetadata,
} from "@better-auth/oauth-provider";
import { verifyJwsAccessToken } from "better-auth/oauth2";
import type { JSONWebKeySet, JWTPayload } from "jose";
import { eq } from "drizzle-orm";
import { createAuth } from "../auth";
import { OAUTH_SCOPES } from "../auth";
import { parseScopes } from "../auth/scopes";
import { users } from "../db/auth.schema";
import { resolveAllowedInboxes } from "../lib/inbox-permissions";
import { buildMcpServer } from "./server";
import {
  MCP_PATH,
  PROTECTED_RESOURCE_METADATA_PATH,
  mcpAudience,
  oauthIssuer,
  oauthJwksUrl,
} from "./resource";
import type { Variables } from "../variables";

type App = Hono<{ Bindings: CloudflareBindings; Variables: Variables }>;

function baseUrlOf(env: CloudflareBindings): string {
  return env.BASE_URL || "http://localhost:8080";
}

/**
 * RFC 9728 protected-resource metadata. The oauth-provider plugin does not
 * publish this itself (an authorization server normally isn't the resource
 * server), so we build the document. Scopes come from OAUTH_SCOPES rather than
 * a literal list — the previous implementation hardcoded them here and they
 * drifted from what the provider actually granted.
 */
function protectedResourceMetadata(env: CloudflareBindings) {
  const baseURL = baseUrlOf(env);
  return {
    resource: mcpAudience(baseURL),
    authorization_servers: [oauthIssuer(baseURL)],
    jwks_uri: oauthJwksUrl(baseURL),
    scopes_supported: OAUTH_SCOPES,
    bearer_methods_supported: ["header"],
  };
}

/**
 * Registers OAuth discovery documents and the MCP endpoint.
 *
 * Must be called before the SPA catch-all, or `/.well-known/*` falls through
 * to the asset handler and returns index.html to clients doing discovery.
 */
export function registerMcpRoutes(app: App) {
  // --- Discovery -----------------------------------------------------------
  // better-auth serves these under its basePath; MCP clients look for them at
  // the origin root, so they're re-exported here.
  const authServerMetadata = (c: {
    env: CloudflareBindings;
    req: { raw: Request };
  }) => oauthProviderAuthServerMetadata(createAuth(c.env))(c.req.raw);

  app.get("/.well-known/oauth-authorization-server", (c) =>
    authServerMetadata(c),
  );
  // RFC 8414: when the issuer has a path component, clients append it to the
  // well-known prefix. `yarn auth:generate` warns if this route is missing.
  app.get("/.well-known/oauth-authorization-server/api/auth", (c) =>
    authServerMetadata(c),
  );
  app.get("/.well-known/openid-configuration", (c) =>
    oauthProviderOpenIdConfigMetadata(createAuth(c.env))(c.req.raw),
  );

  // `mcpHandler` derives this path from the audience's pathname. The bare path
  // is served too, since some clients probe it before the suffixed form.
  app.get(PROTECTED_RESOURCE_METADATA_PATH, (c) =>
    c.json(protectedResourceMetadata(c.env)),
  );
  app.get("/.well-known/oauth-protected-resource", (c) =>
    c.json(protectedResourceMetadata(c.env)),
  );

  // --- MCP endpoint --------------------------------------------------------
  app.all(MCP_PATH, async (c) => {
    const baseURL = baseUrlOf(c.env);

    const authorization = c.req.header("Authorization");
    const token = authorization?.startsWith("Bearer ")
      ? authorization.slice("Bearer ".length)
      : undefined;

    if (!token) return unauthorized(baseURL, "missing authorization header");

    let jwt: JWTPayload;
    try {
      jwt = await verifyAccessTokenLocally(c.env, token, baseURL);
    } catch {
      return unauthorized(baseURL, "invalid access token");
    }

    const db = c.get("db");

    // `sub` is the user id — pairwise subject identifiers are not enabled.
    const userId = jwt.sub;
    if (!userId) return unauthorized(baseURL, "invalid token subject");

    const rows = await db
      .select({
        id: users.id,
        name: users.name,
        email: users.email,
        role: users.role,
      })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    // The user may have been deleted since the token was minted.
    if (rows.length === 0) return unauthorized(baseURL, "unknown user");
    const user = rows[0];

    const allowed = await resolveAllowedInboxes(db, user);
    const scopes = parseScopes(jwt.scope ?? (jwt as { scp?: unknown }).scp);

    const server = buildMcpServer({ db, env: c.env, user, allowed, scopes });
    const transport = new StreamableHTTPTransport();
    await server.connect(transport);
    return transport.handleRequest(c);
  });
}

/** Stable key so the JWKS is cached across requests rather than re-read. */
const JWKS_CACHE_KEY = {};

/**
 * Verify an MCP access token without leaving the isolate.
 *
 * The library's `mcpHandler` helper takes a `jwksUrl` *string*, which it
 * fetches over the network — meaning the Worker would issue a subrequest to
 * its own public hostname on every MCP call. That re-enters the Worker, adds
 * latency, and breaks anywhere the instance can't reach itself (tests, private
 * routes, Access-protected hostnames).
 *
 * `verifyJwsAccessToken` accepts a *function* JWKS source, so the keys are read
 * straight from the jwt plugin in-process. This is the same mechanism the
 * provider's own introspect endpoint uses internally. Everything else about the
 * OAuth flow still runs through the oauth-provider plugin.
 */
async function verifyAccessTokenLocally(
  env: CloudflareBindings,
  token: string,
  baseURL: string,
): Promise<JWTPayload> {
  const auth = createAuth(env);
  return verifyJwsAccessToken(token, {
    jwksFetch: async () =>
      (await auth.api.getJwks()) as unknown as JSONWebKeySet,
    jwksCacheKey: JWKS_CACHE_KEY,
    verifyOptions: {
      issuer: oauthIssuer(baseURL),
      audience: mcpAudience(baseURL),
    },
  });
}

/**
 * RFC 9728 challenge telling the client where to discover how to authenticate.
 * Byte-compatible with what `mcpHandler` emits: the metadata path is the
 * well-known prefix plus the audience URL's pathname.
 */
function unauthorized(baseURL: string, message: string): Response {
  const audience = new URL(mcpAudience(baseURL));
  const path = audience.pathname.endsWith("/")
    ? audience.pathname.slice(0, -1)
    : audience.pathname;
  return new Response(JSON.stringify({ error: message }), {
    status: 401,
    headers: {
      "Content-Type": "application/json",
      "WWW-Authenticate": `Bearer resource_metadata="${audience.origin}/.well-known/oauth-protected-resource${path}"`,
    },
  });
}
