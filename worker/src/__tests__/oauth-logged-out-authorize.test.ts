/**
 * The logged-out leg of the authorization-code flow.
 *
 * Every other OAuth test signs in *before* calling authorize (see `runFlow` in
 * mcp-helpers), so the branch a real client actually takes — arriving with no
 * session, being sent to the login page, and coming back — has no coverage.
 * That is the branch a native or third-party client hits on every first
 * connection, since it never has a browser session to begin with.
 *
 * These assert the contract `LoginPage` depends on: authorize hands the pending
 * request to the login page as signed query parameters, and replaying those
 * exact parameters once a session exists resumes the flow rather than starting
 * a new one.
 */
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { applyMigrations, cleanDb } from "./helpers";
import {
  ALL_SCOPES,
  Jar,
  REDIRECT_URI,
  type Credentials,
  createUserWithPassword,
  pkce,
  registerClient,
  req,
  signIn,
} from "./mcp-helpers";

const USER: Credentials = {
  name: "Owner",
  email: "owner@saasmail.test",
  password: "correct-horse-battery",
};

/** Start an authorization request with whatever session the jar holds. */
async function authorize(jar: Jar, params: Record<string, string>) {
  return jar.absorb(
    await req(`/api/auth/oauth2/authorize?${new URLSearchParams(params)}`, {
      headers: { cookie: jar.header },
      redirect: "manual",
    }),
  );
}

async function buildParams() {
  const { client_id } = await registerClient(ALL_SCOPES);
  const { challenge, verifier } = await pkce();
  return {
    verifier,
    params: {
      client_id,
      redirect_uri: REDIRECT_URI,
      response_type: "code",
      scope: ALL_SCOPES,
      code_challenge: challenge,
      code_challenge_method: "S256",
      state: "test-state",
    } as Record<string, string>,
  };
}

describe("authorize with no session", () => {
  beforeAll(applyMigrations);

  beforeEach(async () => {
    await cleanDb();
    await createUserWithPassword(USER, "admin");
  });

  it("redirects an unauthenticated request to the login page", async () => {
    const { params } = await buildParams();
    const res = await authorize(new Jar(), params);

    expect(res.status).toBeGreaterThanOrEqual(300);
    expect(res.status).toBeLessThan(400);

    const location = res.headers.get("location") ?? "";
    expect(location, "expected a redirect to the login page").toContain(
      "/login",
    );
  });

  it("carries the pending request to the login page as signed parameters", async () => {
    const { params } = await buildParams();
    const res = await authorize(new Jar(), params);

    const location = res.headers.get("location") ?? "";
    const query = new URLSearchParams(
      location.slice(location.indexOf("?") + 1),
    );

    // These two are exactly what LoginPage keys on to decide that a pending
    // authorization exists and must be resumed rather than dropped.
    expect(query.get("client_id")).toBe(params.client_id);
    expect(query.get("sig"), "login redirect was not signed").toBeTruthy();

    // Signed *and* bounded, so replaying it later is not an open-ended grant.
    expect(query.get("exp"), "login redirect had no expiry").toBeTruthy();
    expect(Number(query.get("exp"))).toBeGreaterThan(Date.now() / 1000);

    // The rest of the request survives the round trip, or resuming would
    // silently change what the user is consenting to.
    expect(query.get("scope")).toBe(params.scope);
    expect(query.get("redirect_uri")).toBe(REDIRECT_URI);
    expect(query.get("state")).toBe("test-state");
    expect(query.get("code_challenge")).toBe(params.code_challenge);
  });

  it("resumes the flow when those parameters are replayed with a session", async () => {
    const { params } = await buildParams();

    // 1. Arrive logged out and get bounced to the login page.
    const jar = new Jar();
    const first = await authorize(jar, params);
    const location = first.headers.get("location") ?? "";
    const pending = location.slice(location.indexOf("?") + 1);
    expect(pending).toBeTruthy();

    // 2. Sign in, as the user does on that page.
    await signIn(jar, USER);

    // 3. Hand the same parameters straight back — what LoginPage now does
    //    instead of navigating to "/".
    const resumed = jar.absorb(
      await req(`/api/auth/oauth2/authorize?${pending}`, {
        headers: { cookie: jar.header },
        redirect: "manual",
      }),
    );

    // The flow moves on: either straight to the client with a code, or to the
    // consent screen. What matters is that it is no longer asking for a login.
    const next = resumed.headers.get("location") ?? "";
    expect(
      next,
      `unexpected destination after resuming: ${next}`,
    ).not.toContain("/login");
    expect(
      next.startsWith(REDIRECT_URI) || next.includes("/consent"),
      `expected a code or the consent screen, got: ${next}`,
    ).toBe(true);
  });

  it("does not issue a code to an unauthenticated caller", async () => {
    const { params } = await buildParams();
    const res = await authorize(new Jar(), params);

    const location = res.headers.get("location") ?? "";
    expect(location.startsWith(REDIRECT_URI)).toBe(false);
    expect(location).not.toContain("code=");
  });
});
