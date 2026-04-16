import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { admin, openAPI, jwt } from "better-auth/plugins";
import { oauthProvider } from "@better-auth/oauth-provider";
import { passkey } from "@better-auth/passkey";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { schema } from "../db/schema";
import { oauthAccessTokens } from "../db/auth.schema";
import type { DrizzleD1Database } from "drizzle-orm/d1";

export function createAuth(
  env?: CloudflareBindings,
  _unused?: undefined,
  host?: string,
) {
  const db = env ? drizzle(env.DB, { schema, logger: true }) : ({} as any);
  const baseURL = host
    ? `https://${host}`
    : env?.BASE_URL || "http://localhost:8080";

  return betterAuth({
    baseURL,
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
        requirePKCE: true,
        allowPlainCodeChallengeMethod: false,
        allowDynamicClientRegistration: true,
        allowUnauthenticatedClientRegistration: true,
      }),
    ],
    advanced: {
      cookiePrefix: env?.COOKIE_PREFIX || "cmail",
      defaultCookieAttributes: { sameSite: "lax", secure: true },
    },
    trustedOrigins: env?.TRUSTED_ORIGINS
      ? env.TRUSTED_ORIGINS.split(",")
      : ["http://localhost:8080"],
  });
}

export const auth = createAuth();

/**
 * Validate an OAuth bearer token by looking it up in the oauthAccessTokens
 * table. Returns `{ userId }` on success, or `null` if the token is missing,
 * unknown, or expired. Used by the MCP route to authenticate requests.
 */
export async function getOAuthSession(
  db: DrizzleD1Database<any>,
  headers: Headers,
): Promise<{ userId: string } | null> {
  const token = headers.get("Authorization")?.replace("Bearer ", "");
  if (!token) return null;

  const rows = await db
    .select({
      userId: oauthAccessTokens.userId,
      expiresAt: oauthAccessTokens.expiresAt,
    })
    .from(oauthAccessTokens)
    .where(eq(oauthAccessTokens.token, token));

  const record = rows[0];
  if (!record?.userId) return null;
  if (record.expiresAt && record.expiresAt < new Date()) return null;

  return { userId: record.userId };
}
