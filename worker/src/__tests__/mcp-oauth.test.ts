import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { eq, sql } from "drizzle-orm";
import { oauthRefreshTokens } from "../db/auth.schema";
import { applyMigrations, cleanDb, getDb } from "./helpers";
import {
  BASE_URL,
  ISSUER,
  MCP_AUDIENCE,
  REDIRECT_URI,
  type Credentials,
  Jar,
  callTool,
  createUserWithPassword,
  exchangeToken,
  getAccessToken,
  mcpRpc,
  pkce,
  readRpc,
  registerClient,
  req,
  runFlow,
  signIn,
} from "./mcp-helpers";

const ADMIN: Credentials = {
  name: "Owner",
  email: "owner@saasmail.test",
  password: "correct-horse-battery",
};

describe("MCP OAuth", () => {
  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDb();
    await createUserWithPassword(ADMIN, "admin");
  });

  describe("discovery", () => {
    it("publishes authorization server metadata at the well-known root", async () => {
      const res = await req("/.well-known/oauth-authorization-server");
      expect(res.status).toBe(200);
      const meta = (await res.json()) as Record<string, string>;
      expect(meta.issuer).toBe(ISSUER);
      expect(meta.authorization_endpoint).toBe(`${ISSUER}/oauth2/authorize`);
      expect(meta.token_endpoint).toBe(`${ISSUER}/oauth2/token`);
      expect(meta.registration_endpoint).toBe(`${ISSUER}/oauth2/register`);
    });

    it("serves the issuer-path variant required by RFC 8414", async () => {
      const res = await req("/.well-known/oauth-authorization-server/api/auth");
      expect(res.status).toBe(200);
      expect(((await res.json()) as { issuer: string }).issuer).toBe(ISSUER);
    });

    it("publishes openid configuration", async () => {
      const res = await req("/.well-known/openid-configuration");
      expect(res.status).toBe(200);
      expect(((await res.json()) as { issuer: string }).issuer).toBe(ISSUER);
    });

    it("publishes protected resource metadata at the audience path", async () => {
      const res = await req("/.well-known/oauth-protected-resource/mcp");
      expect(res.status).toBe(200);
      const meta = (await res.json()) as {
        resource: string;
        authorization_servers: string[];
        scopes_supported: string[];
      };
      expect(meta.resource).toBe(MCP_AUDIENCE);
      expect(meta.authorization_servers).toContain(ISSUER);
      // Advertised scopes must match what the provider can actually grant.
      expect(meta.scopes_supported).toEqual(
        expect.arrayContaining(["email:read", "email:send", "email:manage"]),
      );
    });

    it("does not let the SPA catch-all swallow discovery routes", async () => {
      const res = await req("/.well-known/oauth-protected-resource/mcp");
      expect(res.headers.get("content-type")).toContain("application/json");
    });
  });

  describe("unauthenticated access", () => {
    it("rejects /mcp without a token and points at resource metadata", async () => {
      const res = await req("/mcp", { method: "POST", body: "{}" });
      expect(res.status).toBe(401);

      const challenge = res.headers.get("WWW-Authenticate") ?? "";
      expect(challenge).toContain("Bearer");
      // Derived from the *audience* origin (BASE_URL), not the request host —
      // that stability is the point of using a canonical audience.
      expect(challenge).toContain(
        `resource_metadata="${BASE_URL}/.well-known/oauth-protected-resource/mcp"`,
      );
    });

    it("rejects a malformed bearer token", async () => {
      const res = await mcpRpc("not-a-real-token", "tools/list");
      expect(res.status).toBe(401);
    });

    it("exposes WWW-Authenticate to cross-origin callers", async () => {
      const res = await req("/mcp", {
        method: "POST",
        body: "{}",
        headers: { Origin: "https://claude.ai" },
      });
      // Without this a browser MCP client sees an opaque 401.
      expect(
        res.headers.get("access-control-expose-headers")?.toLowerCase(),
      ).toContain("www-authenticate");
    });
  });

  describe("authorization code flow", () => {
    it("issues a token that authenticates an MCP call", async () => {
      const token = await getAccessToken(ADMIN, "openid email:read");
      const res = await mcpRpc(token, "tools/list");
      expect(res.status).toBe(200);

      const body = await readRpc(res);
      const names = (body.result.tools as Array<{ name: string }>).map(
        (t) => t.name,
      );
      expect(names).toContain("whoami");
    });

    it("issues a JWT access token bound to the MCP audience", async () => {
      const token = await getAccessToken(ADMIN, "openid email:read");
      // A JWT is only issued when a valid `resource` was requested; an opaque
      // token here would mean validAudiences is misconfigured.
      const [, payload] = token.split(".");
      expect(payload, "access token is not a JWT").toBeTruthy();
      const claims = JSON.parse(
        atob(payload.replace(/-/g, "+").replace(/_/g, "/")),
      );
      // `aud` is an array when the openid scope is present, because the
      // provider also adds the userinfo endpoint as an audience.
      const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
      expect(audiences).toContain(MCP_AUDIENCE);
      expect(claims.iss).toBe(ISSUER);
    });

    it("resolves the token's subject to the authenticated user", async () => {
      const token = await getAccessToken(ADMIN, "openid email:read");
      const res = await mcpRpc(token, "tools/call", {
        name: "whoami",
        arguments: {},
      });
      const body = await readRpc(res);
      const payload = JSON.parse(body.result.content[0].text);
      expect(payload.email).toBe(ADMIN.email);
      expect(payload.inboxes).toBe("all"); // first user is an admin
    });

    it("rejects an authorization code replayed a second time", async () => {
      const { code, verifier, clientId } = await runFlow(
        ADMIN,
        "openid email:read",
      );
      const exchange = () =>
        exchangeToken({
          grant_type: "authorization_code",
          code,
          redirect_uri: REDIRECT_URI,
          client_id: clientId,
          code_verifier: verifier,
          resource: MCP_AUDIENCE,
        });

      expect((await exchange()).status).toBe(200);
      expect((await exchange()).status).not.toBe(200);
    });

    it("rejects a token exchange with the wrong PKCE verifier", async () => {
      const { code, clientId } = await runFlow(ADMIN, "openid email:read");
      const res = await exchangeToken({
        grant_type: "authorization_code",
        code,
        redirect_uri: REDIRECT_URI,
        client_id: clientId,
        code_verifier: "wrong-verifier-entirely",
        resource: MCP_AUDIENCE,
      });
      expect(res.status).not.toBe(200);
    });

    it("rejects a resource that isn't a configured resource", async () => {
      // Rejected at authorize: the client is sent back with invalid_target
      // and no code, so there is nothing to exchange.
      const jar = new Jar();
      await signIn(jar, ADMIN);
      const { client_id } = await registerClient("openid email:read");
      const { challenge } = await pkce();
      const res = await req(
        `/api/auth/oauth2/authorize?${new URLSearchParams({
          client_id,
          redirect_uri: REDIRECT_URI,
          response_type: "code",
          scope: "openid email:read",
          resource: "https://evil.example.com/mcp",
          code_challenge: challenge,
          code_challenge_method: "S256",
          state: "test-state",
        })}`,
        { headers: { cookie: jar.header }, redirect: "manual" },
      );
      const location = new URL(res.headers.get("location") ?? "", BASE_URL);
      expect(location.searchParams.get("error")).toBe("invalid_target");
      expect(location.searchParams.get("code")).toBeNull();
    });
  });

  describe("refresh grant", () => {
    // A refresh token is only issued when the grant holds offline_access.
    const SCOPE = "openid offline_access email:read";

    interface Tokens {
      access_token: string;
      refresh_token: string;
    }

    async function issue(): Promise<Tokens & { clientId: string }> {
      const { code, verifier, clientId } = await runFlow(ADMIN, SCOPE);
      const res = await exchangeToken({
        grant_type: "authorization_code",
        code,
        redirect_uri: REDIRECT_URI,
        client_id: clientId,
        code_verifier: verifier,
        resource: MCP_AUDIENCE,
      });
      expect(res.status, await res.clone().text()).toBe(200);
      const tokens = (await res.json()) as Tokens;
      expect(tokens.refresh_token).toBeTruthy();
      return { ...tokens, clientId };
    }

    function refresh(
      refreshToken: string,
      clientId: string,
      extra: Record<string, string> = {},
    ) {
      return exchangeToken({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: clientId,
        resource: MCP_AUDIENCE,
        ...extra,
      });
    }

    async function refreshed(res: Response): Promise<Tokens> {
      expect(res.status, await res.clone().text()).toBe(200);
      const tokens = (await res.json()) as Tokens;
      expect(tokens.access_token).toBeTruthy();
      expect(tokens.refresh_token).toBeTruthy();
      return tokens;
    }

    async function refusedWith(res: Response, error: string) {
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe(error);
    }

    it("refreshes, refreshes again with the rotated token, and the new access token calls /mcp", async () => {
      const first = await issue();
      const second = await refreshed(
        await refresh(first.refresh_token, first.clientId),
      );
      expect(second.refresh_token).not.toBe(first.refresh_token);
      const third = await refreshed(
        await refresh(second.refresh_token, first.clientId),
      );
      const out = await callTool(third.access_token, "whoami");
      expect(out.isError, out.text).toBe(false);
      expect(out.data.email).toBe(ADMIN.email);
    });

    it("refuses an expired grant", async () => {
      const { refresh_token, clientId } = await issue();
      await getDb()
        .update(oauthRefreshTokens)
        .set({ expiresAt: new Date(Date.now() - 1000) })
        .where(eq(oauthRefreshTokens.clientId, clientId));
      await refusedWith(
        await refresh(refresh_token, clientId),
        "invalid_grant",
      );
    });

    it("refuses a revoked grant", async () => {
      const { refresh_token, clientId } = await issue();
      const revoke = await req("/api/auth/oauth2/revoke", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          token: refresh_token,
          token_type_hint: "refresh_token",
          client_id: clientId,
        }),
      });
      expect(revoke.status, await revoke.clone().text()).toBe(200);
      await refusedWith(
        await refresh(refresh_token, clientId),
        "invalid_grant",
      );
    });

    it("refuses a refresh by another client", async () => {
      const { refresh_token } = await issue();
      const other = await registerClient(SCOPE);
      await refusedWith(
        await refresh(refresh_token, other.client_id),
        "invalid_grant",
      );
    });

    it("refuses a refresh asking for a scope the grant does not hold", async () => {
      const { refresh_token, clientId } = await issue();
      await refusedWith(
        await refresh(refresh_token, clientId, {
          scope: "openid offline_access email:send",
        }),
        "invalid_scope",
      );
    });

    it("replaying a rotated refresh token is invalid_grant and ends the grant: the newest refresh token is refused too", async () => {
      // better-auth 1.7 with refreshTokenReuseInterval at its default 0:
      // any reuse of a rotated token is treated as theft, and every refresh
      // token of that client and user is deleted.
      const first = await issue();
      const second = await refreshed(
        await refresh(first.refresh_token, first.clientId),
      );
      await refusedWith(
        await refresh(first.refresh_token, first.clientId),
        "invalid_grant",
      );
      await refusedWith(
        await refresh(second.refresh_token, first.clientId),
        "invalid_grant",
      );
    });

    it("refreshes a grant stored before better-auth 1.7 (new columns empty), and the new access token verifies for /mcp", async () => {
      const { refresh_token, clientId } = await issue();
      const db = getDb();
      // What migration 0088 leaves on a 1.6 row: the new columns NULL, or
      // their default where the column has one, and no resource links.
      await db.run(sql`UPDATE oauth_clients SET client_discovery_id = NULL,
        client_credentials_scopes = '[]', backchannel_logout_uri = NULL,
        backchannel_logout_session_required = NULL, application_type = NULL,
        jwks = NULL, jwks_uri = NULL, dpop_bound_access_tokens = false
        WHERE client_id = ${clientId}`);
      await db.run(sql`UPDATE oauth_refresh_tokens SET authorization_code_id = NULL,
        resources = NULL, requested_user_info_claims = NULL, rotated_at = NULL,
        rotation_replay_response = NULL, rotation_replay_expires_at = NULL,
        confirmation = NULL WHERE client_id = ${clientId}`);
      await db.run(
        sql`DELETE FROM oauth_client_resources WHERE client_id = ${clientId}`,
      );
      const keys = await db.all<{ id: string; alg: string; crv: string }>(
        sql`SELECT id, alg, crv FROM jwkss`,
      );
      expect(keys.length).toBeGreaterThan(0);
      await db.run(sql`UPDATE jwkss SET alg = NULL, crv = NULL`);
      try {
        const tokens = await refreshed(await refresh(refresh_token, clientId));
        const out = await callTool(tokens.access_token, "whoami");
        expect(out.isError, out.text).toBe(false);
        expect(out.data.email).toBe(ADMIN.email);
      } finally {
        // jwkss is kept across tests.
        for (const key of keys) {
          await db.run(
            sql`UPDATE jwkss SET alg = ${key.alg}, crv = ${key.crv} WHERE id = ${key.id}`,
          );
        }
      }
    });
  });

  describe("scope enforcement", () => {
    it("refuses a tool whose scope the token lacks", async () => {
      // list_people requires email:read; this token only carries openid.
      const token = await getAccessToken(ADMIN, "openid");
      const res = await mcpRpc(token, "tools/call", {
        name: "list_people",
        arguments: {},
      });
      const body = await readRpc(res);
      expect(body.result.isError).toBe(true);
      expect(body.result.content[0].text).toContain("email:read");
    });

    it("still allows whoami without a capability scope", async () => {
      // whoami is the documented way to discover a valid fromAddress, so a
      // least-privilege send-only token must be able to call it.
      const token = await getAccessToken(ADMIN, "openid");
      const out = await callTool(token, "whoami");
      expect(out.isError, out.text).toBe(false);
      expect(out.data.email).toBe(ADMIN.email);
    });
  });
});
