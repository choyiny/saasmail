import { test, expect } from "../fixtures/test";
import { truncateAndReseed } from "../support/reset-db";

test.describe.serial("automations", () => {
  test.beforeAll(() => {
    truncateAndReseed();
  });

  test("creates, toggles, and deletes an inbox-scoped rule", async ({
    page,
  }) => {
    const name = "E2E inbox automation";

    await page.goto("/automations");
    await page.getByTestId("automation-new").click();

    await page.getByLabel("Rule name").fill(name);
    await page.getByLabel("Scope").selectOption("automations-ui@e2e.test");
    await page.getByTestId("automation-save").click();

    const row = page
      .getByTestId("automation-rule-row")
      .filter({ hasText: name });
    await expect(row).toBeVisible();
    await expect(row).toContainText("automations-ui@e2e.test");

    let toggle = row.getByRole("switch");
    await expect(toggle).toHaveAttribute("aria-checked", "true");
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-checked", "false");

    toggle = row.getByRole("switch");
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-checked", "true");

    page.once("dialog", (dialog) => dialog.accept());
    await row.getByRole("button", { name: "Delete " + name }).click();
    await expect(row).toHaveCount(0);
  });
});
