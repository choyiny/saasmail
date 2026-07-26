import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { applyMigrations, cleanDb } from "./helpers";
import {
  BASE_URL,
  MCP_AUDIENCE,
  REDIRECT_URI,
  type Credentials,
  Jar,
  createUserWithPassword,
  json,
  pkce,
  registerClient,
  req,
  signIn,
} from "./mcp-helpers";

const ADMIN: Credentials = {
  name: "Owner",
  email: "owner@saasmail.test",
  password: "correct-horse-battery",
};

/**
 * The consent screen renders the scope list from the *visible* `scope` query
 * parameter, while the grant is recorded from the signed `oauth_query` blob.
 * If those can diverge, an attacker could show a victim "Verify your identity"
 * and have them approve full mailbox read/send/delete.
 *
 * This asserts they cannot: `scope` is covered by the signature.
 */
describe("consent request tampering", () => {
  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDb();
    await createUserWithPassword(ADMIN, "admin");
  });

  it("rejects a consent whose scope was altered after signing", async () => {
    const jar = new Jar();
    await signIn(jar, ADMIN);
    const { client_id } = await registerClient(
      "openid email:read email:send email:manage",
    );
    const { challenge } = await pkce();

    const authorizeRes = jar.absorb(
      await req(
        `/api/auth/oauth2/authorize?${new URLSearchParams({
          client_id,
          redirect_uri: REDIRECT_URI,
          response_type: "code",
          scope: "openid email:read email:send email:manage",
          resource: MCP_AUDIENCE,
          code_challenge: challenge,
          code_challenge_method: "S256",
        })}`,
        { headers: { cookie: jar.header }, redirect: "manual" },
      ),
    );
    const location = authorizeRes.headers.get("location") ?? "";
    const signedQuery = location.slice(location.indexOf("?") + 1);

    // Sanity: the untampered query is accepted.
    expect(signedQuery).toContain("scope=");

    // Now downgrade only the visible scope, as a phishing link would.
    const tampered = new URLSearchParams(signedQuery);
    tampered.set("scope", "openid");

    const res = await json(
      "/api/auth/oauth2/consent",
      { accept: true, oauth_query: tampered.toString() },
      { headers: { cookie: jar.header, Origin: BASE_URL } },
    );

    const body = await res.text();
    expect(res.status, `tampered consent was accepted: ${body}`).not.toBe(200);
    expect(body).toContain("invalid_signature");
  });

  it("covers scope with the signature", async () => {
    const jar = new Jar();
    await signIn(jar, ADMIN);
    const { client_id } = await registerClient("openid email:read");
    const { challenge } = await pkce();

    const authorizeRes = jar.absorb(
      await req(
        `/api/auth/oauth2/authorize?${new URLSearchParams({
          client_id,
          redirect_uri: REDIRECT_URI,
          response_type: "code",
          scope: "openid email:read",
          resource: MCP_AUDIENCE,
          code_challenge: challenge,
          code_challenge_method: "S256",
        })}`,
        { headers: { cookie: jar.header }, redirect: "manual" },
      ),
    );
    const location = authorizeRes.headers.get("location") ?? "";
    const params = new URLSearchParams(
      location.slice(location.indexOf("?") + 1),
    );
    // The signed-parameter allowlist must include `scope`, or the consent
    // screen could be made to display something other than what is granted.
    expect(params.getAll("ba_param")).toContain("scope");
  });
});
