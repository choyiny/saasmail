// e2e/specs/global-search.spec.ts
// Covers: search input UI (placeholder, X clear button) and FTS-powered
// filtering of the person list by email subject and body text.
//
// Seed: Alice has emails to marketing@e2e.test ("Welcome to our product",
// body_text "welcome") and support@e2e.test ("Help with login", body_text
// "login"). Bob has "Your trial is ending" and "Billing question".
import { test, expect } from "../fixtures/test";
import { truncateAndReseed } from "../support/reset-db";
import { TEST_IDS } from "../support/selectors";

test.describe.serial("global search", () => {
  test.beforeAll(() => truncateAndReseed());

  test("search input is visible with correct placeholder", async ({ page }) => {
    await page.goto("/");

    const input = page.getByTestId(TEST_IDS.personSearchInput);
    await expect(input).toBeVisible();
    await expect(input).toHaveAttribute("placeholder", "Search...");
  });

  test("clear button is hidden when search is empty", async ({ page }) => {
    await page.goto("/");

    const clear = page.getByTestId(TEST_IDS.personSearchClear);
    await expect(clear).not.toBeVisible();
  });

  test("clear button appears when typing and clears on click", async ({
    page,
  }) => {
    await page.goto("/");

    const input = page.getByTestId(TEST_IDS.personSearchInput);
    await input.fill("alice");

    const clear = page.getByTestId(TEST_IDS.personSearchClear);
    await expect(clear).toBeVisible();

    await clear.click();
    await expect(input).toHaveValue("");
    await expect(clear).not.toBeVisible();
  });

  test("filtering by person name shows matching person", async ({ page }) => {
    await page.goto("/");

    const input = page.getByTestId(TEST_IDS.personSearchInput);
    await input.fill("Alice");

    const aliceRow = page.locator(
      `[data-testid="${TEST_IDS.personRow}"][data-person-id="p_alice"]`,
    );
    const bobRow = page.locator(
      `[data-testid="${TEST_IDS.personRow}"][data-person-id="p_bob"]`,
    );

    await expect(aliceRow).toBeVisible();
    await expect(bobRow).not.toBeVisible();
  });

  test("FTS search by email subject returns matching person", async ({
    page,
  }) => {
    await page.goto("/");

    const input = page.getByTestId(TEST_IDS.personSearchInput);
    // "billing" appears only in Bob's email subject
    await input.fill("billing");

    const bobRow = page.locator(
      `[data-testid="${TEST_IDS.personRow}"][data-person-id="p_bob"]`,
    );
    const aliceRow = page.locator(
      `[data-testid="${TEST_IDS.personRow}"][data-person-id="p_alice"]`,
    );

    await expect(bobRow).toBeVisible();
    await expect(aliceRow).not.toBeVisible();
  });

  test("FTS search by email body text returns matching person", async ({
    page,
  }) => {
    await page.goto("/");

    const input = page.getByTestId(TEST_IDS.personSearchInput);
    // "login" is the body_text of Alice's support email
    await input.fill("login");

    const aliceRow = page.locator(
      `[data-testid="${TEST_IDS.personRow}"][data-person-id="p_alice"]`,
    );
    const bobRow = page.locator(
      `[data-testid="${TEST_IDS.personRow}"][data-person-id="p_bob"]`,
    );

    await expect(aliceRow).toBeVisible();
    await expect(bobRow).not.toBeVisible();
  });

  test("no results message shown when search matches nothing", async ({
    page,
  }) => {
    await page.goto("/");

    const input = page.getByTestId(TEST_IDS.personSearchInput);
    await input.fill("xyzzyunlikely");

    await expect(page.locator("text=No people found")).toBeVisible();
  });

  test("clearing search restores full list", async ({ page }) => {
    await page.goto("/");

    const input = page.getByTestId(TEST_IDS.personSearchInput);
    await input.fill("alice");

    const bobRow = page.locator(
      `[data-testid="${TEST_IDS.personRow}"][data-person-id="p_bob"]`,
    );
    await expect(bobRow).not.toBeVisible();

    await page.getByTestId(TEST_IDS.personSearchClear).click();
    await expect(bobRow).toBeVisible();
  });
});
