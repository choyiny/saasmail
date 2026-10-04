import type { MiddlewareHandler } from "hono";
import { createAuth } from "../auth";
import { isDevEnvironment } from "../lib/is-dev";
import type { Variables } from "../variables";
import { passkeyRequired } from "./require-passkey";

/**
 * better-auth endpoints (paths under /api/auth) a session without a passkey
 * may still call: signing in and out, reading the session, registering the
 * first passkey, ending an impersonation, and the OAuth endpoints a client
 * calls with its own credentials or that only redirect.
 */
const ALLOWED_WITHOUT_PASSKEY = [
  /^\/get-session$/,
  /^\/sign-out$/,
  /^\/sign-in\//,
  /^\/passkey\//,
  /^\/admin\/stop-impersonating$/,
  /^\/oauth2\/(authorize|token|register|revoke|introspect|userinfo|end-session|public-client|public-client-prelogin)$/,
  /^\/jwks$/,
  /^\/\.well-known\//,
  /^\/(ok|error)$/,
];

/**
 * The /api/auth counterpart of `requirePasskey`. A password session whose
 * account has no passkey yet may do nothing but register one: /api refuses
 * it, and this refuses it on better-auth's own endpoints, which answer
 * before that middleware runs. Without it such a session could impersonate a
 * member (admin), change the account's email or password, or grant an OAuth
 * client, all with the password alone.
 */
export const authRoutePasskeyGate: MiddlewareHandler<{
  Bindings: CloudflareBindings;
  Variables: Variables;
}> = async (c, next) => {
  if (isDevEnvironment(c.env)) return next();
  const path = c.req.path.replace(/^\/api\/auth/, "");
  if (ALLOWED_WITHOUT_PASSKEY.some((allowed) => allowed.test(path))) {
    return next();
  }
  // No cookie, no session: better-auth answers for itself.
  if (!c.req.header("cookie")) return next();
  const session = await createAuth(c.env).api.getSession({
    headers: c.req.raw.headers,
  });
  if (!session?.user) return next();
  if (await passkeyRequired(c.env, c.get("db"), session.user, "session")) {
    return c.json(
      { error: "Passkey registration required", code: "PASSKEY_REQUIRED" },
      403,
    );
  }
  return next();
};
