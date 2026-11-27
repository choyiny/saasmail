// Covers: the "⋯" menu on a conversation row stays where it opened when the
// pointer leaves the row to reach the menu. The desktop hover bar used to be
// display:none once the row lost hover, which zeroed the trigger's box and
// made Radix re-anchor the portalled menu at the page's top-left corner.
//
// Seed gives us Alice (p_alice) in the conversation list.
import { test, expect } from "../fixtures/test";
import { truncateAndReseed } from "../support/reset-db";

test.describe.serial("row menu anchor", () => {
  test.beforeAll(() => truncateAndReseed());

  test("the menu keeps its position when the pointer moves onto it", async ({
    page,
  }) => {
    await page.goto("/");

    const row = page.locator(
      '[data-testid="person-row"][data-person-id="p_alice"]',
    );
    await expect(row).toBeVisible();
    await row.hover();

    const kebab = page.locator(
      '[data-testid="person-kebab-menu"][data-person-id="p_alice"]',
    );
    await expect(kebab).toBeVisible();
    await kebab.click();

    const menu = page.getByRole("menu").filter({ hasText: "Move to Trash" });
    await expect(menu).toBeVisible();
    const before = await menu.boundingBox();

    // Move the pointer off the row and onto the open menu, as a user does.
    await page.mouse.move(before!.x + 24, before!.y + 24, { steps: 12 });
    await page.waitForTimeout(300);

    // The trigger is still laid out (it used to collapse with the hover bar)…
    await expect(kebab).toBeVisible();
    // …so the menu has not jumped to the top-left corner.
    const after = await menu.boundingBox();
    expect(Math.abs(after!.x - before!.x)).toBeLessThan(2);
    expect(Math.abs(after!.y - before!.y)).toBeLessThan(2);
  });
});
