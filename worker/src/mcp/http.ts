import type { Hono } from "hono";
import { StreamableHTTPTransport } from "@hono/mcp";
import {
  oauthProviderAuthServerMetadata,
  oauthProviderOpenIdConfigMetadata,
} from "@better-auth/oauth-provider";
import { createAuth } from "../auth";
import { resolveOAuthPrincipal } from "../lib/oauth-principal";
import { OAUTH_SCOPES } from "../auth";
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

    const db = c.get("db");

    // Same resolver `/api/*` uses, so client revocation, ban and passkey
    // rules cannot drift between the two bearer surfaces. The audience stays
    // narrowed to this endpoint, preserving previous behaviour exactly.
    const result = await resolveOAuthPrincipal({
      db: c.get("db"),
      env: c.env,
      token,
      baseURL,
      audience: mcpAudience(baseURL),
    });
    if (!result.ok) {
      return unauthorized(baseURL, result.failure.message);
    }
    const { user, allowed, scopes } = result.principal;

    const server = buildMcpServer({ db, env: c.env, user, allowed, scopes });
    const transport = new StreamableHTTPTransport();
    await server.connect(transport);
    return transport.handleRequest(c);
  });
}

/**
 * RFC 9728 challenge telling the client where to discover how to authenticate.
 * Byte-compatible with what `mcpHandler` emits: the metadata path is the
 * well-known prefix plus the audience URL's pathname.
 */
function unauthorized(baseURL: string, message: string): Response {
  // Built from the same constant the route is registered on, so the challenge
  // cannot drift from the path that actually serves the document.
  const origin = new URL(baseURL).origin;
  return new Response(JSON.stringify({ error: message }), {
    status: 401,
    headers: {
      "Content-Type": "application/json",
      "WWW-Authenticate": `Bearer resource_metadata="${origin}${PROTECTED_RESOURCE_METADATA_PATH}"`,
    },
  });
}
