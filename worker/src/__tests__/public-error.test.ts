import { describe, it, expect } from "vitest";
import { APIError } from "better-auth/api";
import { publicAuthFailure } from "../lib/public-error";

/**
 * Both callers are public routes an unauthenticated visitor can reach, so
 * the question this answers is "what may a stranger be told". The `/api/setup`
 * caller cannot reach the APIError branch through its own validation — zod
 * refuses every malformed address and short password first — so this is the
 * only place that branch can be held in place at all.
 */
const FALLBACK = "Account creation failed. Please try again.";

describe("publicAuthFailure", () => {
  it("forwards better-auth's own message, with nothing to log", () => {
    const err = new APIError("BAD_REQUEST", {
      message: "User already exists",
    });
    const failure = publicAuthFailure(err, FALLBACK);
    expect(failure.body).toBe("User already exists");
    expect(failure.body).not.toBe(FALLBACK);
    // Nothing internal happened, so nothing goes to the log.
    expect(failure.internal).toBeNull();
  });

  it("keeps an internal error's text out of the body and puts it in the log", () => {
    // What a D1 failure looks like: the statement it was running, whose bound
    // parameters on this path are the credentials being registered.
    const err = new Error(
      'D1_ERROR: no such table: accounts at offset 12: INSERT INTO "accounts"',
    );
    const failure = publicAuthFailure(err, FALLBACK);
    expect(failure.body).toBe(FALLBACK);
    expect(failure.body).not.toMatch(/no such table|accounts|INSERT/i);
    // ...and it is not simply discarded.
    expect(failure.internal).toBe(err.message);
  });

  it("treats a 5xx APIError as internal, not as something the visitor can act on", () => {
    // `APIError` is also how better-auth raises its OWN internal failures —
    // `to-auth-endpoints.mjs` wraps a BetterAuthError's message into a 500
    // APIError. Keying only on the class forwarded that text to an
    // unauthenticated visitor under a rule written for form-facing 4xx.
    const err = new APIError("INTERNAL_SERVER_ERROR", {
      message: 'D1_ERROR near "INSERT INTO accounts": syntax error',
    });
    const failure = publicAuthFailure(err, FALLBACK);
    expect(failure.body).toBe(FALLBACK);
    expect(failure.body).not.toMatch(/D1_ERROR|accounts|INSERT/i);
    expect(failure.internal).toBe(err.message);
  });

  it("still forwards a 4xx APIError that is not BAD_REQUEST", () => {
    // The tightening is on the status, not on the code: a 403 or a 429 is
    // still something the visitor can act on.
    const err = new APIError("TOO_MANY_REQUESTS", {
      message: "Too many attempts. Try again later.",
    });
    const failure = publicAuthFailure(err, FALLBACK);
    expect(failure.body).toBe("Too many attempts. Try again later.");
    expect(failure.internal).toBeNull();
  });

  it("treats a non-Error throw as internal too", () => {
    const failure = publicAuthFailure("boom", FALLBACK);
    expect(failure.body).toBe(FALLBACK);
    expect(failure.internal).toBe("unknown error");
  });

  it("uses the fallback it was given, not a message of its own", () => {
    // The two callers word this differently; a hard-coded string here would
    // make one of them lie about which flow failed.
    const failure = publicAuthFailure(new Error("x"), "Signup failed.");
    expect(failure.body).toBe("Signup failed.");
  });
});
