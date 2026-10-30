import type { MiddlewareHandler } from "hono";
import { eq } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { passkeys } from "../db/auth.schema";
import { isDevEnvironment } from "../lib/is-dev";
import type { Variables } from "../variables";

/**
 * Refuses requests from session-cookie users who have not registered a passkey.
 *
 * The frontend already redirects unregistered users to /setup-passkey, but that
 * gate is bypassable (curl, devtools). This middleware is the server-side
 * counterpart so passkey registration is actually required to access data.
 *
 * API-key authenticated requests are allowed through: issuance of an API key
 * already requires a passkey (see api-keys-router), so the holder must have
 * had one when the key was minted.
 *
 * Local development is exempt so the dev-mode client-side skip (see App.tsx)
 * doesn't get stopped at the server boundary.
 */
export async function passkeyRequired(
  env: CloudflareBindings,
  db: DrizzleD1Database<any>,
  user: { id: string },
  authMethod: "session" | "apiKey",
): Promise<boolean> {
  if (isDevEnvironment(env)) return false;
  if (authMethod === "apiKey") return false;

  const rows = await db
    .select({ id: passkeys.id })
    .from(passkeys)
    .where(eq(passkeys.userId, user.id))
    .limit(1);

  return rows.length === 0;
}

export const requirePasskey: MiddlewareHandler<{
  Bindings: CloudflareBindings;
  Variables: Variables;
}> = async (c, next) => {
  const user = c.get("user");
  if (!user) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  if (await passkeyRequired(c.env, c.get("db"), user, c.get("authMethod"))) {
    return c.json(
      { error: "Passkey registration required", code: "PASSKEY_REQUIRED" },
      403,
    );
  }

  return next();
};
