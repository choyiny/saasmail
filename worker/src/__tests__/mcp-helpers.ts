import { expect } from "vitest";
import { env, exports } from "cloudflare:workers";
import { createAuth } from "../auth";
import { inboxPermissions } from "../db/inbox-permissions.schema";
import { getDb } from "./helpers";

export const BASE_URL = "http://localhost:8080";
export const MCP_AUDIENCE = `${BASE_URL}/mcp`;
export const ISSUER = `${BASE_URL}/api/auth`;
export const REDIRECT_URI = "http://localhost:9999/callback";

export const ALL_SCOPES = "openid email:read email:send email:manage";

export interface Credentials {
  name: string;
  email: string;
  password: string;
}

export function req(path: string, init: RequestInit = {}) {
  return exports.default.fetch(`http://localhost${path}`, init);
}

export function json(path: string, body: unknown, init: RequestInit = {}) {
  return req(path, {
    ...init,
    method: "POST",
    headers: { "Content-Type": "application/json", ...(init.headers ?? {}) },
    body: JSON.stringify(body),
  });
}

/**
 * Minimal cookie jar. The authorize endpoint stores the pending OAuth request
 * in a cookie that the consent endpoint reads back, so a browser-like client
 * must carry cookies across the whole flow — not just the session cookie.
 */
export class Jar {
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

// --- PKCE (OAuth 2.1 requires it by default) --------------------------------
function base64url(bytes: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export async function pkce() {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)).buffer);
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier),
  );
  return { verifier, challenge: base64url(digest) };
}

/**
 * Create a user with a usable password. Goes through better-auth rather than
 * inserting rows, so the credential is hashed the way sign-in expects — the
 * same call the first-user setup route makes.
 */
export async function createUserWithPassword(
  creds: Credentials,
  role: "admin" | "member",
) {
  const auth = createAuth(env as unknown as CloudflareBindings);
  await auth.api.createUser({
    body: {
      email: creds.email,
      password: creds.password,
      name: creds.name,
      role,
    },
  });
}

/** Grant a user access to an inbox address. */
export async function grantInbox(userId: string, address: string) {
  await getDb()
    .insert(inboxPermissions)
    .values({
      userId,
      email: address,
      createdAt: Math.floor(Date.now() / 1000),
      createdBy: null,
    });
}

export async function signIn(jar: Jar, creds: Credentials): Promise<void> {
  const res = jar.absorb(
    await json("/api/auth/sign-in/email", {
      email: creds.email,
      password: creds.password,
    }),
  );
  expect(res.status, `sign-in failed: ${await res.clone().text()}`).toBe(200);
  expect(jar.header.length).toBeGreaterThan(0);
}

/** RFC 7591 dynamic client registration, as an MCP client would do. */
export async function registerClient(scope: string) {
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

export async function authorizeAndConsent(
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
  // request as *signed* query params. The page hands them back as
  // `oauth_query`; the endpoint verifies the signature and rebuilds its state
  // from them. This is what ConsentPage.tsx does via oauthProviderClient.
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

export function exchangeToken(fields: Record<string, string>) {
  return req("/api/auth/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields),
  });
}

/**
 * Run authorize → consent and return the pieces, so tests can re-drive the
 * final exchange (replay a code, use a bad verifier, request a bad resource).
 */
export async function runFlow(
  creds: Credentials,
  scope: string,
  opts: { resource?: string } = {},
): Promise<{ code: string; verifier: string; clientId: string }> {
  const jar = new Jar();
  await signIn(jar, creds);
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

export async function getAccessToken(
  creds: Credentials,
  scope: string,
): Promise<string> {
  const { code, verifier, clientId } = await runFlow(creds, scope);
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
export function mcpRpc(
  accessToken: string,
  method: string,
  params: unknown = {},
) {
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
export async function readRpc(res: Response) {
  const text = await res.text();
  if (text.startsWith("event:") || text.includes("\ndata: ")) {
    const line = text.split("\n").find((l) => l.startsWith("data: "));
    return JSON.parse(line!.slice(6));
  }
  return JSON.parse(text);
}

export interface ToolOutcome {
  /** True when the tool reported an in-band error. */
  isError: boolean;
  /** Raw text content of the first result block. */
  text: string;
  /** Parsed JSON payload, for successful calls. */
  data: any;
}

/** Call a tool and normalise the result into something easy to assert on. */
export async function callTool(
  accessToken: string,
  name: string,
  args: Record<string, unknown> = {},
): Promise<ToolOutcome> {
  const res = await mcpRpc(accessToken, "tools/call", {
    name,
    arguments: args,
  });
  expect(res.status, `tools/call ${name} -> HTTP ${res.status}`).toBe(200);
  const body = await readRpc(res);
  expect(
    body.result,
    `tools/call ${name} returned no result: ${JSON.stringify(body)}`,
  ).toBeTruthy();

  const text = body.result.content?.[0]?.text ?? "";
  let data: any = undefined;
  if (!body.result.isError) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }
  return { isError: body.result.isError === true, text, data };
}
