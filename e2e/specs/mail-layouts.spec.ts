// e2e/specs/mail-layouts.spec.ts
// Covers: the per-user mail layout preference (Settings → Appearance), the
// Gmail-style and Outlook-style layouts rendering the seeded inbox, and the
// per-user star / archive state behind their folders.
//
// Seed gives us Alice (p_alice) and Bob (p_bob) in the inbox.
import { test, expect } from "../fixtures/test";
import { truncateAndReseed } from "../support/reset-db";

test.describe.serial("mail layouts", () => {
  test.beforeAll(() => truncateAndReseed());

  test("picking a layout in Settings saves it to the account", async ({
    page,
  }) => {
    await page.goto("/settings#appearance");
    await page.getByRole("radio", { name: /Gmail-style/i }).click();

    await expect
      .poll(async () => {
        const res = await page.request.get("/api/user/preferences");
        return (await res.json()).uiTheme;
      })
      .toBe("gmail");
    await expect(page.locator("html")).toHaveAttribute("data-ui", "gmail");

    // Back to the default so later specs see the layout they expect.
    await page.getByRole("radio", { name: /^Default/i }).click();
    await expect
      .poll(async () => {
        const res = await page.request.get("/api/user/preferences");
        return (await res.json()).uiTheme;
      })
      .toBe("default");
  });

  test("Gmail layout: star a row, find it under Starred, archive it", async ({
    page,
  }) => {
    await page.goto("/?ui=gmail");
    const alice = page.getByTestId("gmail-row").filter({
      hasText: "Alice Anderson",
    });
    await expect(alice).toBeVisible();

    await alice.getByTestId("gmail-row-star").click();
    await page.goto("/?folder=starred");
    await expect(
      page.getByTestId("gmail-row").filter({ hasText: "Alice Anderson" }),
    ).toBeVisible();
    await expect(
      page.getByTestId("gmail-row").filter({ hasText: "Bob Brown" }),
    ).toHaveCount(0);

    await page.goto("/");
    const row = page.getByTestId("gmail-row").filter({
      hasText: "Alice Anderson",
    });
    await row.hover();
    await row.getByTestId("gmail-row-archive").click();
    await expect(row).toHaveCount(0);

    await page.goto("/?folder=archive");
    await expect(
      page.getByTestId("gmail-row").filter({ hasText: "Alice Anderson" }),
    ).toBeVisible();
  });

  test("Outlook layout renders the ribbon, folders and message list", async ({
    page,
  }) => {
    await page.goto("/?ui=outlook");
    await expect(page.getByRole("toolbar", { name: "Ribbon" })).toBeVisible();
    await expect(page.getByTestId("ol-new-mail")).toBeVisible();
    await expect(
      page.getByTestId("ol-row").filter({ hasText: "Bob Brown" }),
    ).toBeVisible();
  });

  test("Outlook layout leaves out the person archived in the Gmail layout", async ({
    page,
  }) => {
    await page.goto("/?ui=outlook");
    await expect(
      page.getByTestId("ol-row").filter({ hasText: "Alice Anderson" }),
    ).toHaveCount(0);

    // Leave Alice as the seed had her: later specs share this database.
    const res = await page.request.patch("/api/mail-state", {
      data: {
        items: [{ type: "person", id: "p_alice" }],
        starred: false,
        archived: false,
      },
    });
    expect(res.ok()).toBe(true);
  });
});
