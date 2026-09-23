import { test, expect } from "../fixtures/test";
import { truncateAndReseed } from "../support/reset-db";

test.describe.serial("native agent panel", () => {
  test.beforeAll(() => {
    truncateAndReseed();
  });

  test("panel toggles and shows the not-configured hint", async ({ page }) => {
    await page.goto("/");

    const toggle = page.getByRole("button", { name: /^Toggle mail agent/ });
    await expect(toggle).toHaveAttribute("aria-pressed", "false");

    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("agent-not-configured")).toBeVisible();
    await expect(page.getByTestId("agent-composer")).toBeDisabled();

    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-pressed", "false");
    await expect(page.getByTestId("agent-not-configured")).not.toBeVisible();
  });

  test("creates, renames, and archives a session", async ({
    page,
    uniqueName,
  }) => {
    const title = uniqueName("agent-session");

    await page.goto("/");
    await page.getByRole("button", { name: /^Toggle mail agent/ }).click();
    await page.getByTestId("agent-new-session").click();
    await expect(
      page.getByText("New conversation", { exact: true }),
    ).toBeVisible();

    page.once("dialog", async (dialog) => {
      expect(dialog.type()).toBe("prompt");
      await dialog.accept(title);
    });
    await page.getByRole("button", { name: "Rename session" }).click();
    await expect(page.getByText(title, { exact: true })).toBeVisible();

    await page.getByRole("button", { name: `Archive ${title}` }).click();
    await expect(page.getByText(title, { exact: true })).not.toBeVisible();

    await page.getByRole("checkbox", { name: "Show archived" }).check();
    await expect(page.getByText(title, { exact: true })).toBeVisible();
    await expect(
      page.getByRole("button", { name: `Restore ${title}` }),
    ).toBeVisible();
  });
});
