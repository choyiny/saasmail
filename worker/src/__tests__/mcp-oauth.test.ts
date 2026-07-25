import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { exports } from "cloudflare:workers";
import { applyMigrations, cleanDb } from "./helpers";

const BASE_URL = "http://localhost:8080";
const MCP_AUDIENCE = `${BASE_URL}/mcp`;
const ISSUER = `${BASE_URL}/api/auth`;
const REDIRECT_URI = "http://localhost:9999/callback";

const ADMIN = {
  name: "Owner",
  email: "owner@saasmail.test",
  password: "correct-horse-battery",
};

function req(path: string, init: RequestInit = {}) {
  return exports.default.fetch(`http://localhost${path}`, init);
}

/**
 * Minimal cookie jar. The authorize endpoint stores the pending OAuth request
 * in a cookie that the consent endpoint reads back, so a browser-like client
 * must carry cookies across the whole flow — not just the session cookie.
 */
class Jar {
  private cookies = new Map<string, string>();

  absorb(res: Response) {
    for (const raw of res.headers.getSetCookie()) {
      const [pair] = raw.split(";");
      const idx = pair.indexOf("=");
      if (idx === -1) continue;
      const name = pair.slice(0, idx).trim();
      const value = pair.slice(idx + 1).trim();
      // An empty value is a deletion.
      if (value === "") this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
    return res;
  }

  get header(): string {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
  }
}

function json(path: string, body: unknown, init: RequestInit = {}) {
  return req(path, {
    ...init,
    method: "POST",
    headers: { "Content-Type": "application/json", ...(init.headers ?? {}) },
    body: JSON.stringify(body),
  });
}

// --- PKCE (OAuth 2.1 requires it by default) --------------------------------
function base64url(bytes: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

async function pkce() {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)).buffer);
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier),
  );
  return { verifier, challenge: base64url(digest) };
}

/** Create the first admin, then sign in, accumulating cookies into `jar`. */
async function signIn(jar: Jar): Promise<void> {
  const setup = await json("/api/setup", ADMIN);
  expect(setup.status).toBe(200);

  const res = jar.absorb(
    await json("/api/auth/sign-in/email", {
      email: ADMIN.email,
      password: ADMIN.password,
    }),
  );
  expect(res.status).toBe(200);
  expect(jar.header.length).toBeGreaterThan(0);
}

/**
 * Drive authorize → consent and return the redirect carrying the auth code.
 * Split out from the token exchange so tests can inspect the code directly.
 */
async function authorizeAndConsent(
  jar: Jar,
  params: Record<string, string>,
): Promise<{ location: string; authorizeStatus: number }> {
  const authorizeRes = jar.absorb(
    await req(`/api/auth/oauth2/authorize?${new URLSearchParams(params)}`, {
      headers: { cookie: jar.header },
      redirect: "manual",
    }),
  );

  const location = authorizeRes.headers.get("location") ?? "";
  if (location.startsWith(REDIRECT_URI)) {
    return { location, authorizeStatus: authorizeRes.status };
  }

  // The provider redirects to the consent page with the pending authorization
  // request as *signed* query params. The page has to hand them back as
  // `oauth_query`; the endpoint verifies the signature and rebuilds its state
  // from them. This is what ConsentPage.tsx must do too.
  const consentQuery = location.includes("?")
    ? location.slice(location.indexOf("?") + 1)
    : "";
  expect(
    consentQuery,
    `no oauth query on consent redirect: ${location}`,
  ).toBeTruthy();

  const consentRes = jar.absorb(
    await json(
      "/api/auth/oauth2/consent",
      { accept: true, oauth_query: consentQuery },
      // better-auth CSRF-checks this endpoint and rejects a missing Origin.
      // A browser always sends one; it must be a trusted origin.
      { headers: { cookie: jar.header, Origin: BASE_URL } },
    ),
  );
  expect(
    consentRes.status,
    `consent failed: ${await consentRes.clone().text()}`,
  ).toBe(200);
  // Shape is `{ redirect: true, url }` — the client performs the redirect.
  const raw = await consentRes.text();
  const body = JSON.parse(raw) as { redirect?: boolean; url?: string };
  expect(body.url, `consent returned no redirect url: ${raw}`).toBeTruthy();
  return { location: body.url!, authorizeStatus: authorizeRes.status };
}

/** RFC 7591 dynamic client registration, as an MCP client would do. */
async function registerClient(scope: string) {
  const res = await json("/api/auth/oauth2/register", {
    client_name: "Test MCP Client",
    redirect_uris: [REDIRECT_URI],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
    scope,
  });
  // RFC 7591 specifies 201; better-auth answers 200. Accept either so this
  // doesn't break if the provider tightens it later.
  expect([200, 201]).toContain(res.status);
  return (await res.json()) as { client_id: string };
}

/**
 * Drive authorize → consent → token and return the access token.
 * Mirrors what an MCP client does on first connect.
 */
function exchangeToken(fields: Record<string, string>) {
  return req("/api/auth/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields),
  });
}

/**
 * Run the whole flow and return the pieces, so individual tests can re-drive
 * the last step (replay a code, use a bad verifier, request a bad resource).
 */
async function runFlow(
  scope: string,
  opts: { resource?: string } = {},
): Promise<{ code: string; verifier: string; clientId: string }> {
  const jar = new Jar();
  await signIn(jar);
  const { client_id } = await registerClient(scope);
  const { verifier, challenge } = await pkce();

  const { location } = await authorizeAndConsent(jar, {
    client_id,
    redirect_uri: REDIRECT_URI,
    response_type: "code",
    scope,
    resource: opts.resource ?? MCP_AUDIENCE,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "test-state",
  });

  const code = new URL(location).searchParams.get("code");
  expect(code, `no code in redirect: ${location}`).toBeTruthy();
  return { code: code!, verifier, clientId: client_id };
}

async function getAccessToken(scope: string): Promise<string> {
  const { code, verifier, clientId } = await runFlow(scope);
  const tokenRes = await exchangeToken({
    grant_type: "authorization_code",
    code,
    redirect_uri: REDIRECT_URI,
    client_id: clientId,
    code_verifier: verifier,
    resource: MCP_AUDIENCE,
  });
  expect(
    tokenRes.status,
    `token exchange failed: ${await tokenRes.clone().text()}`,
  ).toBe(200);
  const token = (await tokenRes.json()) as { access_token: string };
  expect(token.access_token).toBeTruthy();
  return token.access_token;
}

/** Send a JSON-RPC call to /mcp with an access token. */
async function mcp(accessToken: string, method: string, params: unknown = {}) {
  return req("/mcp", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      // The streamable-HTTP transport negotiates both.
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
}

/** The transport may answer as SSE; pull the JSON payload out either way. */
async function readRpc(res: Response) {
  const text = await res.text();
  if (text.startsWith("event:") || text.includes("\ndata: ")) {
    const line = text.split("\n").find((l) => l.startsWith("data: "));
    return JSON.parse(line!.slice(6));
  }
  return JSON.parse(text);
}

describe("MCP OAuth", () => {
  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDb();
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
      const res = await mcp("not-a-real-token", "tools/list");
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
      const token = await getAccessToken("openid email:read");
      const res = await mcp(token, "tools/list");
      expect(res.status).toBe(200);

      const body = await readRpc(res);
      const names = (body.result.tools as Array<{ name: string }>).map(
        (t) => t.name,
      );
      expect(names).toContain("whoami");
    });

    it("issues a JWT access token bound to the MCP audience", async () => {
      const token = await getAccessToken("openid email:read");
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
      const token = await getAccessToken("openid email:read");
      const res = await mcp(token, "tools/call", {
        name: "whoami",
        arguments: {},
      });
      const body = await readRpc(res);
      const payload = JSON.parse(body.result.content[0].text);
      expect(payload.email).toBe(ADMIN.email);
      expect(payload.inboxes).toBe("all"); // first user is an admin
    });

    it("rejects an authorization code replayed a second time", async () => {
      const { code, verifier, clientId } = await runFlow("openid email:read");
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
      const { code, clientId } = await runFlow("openid email:read");
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
      const { code, verifier, clientId } = await runFlow("openid email:read", {
        resource: "https://evil.example.com/mcp",
      });
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
      const token = await getAccessToken("openid");
      const res = await mcp(token, "tools/call", {
        name: "whoami",
        arguments: {},
      });
      const body = await readRpc(res);
      expect(body.result.isError).toBe(true);
      expect(body.result.content[0].text).toContain("email:read");
    });
  });
});
