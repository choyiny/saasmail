/**
 * Resolving an OAuth access token to the principal it acts for.
 *
 * Access tokens verify offline against the JWKS, so the signature alone proves
 * only that this deployment minted the token at some point. Everything that can
 * revoke a live token — disabling the client, deleting or banning the user,
 * removing their passkey — lives in the database and has to be re-checked on
 * every request. The MCP handler already did all of this; extracting it here
 * means `/api/*` cannot accidentally accept a token on weaker terms, and a
 * future revocation rule is added once rather than twice.
 *
 * On audiences: this deliberately verifies against the audiences the
 * deployment already issues rather than introducing a distinct one for the API.
 * `@better-auth/oauth-provider` at the pinned version is subject to
 * GHSA-p2fr-6hmx-4528, where the authorization-time resource is dropped and the
 * token endpoint will mint a token for any other allowlisted audience. A
 * separate `/api` audience would therefore look like an authorization boundary
 * without being one. Scopes are the boundary, and they are enforced per route.
 */
import { eq } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { verifyJwsAccessToken } from "better-auth/oauth2";
import type { JSONWebKeySet, JWTPayload } from "jose";
import { createAuth } from "../auth";
import { parseScopes } from "../auth/scopes";
import { users, passkeys, oauthClients } from "../db/auth.schema";
import {
  resolveAllowedInboxes,
  type AllowedInboxes,
} from "./inbox-permissions";
import { isDevEnvironment } from "./is-dev";
import { mcpAudience, oauthIssuer } from "../mcp/resource";

export interface OAuthPrincipal {
  user: {
    id: string;
    name: string | null;
    email: string;
    role: string | null;
  };
  allowed: AllowedInboxes;
  scopes: string[];
  /** The client the token was issued to (`azp`), for revocation and auditing. */
  clientId: string;
}

/**
 * Why a token was rejected, as a reason the caller maps onto its own contract.
 *
 * The two surfaces answer differently and must keep doing so: `/mcp` replies
 * with a `WWW-Authenticate` bearer challenge, while `/api/*` has a documented
 * `403 { code: "PASSKEY_REQUIRED" }` that its clients already branch on.
 * Collapsing them into one generic error would make a client retry a refresh
 * against a failure a new token cannot fix.
 */
export type PrincipalFailure =
  | { reason: "no_token"; message: string }
  | { reason: "invalid_token"; message: string }
  | { reason: "client_revoked"; message: string }
  | { reason: "unknown_user"; message: string }
  | { reason: "suspended"; message: string }
  | { reason: "passkey_required"; message: string };

export type PrincipalResult =
  | { ok: true; principal: OAuthPrincipal }
  | { ok: false; failure: PrincipalFailure };

/** Stable key so the JWKS is cached across requests rather than re-read. */
const JWKS_CACHE_KEY = {};

/**
 * Extract a bearer token that is *not* an API key.
 *
 * `sk_` keys travel in the same header and are handled by their own branch, so
 * they must not be fed to JWT verification — it would fail and turn a valid
 * API-key request into an invalid-token error.
 */
export function bearerAccessToken(header: string | undefined): string | null {
  if (!header?.startsWith("Bearer ")) return null;
  const token = header.slice("Bearer ".length);
  if (!token || token.startsWith("sk_")) return null;
  return token;
}

export async function resolveOAuthPrincipal(args: {
  db: DrizzleD1Database<any>;
  env: CloudflareBindings;
  token: string;
  baseURL: string;
  /**
   * Audiences to accept. `/mcp` passes its own so its behaviour is unchanged;
   * `/api/*` passes the full issued set. Defaults to that set.
   */
  audience?: string | string[];
}): Promise<PrincipalResult> {
  const { db, env, token, baseURL } = args;
  const audience = args.audience ?? [
    oauthIssuer(baseURL),
    mcpAudience(baseURL),
  ];

  let jwt: JWTPayload;
  try {
    jwt = await verifyJwsAccessToken(token, {
      // Built inside the closure so the JWKS is fetched about once per cache
      // window rather than constructing a full betterAuth instance per request.
      jwksFetch: async () =>
        (await createAuth(env).api.getJwks()) as unknown as JSONWebKeySet,
      jwksCacheKey: JWKS_CACHE_KEY,
      verifyOptions: {
        issuer: oauthIssuer(baseURL),
        // See the module comment: with the advisory in play the audience is
        // not a boundary we can lean on, so it is a sanity check and scopes do
        // the real work.
        audience,
      },
    });
  } catch {
    return {
      ok: false,
      failure: fail("invalid_token", "invalid access token"),
    };
  }

  const userId = jwt.sub;
  if (!userId) {
    return {
      ok: false,
      failure: fail("invalid_token", "invalid token subject"),
    };
  }

  // Tokens verify offline against JWKS, so without this a revoked client would
  // keep working until its token expired and could refresh past that. Checking
  // `azp` on every call is what makes "revoke access at any time" true.
  const clientId = typeof jwt.azp === "string" ? jwt.azp : undefined;
  if (!clientId) {
    return {
      ok: false,
      failure: fail("invalid_token", "invalid token client"),
    };
  }
  const client = await db
    .select({ disabled: oauthClients.disabled })
    .from(oauthClients)
    .where(eq(oauthClients.clientId, clientId))
    .limit(1);
  if (client.length === 0 || client[0].disabled) {
    return { ok: false, failure: fail("client_revoked", "client revoked") };
  }

  const rows = await db
    .select({
      id: users.id,
      name: users.name,
      email: users.email,
      role: users.role,
      banned: users.banned,
      banExpires: users.banExpires,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  // The user may have been deleted since the token was minted.
  if (rows.length === 0) {
    return { ok: false, failure: fail("unknown_user", "unknown user") };
  }
  const user = rows[0];

  // The only thing that can revoke a live offline-verified token.
  if (user.banned && (!user.banExpires || user.banExpires > new Date())) {
    return { ok: false, failure: fail("suspended", "account suspended") };
  }

  // The same rule requirePasskey enforces for session users. A bearer token is
  // minted after a browser login, but that login does not require a passkey —
  // password sign-in is available to any account that has not registered one —
  // so the token is not evidence that one exists. Exempting bearer callers
  // would make "passkey registration is required to access data" false.
  if (!isDevEnvironment(env)) {
    const pk = await db
      .select({ id: passkeys.id })
      .from(passkeys)
      .where(eq(passkeys.userId, user.id))
      .limit(1);
    if (pk.length === 0) {
      return {
        ok: false,
        failure: fail("passkey_required", "passkey registration required"),
      };
    }
  }

  return {
    ok: true,
    principal: {
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
      },
      allowed: await resolveAllowedInboxes(db, user),
      scopes: parseScopes(jwt.scope ?? (jwt as { scp?: unknown }).scp),
      clientId,
    },
  };
}

function fail(
  reason: PrincipalFailure["reason"],
  message: string,
): PrincipalFailure {
  return { reason, message } as PrincipalFailure;
}
