import { eq } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { createAuth } from "../auth";
import { apiKeys } from "../db/api-keys.schema";
import { users } from "../db/auth.schema";
import { hashKey } from "./crypto";

export type RequestAuthResult = {
  user: any;
  authMethod: "session" | "apiKey";
};

export async function resolveRequestAuth(
  request: Request,
  env: CloudflareBindings,
  db: DrizzleD1Database<any>,
): Promise<RequestAuthResult | null> {
  const auth = createAuth(env);
  const session = await auth.api.getSession({ headers: request.headers });
  if (session) {
    return { user: session.user, authMethod: "session" };
  }

  const authHeader = request.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer sk_")) {
    return null;
  }

  const tokenHash = await hashKey(authHeader.slice(7));
  const rows = await db
    .select({ userId: apiKeys.userId })
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

  return { user: userRows[0], authMethod: "apiKey" };
}
