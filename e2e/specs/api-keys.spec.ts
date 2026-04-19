// e2e/specs/api-keys.spec.ts
// Covers: API key create → use → revoke (single-key-per-user UI).
//
// Backend contract (worker/src/routers/api-keys-router.ts):
//   GET    /api/api-keys -> { key: { prefix, createdAt } | null }
//   POST   /api/api-keys -> { key: "sk_...", prefix: "sk_abcdef...", createdAt }
//                           (creates OR replaces the single key; shown once)
//   DELETE /api/api-keys -> { success: true }
//
// Auth: Bearer token via `Authorization: Bearer sk_...` authenticates the
// request as that user (worker/src/index.ts lines 125-155).

import { test, expect } from "../fixtures/test";
import { truncateAndReseed } from "../support/reset-db";
import { TEST_IDS } from "../support/selectors";
import { BASE_URL } from "../support/login";

test.describe.serial("api keys", () => {
  test.beforeEach(() => {
    truncateAndReseed();
  });

  // ── 1. Create key → use to hit authed endpoint → revoke it ───────────────

  test("create key, use to hit authed endpoint, revoke it", async ({
    page,
    playwright,
  }) => {
    await page.goto("/api-keys");

    // Empty state: "Generate API Key" button
    const generateBtn = page.getByRole("button", { name: "Generate API Key" });
    await expect(generateBtn).toBeVisible();
    await generateBtn.click();

    // Reveal bar appears with the full sk_... in a readonly input.
    const revealed = page.getByTestId(TEST_IDS.apiKeyRevealed);
    await expect(revealed).toBeVisible();
    const keyValue = await revealed.inputValue();
    expect(keyValue).toMatch(/^sk_[0-9a-f]+$/);

    // Dismiss the reveal.
    await page.getByRole("button", { name: "Done" }).click();
    await expect(revealed).toHaveCount(0);

    // Use the key against an authed endpoint (GET /api/people).
    // IMPORTANT: explicitly pass an empty storageState so we don't inherit the
    // admin session cookie from playwright.config's global `use.storageState`.
    // Otherwise the cookie authenticates the request regardless of the Bearer
    // header, and the revoke check would get 200 instead of 401.
    const apiCtx = await playwright.request.newContext({
      baseURL: BASE_URL,
      storageState: { cookies: [], origins: [] },
      extraHTTPHeaders: {
        Authorization: `Bearer ${keyValue}`,
      },
    });
    try {
      const peopleRes = await apiCtx.get("/api/people");
      expect(peopleRes.ok()).toBeTruthy();

      // Wait for the card with Regenerate + Revoke buttons to appear.
      await expect(
        page.getByRole("button", { name: "Regenerate" }),
      ).toBeVisible();

      // Revoke via UI: the outer Revoke button opens the confirm dialog.
      // The dialog then renders its own Revoke button; we click the one inside
      // role=dialog to confirm.
      await page.getByRole("button", { name: "Revoke" }).first().click();

      const dialog = page.getByRole("dialog");
      await expect(dialog).toBeVisible();
      await expect(
        dialog.getByRole("heading", { name: "Revoke API Key?" }),
      ).toBeVisible();
      await dialog.getByRole("button", { name: "Revoke" }).click();

      // Card should disappear; empty state returns.
      await expect(
        page.getByRole("button", { name: "Generate API Key" }),
      ).toBeVisible();

      // The revoked key should now return 401 against /api/people.
      const afterRes = await apiCtx.get("/api/people");
      expect(afterRes.status()).toBe(401);
    } finally {
      await apiCtx.dispose();
    }
  });

  // ── 2. After reveal dismissed, card shows masked prefix only ─────────────

  test("key card shows masked prefix after reveal dismissed", async ({
    page,
  }) => {
    await page.goto("/api-keys");

    await page.getByRole("button", { name: "Generate API Key" }).click();

    const revealed = page.getByTestId(TEST_IDS.apiKeyRevealed);
    const keyValue = await revealed.inputValue();
    expect(keyValue).toMatch(/^sk_[0-9a-f]+$/);

    // Dismiss the reveal — full key should no longer appear in DOM.
    await page.getByRole("button", { name: "Done" }).click();
    await expect(revealed).toHaveCount(0);

    // The card now shows the masked prefix: first 8 chars + "...".
    // Format: sk_ + 5 hex chars + "..." (slice(0, 8) of "sk_<hex>").
    const prefixLocator = page
      .locator("p.font-mono")
      .filter({ hasText: /^sk_[a-f0-9]{5}\.\.\.$/ });
    await expect(prefixLocator).toBeVisible();

    // Full key must NOT be present anywhere on the page.
    await expect(page.getByText(keyValue, { exact: false })).toHaveCount(0);
  });
});
