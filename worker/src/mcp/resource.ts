/**
 * Canonical OAuth resource identifiers for the MCP endpoint.
 *
 * Everything derives from the configured `BASE_URL` rather than the incoming
 * request's host. An access token's `aud` is fixed at authorization time, so
 * issuing and verifying must agree on one canonical value; deriving it from
 * whichever host a client happened to connect to produces tokens that fail
 * verification on the next request. The previous MCP attempt tried to track
 * the request host dynamically and never got this stable.
 *
 * This module deliberately imports nothing — `auth/index.ts` imports it, so a
 * dependency in the other direction would be circular.
 */

/** Path the MCP streamable-HTTP endpoint is mounted at. */
export const MCP_PATH = "/mcp";

/** The `aud` claim MCP access tokens must carry, and the RFC 8707 `resource`. */
export function mcpAudience(baseURL: string): string {
  return `${baseURL}${MCP_PATH}`;
}

/**
 * better-auth's issuer is its `ctx.context.baseURL`, which includes the
 * basePath — not the bare app origin.
 */
export function oauthIssuer(baseURL: string): string {
  return `${baseURL}/api/auth`;
}

/** JWKS the resource server verifies access tokens against. */
export function oauthJwksUrl(baseURL: string): string {
  return `${oauthIssuer(baseURL)}/jwks`;
}

/**
 * Path `mcpHandler` points clients at in its `WWW-Authenticate` challenge.
 * It appends the audience URL's pathname to the well-known prefix, so an
 * audience of `https://host/mcp` resolves to
 * `https://host/.well-known/oauth-protected-resource/mcp`.
 */
export const PROTECTED_RESOURCE_METADATA_PATH = `/.well-known/oauth-protected-resource${MCP_PATH}`;
