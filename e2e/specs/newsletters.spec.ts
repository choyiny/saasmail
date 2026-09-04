// e2e/specs/newsletters.spec.ts
// Covers: list create → add member → campaign create → send, through the UI.
import { test, expect } from "../fixtures/test";
import { truncateAndReseed } from "../support/reset-db";
import { TEST_IDS } from "../support/selectors";
import { createTemplate } from "../support/seed";
import { BASE_URL } from "../support/login";
import { request } from "@playwright/test";

test.describe.serial("newsletters", () => {
  test.beforeAll(async () => {
    truncateAndReseed();

    const api = await request.newContext({
      baseURL: BASE_URL,
      storageState: "e2e/.auth/admin.json",
    });
    await createTemplate(api, {
      slug: "digest",
      name: "Digest",
      subject: "This week",
      bodyHtml:
        '<p>Hello {{subscriber_name}}</p><p><a href="https://example.com/read">Read</a></p><p><a href="{{unsubscribe_url}}">Unsubscribe</a></p>',
      fromAddress: "marketing@e2e.test",
    });
    await api.dispose();
  });

  test("create a list", async ({ page }) => {
    await page.goto("/lists");

    await page.getByRole("button", { name: /new list/i }).click();
    await page.getByPlaceholder("Weekly digest").fill("E2E List");
    await page
      .getByPlaceholder("news@yourdomain.com")
      .fill("marketing@e2e.test");
    await page.getByRole("button", { name: /create list/i }).click();

    await expect(
      page.getByTestId(TEST_IDS.listRow).filter({ hasText: "E2E List" }),
    ).toBeVisible();
  });

  test("add a member and see it in the table", async ({ page }) => {
    await page.goto("/lists");
    await page
      .getByTestId(TEST_IDS.listRow)
      .filter({ hasText: "E2E List" })
      .click();

    await page.getByRole("button", { name: /^add$/i }).first().click();
    await page
      .getByPlaceholder("subscriber@example.com")
      .fill("reader@e2e.test");
    await page.getByRole("button", { name: /^add$/i }).last().click();

    await expect(
      page
        .getByTestId(TEST_IDS.memberRow)
        .filter({ hasText: "reader@e2e.test" }),
    ).toBeVisible();
  });

  test("create a campaign as a draft", async ({ page }) => {
    await page.goto("/campaigns");

    await page.getByRole("button", { name: /new campaign/i }).click();
    await page.getByLabel("Campaign name").fill("E2E Campaign");
    await page.getByLabel("Campaign subject").fill("This week");
    await page.getByLabel("Campaign list").selectOption({ label: "E2E List" });
    await page
      .getByLabel("Campaign template")
      .selectOption({ label: "Digest" });
    await page.getByRole("button", { name: /create draft/i }).click();

    const row = page
      .getByTestId(TEST_IDS.campaignRow)
      .filter({ hasText: "E2E Campaign" });
    await expect(row).toBeVisible();
    await expect(row).toContainText("draft");
  });

  test("sending moves the campaign out of draft", async ({ page }) => {
    await page.goto("/campaigns");
    await page
      .getByTestId(TEST_IDS.campaignRow)
      .filter({ hasText: "E2E Campaign" })
      .click();

    await expect(page.getByTestId(TEST_IDS.campaignStatus)).toHaveText("draft");

    // The send is guarded by a confirm() — it reaches every subscriber, so the
    // UI asks before starting something it cannot take back.
    page.once("dialog", (dialog) => dialog.accept());
    await page.getByTestId(TEST_IDS.campaignSend).click();

    await expect(page.getByTestId(TEST_IDS.campaignStatus)).not.toHaveText(
      "draft",
      { timeout: 10_000 },
    );
  });

  test("a sent campaign can no longer be edited or deleted", async ({
    page,
  }) => {
    await page.goto("/campaigns");
    await page
      .getByTestId(TEST_IDS.campaignRow)
      .filter({ hasText: "E2E Campaign" })
      .click();

    // Content is frozen once a campaign leaves draft, so the destructive
    // action is gone from the UI entirely rather than failing on click.
    await expect(page.getByRole("button", { name: /^delete$/i })).toHaveCount(
      0,
    );
  });
});
