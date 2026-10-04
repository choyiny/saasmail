import { eq } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { createAuth } from "../auth";
import { apiKeys } from "../db/api-keys.schema";
import { users } from "../db/auth.schema";
import { hashKey } from "./crypto";

export type RequestAuthResult = {
  user: any;
  authMethod: "session" | "apiKey";
  /** The key that authenticated the request; its prefix names it in the audit log. */
  apiKey?: { id: string; prefix: string };
  /**
   * Set when the session is an admin acting as `user` (better-auth's
   * impersonation): the admin is who the audit log must name.
   */
  impersonatedBy?: { id: string; email: string | null };
};

export async function resolveRequestAuth(
  request: Request,
  env: CloudflareBindings,
  db: DrizzleD1Database<any>,
): Promise<RequestAuthResult | null> {
  const auth = createAuth(env);
  const session = await auth.api.getSession({ headers: request.headers });
  if (session) {
    const impersonatorId = (
      session.session as { impersonatedBy?: string | null }
    )?.impersonatedBy;
    if (!impersonatorId) return { user: session.user, authMethod: "session" };
    const [impersonator] = await db
      .select({ email: users.email })
      .from(users)
      .where(eq(users.id, impersonatorId))
      .limit(1);
    return {
      user: session.user,
      authMethod: "session",
      impersonatedBy: {
        id: impersonatorId,
        email: impersonator?.email ?? null,
      },
    };
  }

  const authHeader = request.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer sk_")) {
    return null;
  }

  const tokenHash = await hashKey(authHeader.slice(7));
  const rows = await db
    .select({
      userId: apiKeys.userId,
      id: apiKeys.id,
      prefix: apiKeys.keyPrefix,
    })
    .from(apiKeys)
    .where(eq(apiKeys.keyHash, tokenHash))
    .limit(1);

  if (rows.length === 0) {
    return null;
  }

  const userRows = await db
    .select()
    .from(users)
    .where(eq(users.id, rows[0].userId))
    .limit(1);

  if (userRows.length === 0) {
    return null;
  }

  return {
    user: userRows[0],
    authMethod: "apiKey",
    apiKey: { id: rows[0].id, prefix: rows[0].prefix },
  };
}
