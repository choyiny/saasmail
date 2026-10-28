// e2e/specs/auth.spec.ts
// Covers: setup wizard, logout + login, wrong-password error, and a first
// passkey registered through the real WebAuthn ceremony ending other sessions
// and OAuth grants.
//
// Key design:
//  - test.use({ storageState: ... }) overrides the global storageState so this
//    file starts with NO cookies (unauthenticated).
//  - beforeAll wipes BetterAuth tables so the setup wizard is available.
//  - afterAll recreates admin + member so downstream specs continue to work.
import { test, expect } from "../fixtures/test";
import { request, type APIRequestContext } from "@playwright/test";
import { createHash, randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { wipeUsers } from "../support/reset-db";
import {
  ADMIN,
  MEMBER,
  BASE_URL,
  createAdmin,
  loginViaApi,
  createAndAcceptInvite,
} from "../support/login";
import { TEST_IDS } from "../support/selectors";

// The OAuth resource and redirect the e2e worker accepts: BASE_URL in
// wrangler.jsonc.ci is http://localhost:8080, which names the MCP audience.
const MCP_AUDIENCE = "http://localhost:8080/mcp";
const REDIRECT_URI = "http://localhost:9999/callback";

const base64url = (bytes: Buffer) => bytes.toString("base64url");

/**
 * An MCP-style OAuth grant for the signed-in user of `api`: dynamic
 * registration, authorize, consent and the code exchange. Returns the
 * refresh token and the client it belongs to.
 */
async function issueOAuthGrant(
  api: APIRequestContext,
): Promise<{ refreshToken: string; clientId: string }> {
  const scope = "openid offline_access email:read";
  const registered = await api.post("/api/auth/oauth2/register", {
    data: {
      client_name: "E2E MCP Client",
      redirect_uris: [REDIRECT_URI],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      scope,
    },
    headers: { origin: BASE_URL },
  });
  expect(registered.ok(), await registered.text()).toBe(true);
  const { client_id: clientId } = (await registered.json()) as {
    client_id: string;
  };

  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  const authorize = await api.get(
    `/api/auth/oauth2/authorize?${new URLSearchParams({
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
      response_type: "code",
      scope,
      resource: MCP_AUDIENCE,
      code_challenge: challenge,
      code_challenge_method: "S256",
      state: "e2e-state",
    })}`,
    { maxRedirects: 0 },
  );
  // A redirect for a browser, `{ redirect, url }` for a fetch.
  const consentAt =
    authorize.headers()["location"] ??
    ((await authorize.json()) as { url?: string }).url ??
    "";
  expect(consentAt, "authorize did not send to consent").toContain("?");
  const consent = await api.post("/api/auth/oauth2/consent", {
    data: {
      accept: true,
      oauth_query: consentAt.slice(consentAt.indexOf("?") + 1),
    },
    headers: { origin: BASE_URL },
  });
  expect(consent.ok(), await consent.text()).toBe(true);
  const { url } = (await consent.json()) as { url: string };
  const code = new URL(url).searchParams.get("code");
  expect(code, `no code in ${url}`).toBeTruthy();

  const exchanged = await api.post("/api/auth/oauth2/token", {
    form: {
      grant_type: "authorization_code",
      code: code!,
      redirect_uri: REDIRECT_URI,
      client_id: clientId,
      code_verifier: verifier,
      resource: MCP_AUDIENCE,
    },
    headers: { origin: BASE_URL },
  });
  expect(exchanged.ok(), await exchanged.text()).toBe(true);
  const { refresh_token: refreshToken } = (await exchanged.json()) as {
    refresh_token: string;
  };
  expect(refreshToken).toBeTruthy();
  return { refreshToken, clientId };
}

// Override storageState — start every test in this file unauthenticated.
test.use({ storageState: { cookies: [], origins: [] } });

test.describe.serial("auth flow", () => {
  test.beforeAll(() => {
    // Wipe user/session/account tables so the setup wizard is available.
    wipeUsers();
  });

  test.afterAll(async () => {
    // Recreate admin + member so downstream specs continue to work.
    // We wipe users first to ensure a clean slate (the auth spec tests may
    // have left users in the DB), then recreate them.
    wipeUsers();

    const AUTH_DIR = resolve(process.cwd(), "e2e", ".auth");

    const adminCtx = await request.newContext({ baseURL: BASE_URL });
    await createAdmin(adminCtx);
    await loginViaApi(adminCtx, ADMIN.email, ADMIN.password);
    await adminCtx.storageState({ path: resolve(AUTH_DIR, "admin.json") });

    const memberCtx = await request.newContext({ baseURL: BASE_URL });
    await createAndAcceptInvite(adminCtx, memberCtx, {
      email: MEMBER.email,
      password: MEMBER.password,
      name: MEMBER.name,
      role: "member",
      inboxEmails: [],
    });
    await memberCtx.storageState({ path: resolve(AUTH_DIR, "member.json") });

    await adminCtx.dispose();
    await memberCtx.dispose();
  });

  test("setup wizard creates admin and lands on inbox", async ({ page }) => {
    await page.goto("/");

    // Should be redirected to /onboarding since no users exist.
    await expect(page).toHaveURL(/\/onboarding/);

    // Wait for the form to be ready (status "available").
    await expect(
      page.getByRole("button", { name: "Create administrator" }),
    ).toBeVisible();

    // Fill in the onboarding form.
    await page.getByLabel("Name").fill(ADMIN.name);
    await page.getByLabel("Email").fill(ADMIN.email);
    await page.getByLabel("Password").fill(ADMIN.password);

    await page.getByRole("button", { name: "Create administrator" }).click();

    // After setup the browser may auto-login and land on "/" directly, OR
    // redirect to "/login" if the BetterAuth browser sign-in encounters a
    // CSRF/origin mismatch.  Either way the admin was created; handle both.
    await page.waitForURL((url) => !url.pathname.startsWith("/onboarding"), {
      timeout: 10_000,
    });

    if (page.url().includes("/login")) {
      // Auto-login did not succeed — log in manually via the password form.
      await page
        .getByRole("button", { name: "Sign in with email instead" })
        .click();
      await page.getByPlaceholder("Email").fill(ADMIN.email);
      await page.getByPlaceholder("Password").fill(ADMIN.password);
      await page.getByRole("button", { name: "Sign in", exact: true }).click();
    }

    // Should now be on the inbox (root path).
    await page.waitForURL((url) => url.pathname === "/");
    expect(new URL(page.url()).pathname).toBe("/");
  });

  test("logout then login with correct credentials", async ({ page }) => {
    // Log in via the login page first (the previous test's page session is gone).
    await page.goto("/login");

    // Default mode is passkey — switch to password mode.
    await page
      .getByRole("button", { name: "Sign in with email instead" })
      .click();

    await page.getByPlaceholder("Email").fill(ADMIN.email);
    await page.getByPlaceholder("Password").fill(ADMIN.password);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();

    // Should land on inbox.
    await page.waitForURL((url) => url.pathname === "/");
    expect(new URL(page.url()).pathname).toBe("/");

    // Open account dropdown in sidebar footer and click Sign out.
    // The trigger button has title = user's email.
    await page.getByTitle(ADMIN.email).click();
    await page.getByTestId(TEST_IDS.logoutButton).click();

    // Should be sent back to /login after sign-out.
    await expect(page).toHaveURL(/\/login/);

    // Log back in with correct credentials.
    await page
      .getByRole("button", { name: "Sign in with email instead" })
      .click();
    await page.getByPlaceholder("Email").fill(ADMIN.email);
    await page.getByPlaceholder("Password").fill(ADMIN.password);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();

    await page.waitForURL((url) => url.pathname === "/");
    expect(new URL(page.url()).pathname).toBe("/");
  });

  test("login with wrong password shows error", async ({ page }) => {
    await page.goto("/login");

    // Switch to password mode.
    await page
      .getByRole("button", { name: "Sign in with email instead" })
      .click();

    await page.getByPlaceholder("Email").fill(ADMIN.email);
    await page.getByPlaceholder("Password").fill("totally-wrong-password");
    await page.getByRole("button", { name: "Sign in", exact: true }).click();

    // An error message should appear — stay on /login.
    await expect(page).toHaveURL(/\/login/);
    // The error paragraph rendered by LoginPage has class text-destructive.
    const errorEl = page.locator("p.text-destructive").first();
    await expect(errorEl).toBeVisible();
  });

  test("a first passkey, registered through WebAuthn, ends the account's other sessions and OAuth grants", async ({
    browser,
  }) => {
    const signedOut = { storageState: { cookies: [], origins: [] } };
    const contextA = await browser.newContext(signedOut);
    const contextB = await browser.newContext(signedOut);
    try {
      await loginViaApi(contextA.request, ADMIN.email, ADMIN.password);
      await loginViaApi(contextB.request, ADMIN.email, ADMIN.password);
      expect((await contextB.request.get("/api/admin/audit")).status()).toBe(
        200,
      );
      const grant = await issueOAuthGrant(contextA.request);

      // A platform authenticator for A only, answering every ceremony.
      const page = await contextA.newPage();
      const cdp = await contextA.newCDPSession(page);
      await cdp.send("WebAuthn.enable");
      const { authenticatorId } = await cdp.send(
        "WebAuthn.addVirtualAuthenticator",
        {
          options: {
            protocol: "ctap2",
            transport: "internal",
            hasResidentKey: true,
            hasUserVerification: true,
            isUserVerified: true,
            automaticPresenceSimulation: true,
          },
        },
      );
      await page.goto("/setup-passkey");
      await page.getByRole("button", { name: "Register passkey" }).click();
      await page.waitForURL((url) => url.pathname === "/");
      // The ceremony really ran: the authenticator holds the new credential.
      const { credentials } = await cdp.send("WebAuthn.getCredentials", {
        authenticatorId,
      });
      expect(credentials).toHaveLength(1);

      // A, which registered it, stays signed in.
      expect((await contextA.request.get("/api/admin/audit")).status()).toBe(
        200,
      );
      // B, opened with the password before the passkey, is signed out.
      expect((await contextB.request.get("/api/admin/audit")).status()).toBe(
        401,
      );
      // The OAuth grant issued before the passkey no longer refreshes.
      const refreshed = await contextA.request.post("/api/auth/oauth2/token", {
        form: {
          grant_type: "refresh_token",
          refresh_token: grant.refreshToken,
          client_id: grant.clientId,
          resource: MCP_AUDIENCE,
        },
        headers: { origin: BASE_URL },
      });
      expect(refreshed.status()).toBe(400);
      expect(((await refreshed.json()) as { error: string }).error).toBe(
        "invalid_grant",
      );
      // The audit log holds the registration.
      const audit = await contextA.request.get(
        "/api/admin/audit?action=user.passkey_added",
      );
      expect(audit.ok()).toBe(true);
      const { events } = (await audit.json()) as {
        events: { action: string }[];
      };
      expect(events.map((event) => event.action)).toContain(
        "user.passkey_added",
      );
    } finally {
      await contextA.close();
      await contextB.close();
    }
  });
});
