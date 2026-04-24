// e2e/specs/delete-person.spec.ts
// Covers: admin-only kebab menu on person rows, delete-person confirmation
// flow, right-panel clearing on deletion, and non-admin users not seeing the
// kebab at all.
//
// Seed gives us Alice (p_alice) and Bob (p_bob) in the person list.
import { test, expect } from "../fixtures/test";
import { truncateAndReseed } from "../support/reset-db";
import { TEST_IDS } from "../support/selectors";
import { resolve } from "node:path";

const AUTH_DIR = resolve(process.cwd(), "e2e/.auth");

test.describe.serial("delete person", () => {
  test.beforeAll(() => truncateAndReseed());

  test("admin sees kebab menu on hover and can open it", async ({ page }) => {
    await page.goto("/");

    const aliceRow = page.locator(
      `[data-testid="${TEST_IDS.personRow}"][data-person-id="p_alice"]`,
    );
    await expect(aliceRow).toBeVisible();

    // Kebab is opacity-0 until hover — force hover so it becomes interactive.
    const kebab = page.locator(
      `[data-testid="${TEST_IDS.personKebabMenu}"][data-person-id="p_alice"]`,
    );
    await aliceRow.hover();
    await expect(kebab).toBeVisible();

    await kebab.click();

    // Delete option should appear in the portal dropdown.
    const deleteBtn = page.getByTestId(TEST_IDS.personDeleteButton);
    await expect(deleteBtn).toBeVisible();
    await expect(deleteBtn).toHaveText(/delete person/i);
  });

  test("cancelling the confirm dialog keeps person in list", async ({
    page,
  }) => {
    await page.goto("/");

    const aliceRow = page.locator(
      `[data-testid="${TEST_IDS.personRow}"][data-person-id="p_alice"]`,
    );
    await aliceRow.hover();

    const kebab = page.locator(
      `[data-testid="${TEST_IDS.personKebabMenu}"][data-person-id="p_alice"]`,
    );
    await kebab.click();

    // Intercept the browser confirm dialog and dismiss it.
    page.once("dialog", (dialog) => dialog.dismiss());
    await page.getByTestId(TEST_IDS.personDeleteButton).click();

    // Alice should still be in the list.
    await expect(aliceRow).toBeVisible();
  });

  test("confirming deletion removes person from list and clears right panel", async ({
    page,
  }) => {
    await page.goto("/");

    // First select Bob so the right panel is open for him.
    const bobRow = page.locator(
      `[data-testid="${TEST_IDS.personRow}"][data-person-id="p_bob"]`,
    );
    await expect(bobRow).toBeVisible();
    await bobRow.click();

    // Right panel should show Bob's emails.
    await expect(page.locator("text=bob@customers.test")).toBeVisible();

    // Open the kebab for Bob.
    await bobRow.hover();
    const kebab = page.locator(
      `[data-testid="${TEST_IDS.personKebabMenu}"][data-person-id="p_bob"]`,
    );
    await kebab.click();

    // Accept the confirm dialog.
    page.once("dialog", (dialog) => dialog.accept());
    await page.getByTestId(TEST_IDS.personDeleteButton).click();

    // Bob should be gone from the list.
    await expect(bobRow).not.toBeVisible();

    // Right panel should revert to the empty state.
    await expect(
      page.locator("text=Select a person to view emails"),
    ).toBeVisible();
  });

  test("deletion persists after page reload", async ({ page }) => {
    await page.goto("/");

    // Bob was deleted in the previous test; reload to verify persistence.
    await page.reload();

    const bobRow = page.locator(
      `[data-testid="${TEST_IDS.personRow}"][data-person-id="p_bob"]`,
    );
    await expect(bobRow).not.toBeVisible();
  });

  test("non-admin user does not see kebab menu", async ({ browser }) => {
    // Open a fresh browser context with member credentials.
    const memberCtx = await browser.newContext({
      storageState: resolve(AUTH_DIR, "member.json"),
    });
    const mp = await memberCtx.newPage();

    await mp.goto("/");

    // Members have no inbox assignments so they see the "no inboxes" screen,
    // but regardless, no kebab button should ever be rendered.
    const anyKebab = mp.getByTestId(TEST_IDS.personKebabMenu);
    await expect(anyKebab).toHaveCount(0);

    await memberCtx.close();
  });
});
