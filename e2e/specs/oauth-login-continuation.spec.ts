// e2e/specs/oauth-login-continuation.spec.ts
// Covers: a third-party client starting an OAuth authorization while logged
// out, and the flow surviving the trip through the login page.
//
// This is the path every native and third-party client takes on first connect,
// and the only one where the browser has no session yet. The worker-side tests
// all sign in before calling authorize, so without this the login page could
// drop the pending request and nothing would notice.
import { test, expect } from "../fixtures/test";
import { ADMIN, BASE_URL } from "../support/login";

// Start unauthenticated — the whole point is arriving without a session.
test.use({ storageState: { cookies: [], origins: [] } });

/**
 * Register a client the way an unknown client does: RFC 7591 dynamic
 * registration, which this deployment leaves open so MCP clients can self
 * register.
 */
async function registerClient(request: any): Promise<string> {
  const res = await request.post(`${BASE_URL}/api/auth/oauth2/register`, {
    data: {
      client_name: "E2E Continuation Client",
      redirect_uris: [`${BASE_URL}/e2e-callback`],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      scope: "openid email:read",
    },
  });
  expect([200, 201]).toContain(res.status());
  const body = await res.json();
  expect(body.client_id).toBeTruthy();
  return body.client_id;
}

function authorizeUrl(clientId: string): string {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: `${BASE_URL}/e2e-callback`,
    response_type: "code",
    scope: "openid email:read",
    // A fixed challenge is fine here: this spec stops at the consent screen and
    // never exchanges the code, so the verifier is never needed.
    code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    code_challenge_method: "S256",
    state: "e2e-state",
  });
  return `${BASE_URL}/api/auth/oauth2/authorize?${params}`;
}

test.describe("OAuth authorization started while logged out", () => {
  test("keeps the pending request across sign-in instead of landing on the inbox", async ({
    page,
    request,
  }) => {
    const clientId = await registerClient(request);

    await page.goto(authorizeUrl(clientId));

    // The provider bounces to the login page, carrying the signed request.
    await page.waitForURL(/\/login/);
    const loginUrl = new URL(page.url());
    expect(loginUrl.searchParams.get("client_id")).toBe(clientId);
    expect(
      loginUrl.searchParams.get("sig"),
      "login redirect was not signed",
    ).toBeTruthy();

    await page
      .getByRole("button", { name: "Sign in with email instead" })
      .click();
    await page.getByPlaceholder("Email").fill(ADMIN.email);
    await page.getByPlaceholder("Password").fill(ADMIN.password);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();

    // The regression: sign-in used to navigate to "/", stranding the client,
    // which then waited for a callback that never arrived.
    await page.waitForURL((url) => !url.pathname.startsWith("/login"), {
      timeout: 15_000,
    });

    const after = new URL(page.url());
    expect(
      after.pathname,
      `sign-in dropped the pending authorization and landed on ${after.pathname}`,
    ).not.toBe("/");

    // It should now be at consent, or already back at the client with a code.
    const arrived =
      after.pathname.startsWith("/consent") ||
      after.pathname.startsWith("/e2e-callback") ||
      after.searchParams.has("code");
    expect(
      arrived,
      `expected the consent screen or the client callback, got ${page.url()}`,
    ).toBe(true);
  });

  test("still sends an ordinary sign-in to the inbox", async ({ page }) => {
    // Guard against fixing the OAuth path by breaking the normal one.
    await page.goto(`${BASE_URL}/login`);

    await page
      .getByRole("button", { name: "Sign in with email instead" })
      .click();
    await page.getByPlaceholder("Email").fill(ADMIN.email);
    await page.getByPlaceholder("Password").fill(ADMIN.password);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();

    await page.waitForURL((url) => !url.pathname.startsWith("/login"), {
      timeout: 15_000,
    });
    expect(new URL(page.url()).pathname).toBe("/");
  });
});
