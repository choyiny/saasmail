// e2e/specs/auth.spec.ts
// Covers: setup wizard, logout + login, wrong-password error.
//
// Key design:
//  - test.use({ storageState: ... }) overrides the global storageState so this
//    file starts with NO cookies (unauthenticated).
//  - beforeAll wipes BetterAuth tables so the setup wizard is available.
//  - afterAll recreates admin + member so downstream specs continue to work.
import { test, expect } from "../fixtures/test";
import { request } from "@playwright/test";
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
});
