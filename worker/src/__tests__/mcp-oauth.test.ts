import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { applyMigrations, cleanDb } from "./helpers";
import {
  BASE_URL,
  ISSUER,
  MCP_AUDIENCE,
  REDIRECT_URI,
  type Credentials,
  callTool,
  createUserWithPassword,
  exchangeToken,
  getAccessToken,
  mcpRpc,
  readRpc,
  req,
  runFlow,
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

    it("rejects a resource outside validAudiences", async () => {
      // The resource is validated when tokens are minted, not at authorize —
      // so this has to be asserted on the exchange.
      const { code, verifier, clientId } = await runFlow(
        ADMIN,
        "openid email:read",
        {
          resource: "https://evil.example.com/mcp",
        },
      );
      const res = await exchangeToken({
        grant_type: "authorization_code",
        code,
        redirect_uri: REDIRECT_URI,
        client_id: clientId,
        code_verifier: verifier,
        resource: "https://evil.example.com/mcp",
      });
      expect(res.status).not.toBe(200);
      expect(await res.text()).toContain("invalid_request");
    });
  });

  describe("scope enforcement", () => {
    it("refuses a tool whose scope the token lacks", async () => {
      // whoami requires email:read; this token only carries openid.
      const token = await getAccessToken(ADMIN, "openid");
      const res = await mcpRpc(token, "tools/call", {
        name: "whoami",
        arguments: {},
      });
      const body = await readRpc(res);
      expect(body.result.isError).toBe(true);
      expect(body.result.content[0].text).toContain("email:read");
    });
  });
});
