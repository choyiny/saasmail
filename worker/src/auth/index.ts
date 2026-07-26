import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { admin, openAPI, jwt } from "better-auth/plugins";
import { oauthProvider } from "@better-auth/oauth-provider";
import { passkey } from "@better-auth/passkey";
import { drizzle } from "drizzle-orm/d1";
import { schema } from "../db/schema";
import { MCP_SCOPES } from "./scopes";
import { mcpAudience, oauthIssuer } from "../mcp/resource";

/**
 * Scopes advertised to OAuth clients: the OpenID set plus saasmail's own
 * capability scopes. MCP tools are gated on the latter (see auth/scopes.ts).
 */
export const OAUTH_SCOPES = [
  "openid",
  "profile",
  "email",
  "offline_access",
  ...MCP_SCOPES,
];

export function createAuth(env?: CloudflareBindings) {
  const db = env ? drizzle(env.DB, { schema, logger: true }) : ({} as any);
  const baseURL = env?.BASE_URL || "http://localhost:8080";

  return betterAuth({
    baseURL,
    // Passed explicitly: better-auth resolves this from `process.env`, which
    // is not where `wrangler secret put` values reliably land. Without it the
    // library can silently fall back to its well-known default secret, which
    // would also protect the OAuth signing keys in `jwkss`.
    secret: env?.BETTER_AUTH_SECRET,
    database: drizzleAdapter(db, {
      provider: "sqlite",
      usePlural: true,
    }),
    emailAndPassword: {
      enabled: true,
      disableSignUp: true,
    },
    plugins: [
      admin(),
      openAPI(),
      passkey(),
      jwt(),
      oauthProvider({
        loginPage: "/login",
        consentPage: "/consent",
        // MCP clients (Claude, Copilot) self-register on first connect; there
        // is no way to pre-provision them, so RFC 7591 registration is open.
        // Registration only creates a client — it grants no access until a
        // user completes the login + consent flow.
        allowDynamicClientRegistration: true,
        allowUnauthenticatedClientRegistration: true,
        scopes: OAUTH_SCOPES,
        // A `resource` outside this list is rejected as invalid_request, and
        // an access token is only issued as a *JWT* when a resource was
        // requested — an opaque token can't be verified locally against JWKS.
        // The MCP audience therefore has to be declared here.
        validAudiences: [oauthIssuer(baseURL), mcpAudience(baseURL)],
      }),
    ],
    advanced: {
      cookiePrefix: env?.COOKIE_PREFIX || "saasmail",
      defaultCookieAttributes: { sameSite: "lax", secure: true },
    },
    trustedOrigins: env?.TRUSTED_ORIGINS
      ? env.TRUSTED_ORIGINS.split(",")
      : ["http://localhost:8080"],
  });
}

export const auth = createAuth();
