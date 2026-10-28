import { auditAfterHook } from "./audit-hooks";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { admin, openAPI, jwt } from "better-auth/plugins";
import { oauthProvider } from "@better-auth/oauth-provider";
import { passkey } from "@better-auth/passkey";
import { createDb } from "../db/client";
import { isDevEnvironment } from "../lib/is-dev";
import { d1RateLimitStorage } from "./rate-limit-storage";
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

/**
 * One instance per isolate. `env` is the same object for every request an
 * isolate serves, and building a betterAuth instance is not free: plugin init
 * runs per instance, and the oauth-provider plugin's init reads
 * `oauth_resources` to seed it. The session middleware calls this on every
 * /api request.
 */
const instances = new WeakMap<
  CloudflareBindings,
  ReturnType<typeof buildAuth>
>();

export function createAuth(env?: CloudflareBindings) {
  if (!env) return buildAuth();
  let instance = instances.get(env);
  if (!instance) {
    instance = buildAuth(env);
    instances.set(env, instance);
  }
  return instance;
}

function buildAuth(env?: CloudflareBindings) {
  const db = env ? createDb(env) : ({} as any);
  const baseURL = env?.BASE_URL || "http://localhost:8080";

  // Fail closed rather than silently signing with better-auth's published
  // default. The library only *warns* when the secret is missing, and its
  // NODE_ENV check does not fire on Workers — so an operator who upgrades
  // without setting the secret would come up issuing OAuth tokens anyone can
  // forge. `env` is undefined only under the schema-generation CLI, which
  // never signs anything.
  if (env && !env.BETTER_AUTH_SECRET) {
    throw new Error(
      "BETTER_AUTH_SECRET is not set. Run `wrangler secret put BETTER_AUTH_SECRET` " +
        "(or add it to .dev.vars) — it signs sessions and protects the OAuth signing keys.",
    );
  }

  // better-auth's own endpoint paths, filled in once the instance exists:
  // the rate limiter counts a made-up path in a shared bucket.
  const servedPaths = new Set<string>();

  const auth = betterAuth({
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
    // Sign-ins, passkey changes and OAuth consent never pass a route of ours:
    // this hook is where the audit log sees them, and where registering a
    // first passkey ends the sessions and grants opened before it.
    hooks: { after: auditAfterHook(db) },
    // On everywhere but local development and demo deploys, counted in D1 so a
    // limit holds across isolates: better-auth's own default (in memory, and
    // only when NODE_ENV is "production") limited nothing on Workers. Its
    // built-in rules apply: 3 sign-in attempts per 10 seconds per address,
    // 100 requests per 10 seconds on any other auth path. Reading the
    // session is not limited: it guards nothing, and it would cost a D1
    // write on every page load.
    rateLimit: {
      enabled: !!env && !isDevEnvironment(env),
      ...(env
        ? {
            customStorage: d1RateLimitStorage(db, (path) =>
              servedPaths.has(path),
            ),
          }
        : {}),
      customRules: { "/get-session": false },
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
        // Desktop and CLI MCP clients (Claude Code, Cursor) register an
        // `http://localhost:<port>` callback. better-auth defaults a dynamic
        // registration to a "web" client, which must use https; "infer" makes
        // a loopback or custom-scheme registration a "native" client instead.
        clientRegistrationDefaultApplicationType: "infer",
        scopes: OAUTH_SCOPES,
        // A `resource` outside this list is rejected as invalid_target, and
        // an access token is only issued as a *JWT* when a resource was
        // requested — an opaque token can't be verified locally against JWKS.
        // The MCP audience therefore has to be declared here. (Seeded into
        // `oauth_resources` on first use; existing rows are left alone.)
        // Omitted for the schema CLI (no `env`, no database), whose seed
        // attempt would only log an error.
        resources: env ? [oauthIssuer(baseURL), mcpAudience(baseURL)] : [],
        // By default better-auth only lets a client request a resource it has
        // been linked to. Clients registered before the upgrade have no links,
        // so every connected MCP client would fail at its next token refresh.
        // Any client may request any resource above, as before.
        enforcePerClientResources: false,
      }),
    ],
    advanced: {
      // The address Cloudflare saw, for rate limits and session records.
      // Without it every client shares one rate-limit bucket. The IPv6 header
      // comes first: with Cloudflare's "Pseudo IPv4" it holds the real one.
      ipAddress: {
        ipAddressHeaders: ["cf-connecting-ipv6", "cf-connecting-ip"],
      },
      cookiePrefix: env?.COOKIE_PREFIX || "saasmail",
      defaultCookieAttributes: { sameSite: "lax", secure: true },
    },
    trustedOrigins: env?.TRUSTED_ORIGINS
      ? env.TRUSTED_ORIGINS.split(",")
      : ["http://localhost:8080"],
  });
  for (const endpoint of Object.values(auth.api)) {
    const path = (endpoint as { path?: unknown }).path;
    if (typeof path === "string") servedPaths.add(path);
  }
  return auth;
}

export const auth = createAuth();
