/**
 * Capability scopes for the MCP surface.
 *
 * Kept in their own module (rather than in auth/index.ts) so the MCP server can
 * import them without pulling in betterAuth() and its Drizzle adapter — the
 * auth module instantiates a client at import time.
 */
export const SCOPE_READ = "email:read";
export const SCOPE_SEND = "email:send";
export const SCOPE_MANAGE = "email:manage";

export const MCP_SCOPES = [SCOPE_READ, SCOPE_SEND, SCOPE_MANAGE] as const;

export type McpScope = (typeof MCP_SCOPES)[number];

/** Human-readable descriptions, shown on the consent screen. */
export const SCOPE_DESCRIPTIONS: Record<string, string> = {
  openid: "Verify your identity",
  profile: "Read your name and profile details",
  email: "Read your email address",
  offline_access: "Stay connected when you are not using the app",
  [SCOPE_READ]: "Read your mail, contacts, and templates",
  [SCOPE_SEND]: "Send mail and enroll contacts in sequences",
  [SCOPE_MANAGE]: "Mark mail as read and delete mail",
};

/**
 * Scopes are space-delimited per RFC 6749. An access token carries them in the
 * `scope` claim; some issuers use the `scp` array form, so accept both.
 */
export function parseScopes(claim: unknown): string[] {
  if (Array.isArray(claim)) return claim.filter((s) => typeof s === "string");
  if (typeof claim === "string") return claim.split(" ").filter(Boolean);
  return [];
}

export function hasScope(granted: string[], required: string): boolean {
  return granted.includes(required);
}
