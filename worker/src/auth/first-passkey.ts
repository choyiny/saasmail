import { isAPIError } from "better-auth/api";
import { and, count, eq, ne } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import {
  oauthAccessTokens,
  oauthConsents,
  oauthRefreshTokens,
  passkeys,
  sessions,
} from "../db/auth.schema";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = DrizzleD1Database<any>;

/** What this hook reads of a finished better-auth request. */
export interface FirstPasskeyContext {
  path?: string;
  context?: {
    returned?: unknown;
    session?: {
      user?: { id: string } | null;
      session?: { token?: string } | null;
    } | null;
  };
}

/**
 * When an account registers its first passkey, ends every other session and
 * every OAuth grant it had. Until then a password session can do nothing but
 * register a passkey; without this, a session or an MCP grant opened in that
 * window by someone who knew the password would become full access the
 * moment the real user registered. The session that registered stays.
 * Returns whether it revoked anything.
 */
export async function revokeOnFirstPasskey(
  db: Db,
  ctx: FirstPasskeyContext,
): Promise<boolean> {
  if (ctx.path !== "/passkey/verify-registration") return false;
  const returned = ctx.context?.returned;
  if (
    isAPIError(returned) ||
    returned instanceof Error ||
    (returned instanceof Response && returned.status >= 400)
  ) {
    return false;
  }
  const userId = ctx.context?.session?.user?.id;
  const current = ctx.context?.session?.session?.token;
  if (!userId || !current) return false;

  const [registered] = await db
    .select({ n: count() })
    .from(passkeys)
    .where(eq(passkeys.userId, userId));
  if (Number(registered?.n ?? 0) !== 1) return false;

  await db.batch([
    db
      .delete(sessions)
      .where(and(eq(sessions.userId, userId), ne(sessions.token, current))),
    db.delete(oauthAccessTokens).where(eq(oauthAccessTokens.userId, userId)),
    db.delete(oauthRefreshTokens).where(eq(oauthRefreshTokens.userId, userId)),
    db.delete(oauthConsents).where(eq(oauthConsents.userId, userId)),
  ]);
  return true;
}
