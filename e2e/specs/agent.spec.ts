import { test, expect } from "../fixtures/test";
import { truncateAndReseed } from "../support/reset-db";

test.describe.serial("native agent panel", () => {
  test.beforeAll(() => {
    truncateAndReseed();
  });

  test("panel toggles and shows the not-configured hint", async ({ page }) => {
    await page.route("**/api/agent/status", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          configured: false,
          provider: null,
          model: null,
        }),
      });
    });
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

  test("keeps the composer in the viewport with a long transcript", async ({
    page,
  }) => {
    await page.route("**/api/agent/status", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          configured: true,
          provider: "openai",
          model: "layout-test",
        }),
      });
    });

    await page.goto("/");
    await page.getByRole("button", { name: /^Toggle mail agent/ }).click();
    await page.getByTestId("agent-new-session").click();

    const transcript = page.getByTestId("agent-transcript");
    await expect(transcript).toBeVisible();
    await transcript.evaluate((element) => {
      const filler = document.createElement("div");
      filler.dataset.testid = "agent-layout-filler";
      filler.style.height = "3000px";
      filler.textContent = "Long agent answer";
      element.appendChild(filler);
    });

    await expect
      .poll(() =>
        transcript.evaluate(
          (element) => element.scrollHeight > element.clientHeight,
        ),
      )
      .toBe(true);

    const viewportHeight = await page.evaluate(() => window.innerHeight);
    const composerBox = await page.getByTestId("agent-composer").boundingBox();
    expect(composerBox).not.toBeNull();
    expect(composerBox!.y).toBeGreaterThanOrEqual(0);
    expect(composerBox!.y + composerBox!.height).toBeLessThanOrEqual(
      viewportHeight,
    );
    expect(
      await page.evaluate(() => document.scrollingElement?.scrollTop ?? -1),
    ).toBe(0);
  });

  test("keeps document scrolling on long dashboard content", async ({
    page,
  }) => {
    await page.goto("/");

    await page.locator("main").evaluate((main) => {
      const filler = document.createElement("div");
      filler.dataset.testid = "dashboard-scroll-filler";
      filler.style.height = "3000px";
      filler.textContent = "Long dashboard content";
      main.appendChild(filler);
    });

    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (document.scrollingElement?.scrollHeight ?? 0) > window.innerHeight,
        ),
      )
      .toBe(true);

    await page.evaluate(() => window.scrollTo(0, 200));
    await expect
      .poll(() => page.evaluate(() => window.scrollY))
      .toBeGreaterThan(0);
    await expect(page.locator("nav").first()).toHaveClass(/shadow-2xl/);
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
