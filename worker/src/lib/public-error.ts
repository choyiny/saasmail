import { APIError } from "better-auth/api";

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
 * Shared by the invite-acceptance and first-run setup routes so the two
 * cannot drift; both are reachable without a session.
 */
export function publicAuthFailure(
  err: unknown,
  fallback: string,
): PublicAuthFailure {
  if (err instanceof APIError) {
    return { body: err.message, internal: null };
  }
  return {
    body: fallback,
    internal: err instanceof Error ? err.message : "unknown error",
  };
}
