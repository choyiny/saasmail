// The logged-out leg of authorize: every other OAuth test signs in first (see
// `runFlow` in mcp-helpers), so this branch is otherwise uncovered.
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

    // LoginPage keys on these two to detect a pending authorization.
    expect(query.get("client_id")).toBe(params.client_id);
    expect(query.get("sig"), "login redirect was not signed").toBeTruthy();

    expect(query.get("exp"), "login redirect had no expiry").toBeTruthy();
    expect(Number(query.get("exp"))).toBeGreaterThan(Date.now() / 1000);

    expect(query.get("scope")).toBe(params.scope);
    expect(query.get("redirect_uri")).toBe(REDIRECT_URI);
    expect(query.get("state")).toBe("test-state");
    expect(query.get("code_challenge")).toBe(params.code_challenge);
  });

  it("resumes the flow when those parameters are replayed with a session", async () => {
    const { params } = await buildParams();

    const jar = new Jar();
    const first = await authorize(jar, params);
    const location = first.headers.get("location") ?? "";
    const pending = location.slice(location.indexOf("?") + 1);
    expect(pending).toBeTruthy();

    await signIn(jar, USER);

    // Replay the same parameters, as LoginPage now does.
    const resumed = jar.absorb(
      await req(`/api/auth/oauth2/authorize?${pending}`, {
        headers: { cookie: jar.header },
        redirect: "manual",
      }),
    );

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
