import type { MiddlewareHandler } from "hono";
import { eq } from "drizzle-orm";
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
export const requirePasskey: MiddlewareHandler<{
  Bindings: CloudflareBindings;
  Variables: Variables;
}> = async (c, next) => {
  if (isDevEnvironment(c.env)) return next();
  if (c.get("authMethod") === "apiKey") return next();
  // OAuth callers are not exempt — `resolveOAuthPrincipal` applies the same
  // check while resolving the token and rejects with this route's own
  // `PASSKEY_REQUIRED` shape. Re-running it here would only repeat the query.
  if (c.get("authMethod") === "oauth") return next();

  const user = c.get("user");
  if (!user) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const db = c.get("db");
  const rows = await db
    .select({ id: passkeys.id })
    .from(passkeys)
    .where(eq(passkeys.userId, user.id))
    .limit(1);

  if (rows.length === 0) {
    return c.json(
      { error: "Passkey registration required", code: "PASSKEY_REQUIRED" },
      403,
    );
  }

  return next();
};
