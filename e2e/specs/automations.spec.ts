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

  test("creates a reject rule, which a dry run says would reject", async ({
    page,
  }) => {
    const name = "E2E reject automation";

    await page.goto("/automations");
    await page.getByTestId("automation-new").click();
    await page.getByLabel("Rule name").fill(name);
    await page.getByLabel("Action 1 type").selectOption("reject");
    await page.getByLabel("Action 1 reason").fill("Not accepted here");
    await expect(
      page.getByRole("button", { name: "Add action" }),
    ).toBeDisabled();

    // No live SMTP here: the dry run against a seeded message reports it.
    await page.getByLabel("Message ref or id").fill("received:e_m_a1");
    await page.getByRole("button", { name: "Test" }).click();
    await expect(
      page.getByText(/this message would be rejected/),
    ).toBeVisible();

    await page.getByTestId("automation-save").click();
    const row = page
      .getByTestId("automation-rule-row")
      .filter({ hasText: name });
    await expect(row).toBeVisible();
    await expect(row).toContainText("reject");

    page.once("dialog", (dialog) => dialog.accept());
    await row.getByRole("button", { name: "Delete " + name }).click();
    await expect(row).toHaveCount(0);
  });
});
