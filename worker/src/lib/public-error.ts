import { APIError } from "better-auth/api";

/**
 * A status the visitor could do something about. Anything outside 400–499 —
 * including an `APIError` carrying a 500 — is an internal failure whose text
 * belongs in the log.
 */
function isClientError(statusCode: unknown): boolean {
  return (
    typeof statusCode === "number" && statusCode >= 400 && statusCode < 500
  );
}

export type PublicAuthFailure = {
  /** Safe to return to an unauthenticated visitor. */
  body: string;
  /** Internal detail for the Worker log, or null when there is none. */
  internal: string | null;
};

/**
 * Decide what a **public** route may tell an unauthenticated visitor about a
 * failed `auth.api.createUser`.
 *
 * better-auth raises `APIError` for the cases the visitor can fix, and its
 * `message` is the library's own form-facing text ("User already exists",
 * "Password too short"). Anything else is an internal failure: a D1 error's
 * message names the statement it was running, and on these routes its bound
 * parameters are the credentials being registered. That text goes to the log
 * and never into a response body.
 *
 * `instanceof` fails closed — an error that is not the `APIError` subclass
 * takes the generic branch — which is the direction a mistake here should go.
 *
 * The status check is the other half of that. `APIError` is also how
 * better-auth raises its own INTERNAL failures: `to-auth-endpoints.mjs` wraps
 * a `BetterAuthError`'s message into a 500 `APIError`, and forwarding that
 * would hand an unauthenticated visitor internal text under a rule written
 * for form-facing 4xx. That path needs a dynamic `baseURL` and `auth/index.ts`
 * sets a static one, so it is not live today — which makes the rule hold by
 * coincidence rather than by construction. 4xx is the whole of what a visitor
 * can act on, so 4xx is the whole of what they are told.
 *
 * Shared by the invite-acceptance and first-run setup routes so the two
 * cannot drift; both are reachable without a session.
 */
export function publicAuthFailure(
  err: unknown,
  fallback: string,
): PublicAuthFailure {
  if (err instanceof APIError && isClientError(err.statusCode)) {
    return { body: err.message, internal: null };
  }
  return {
    body: fallback,
    internal: err instanceof Error ? err.message : "unknown error",
  };
}
