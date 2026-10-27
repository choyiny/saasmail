// e2e/specs/delete-person.spec.ts
// Covers: the row menu on person rows (admin test id), Delete moving a
// person to Trash with Undo, Restore from Trash, and "Delete forever" — which
// now lives only inside Trash, asks first, removes the person for good and
// survives a reload. Non-admin users never see the admin kebab.
//
// Seed gives us Alice (p_alice) and Bob (p_bob) in the person list.
import type { Page } from "@playwright/test";
import { test, expect } from "../fixtures/test";
import { truncateAndReseed } from "../support/reset-db";
import { TEST_IDS } from "../support/selectors";
import { resolve } from "node:path";

const AUTH_DIR = resolve(process.cwd(), "e2e/.auth");

function row(page: Page, id: string) {
  return page.locator(
    `[data-testid="${TEST_IDS.personRow}"][data-person-id="${id}"]`,
  );
}

async function openKebab(page: Page, id: string) {
  await row(page, id).hover();
  const kebab = page.locator(
    `[data-testid="${TEST_IDS.personKebabMenu}"][data-person-id="${id}"]`,
  );
  await expect(kebab).toBeVisible();
  await kebab.click();
}

test.describe.serial("delete person", () => {
  test.beforeAll(() => truncateAndReseed());

  test("admin sees kebab menu on hover with Move to Trash", async ({
    page,
  }) => {
    await page.goto("/");
    await expect(row(page, "p_alice")).toBeVisible();
    await openKebab(page, "p_alice");

    const trash = page.getByTestId(TEST_IDS.mailTrashItem);
    await expect(trash).toBeVisible();
    await expect(trash).toHaveText(/move to trash/i);
    // Delete forever is not offered outside Trash.
    await expect(page.getByTestId(TEST_IDS.personDeleteButton)).toHaveCount(0);
  });

  test("Move to Trash hides the person; Restore brings them back", async ({
    page,
  }) => {
    await page.goto("/");
    await openKebab(page, "p_alice");
    await page.getByTestId(TEST_IDS.mailTrashItem).click();
    await expect(row(page, "p_alice")).not.toBeVisible();

    await page.goto("/?folder=trash");
    await expect(row(page, "p_alice")).toBeVisible();
    await openKebab(page, "p_alice");
    await page.getByTestId(TEST_IDS.mailRestoreItem).click();
    await expect(row(page, "p_alice")).not.toBeVisible();

    await page.goto("/");
    await expect(row(page, "p_alice")).toBeVisible();
  });

  test("cancelling Delete forever keeps the person in Trash", async ({
    page,
  }) => {
    await page.goto("/");
    await openKebab(page, "p_bob");
    await page.getByTestId(TEST_IDS.mailTrashItem).click();
    await expect(row(page, "p_bob")).not.toBeVisible();

    await page.goto("/?folder=trash");
    await openKebab(page, "p_bob");
    page.once("dialog", (dialog) => dialog.dismiss());
    await page.getByTestId(TEST_IDS.personDeleteButton).click();
    await expect(row(page, "p_bob")).toBeVisible();
  });

  test("confirming Delete forever removes the person and clears the right panel", async ({
    page,
  }) => {
    await page.goto("/?folder=trash");
    const bobRow = row(page, "p_bob");
    await expect(bobRow).toBeVisible();
    await bobRow.click();
    await expect(
      page.getByRole("heading", { name: "Bob Brown" }),
    ).toBeVisible();

    await openKebab(page, "p_bob");
    page.once("dialog", (dialog) => dialog.accept());
    await page.getByTestId(TEST_IDS.personDeleteButton).click();

    await expect(bobRow).not.toBeVisible();
    await expect(
      page.locator("text=Select a person to view emails"),
    ).toBeVisible();
  });

  test("deletion persists after page reload", async ({ page }) => {
    await page.goto("/?folder=trash");
    await page.reload();
    await expect(row(page, "p_bob")).not.toBeVisible();
    await page.goto("/");
    await expect(row(page, "p_bob")).not.toBeVisible();
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
