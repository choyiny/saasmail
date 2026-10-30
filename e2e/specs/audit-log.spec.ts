// e2e/specs/audit-log.spec.ts
// Covers: an admin's change shows up in the audit log page, a row opens to
// its details, and the filters narrow the list.
import { test, expect } from "../fixtures/test";
import { ADMIN } from "../support/login";
import { truncateAndReseed } from "../support/reset-db";

test.describe.serial("audit log", () => {
  test.beforeAll(() => truncateAndReseed());

  test("a settings change is listed with who made it and what changed", async ({
    page,
    api,
  }) => {
    const brand = `Audit ${Date.now()}`;
    const changed = await api.patch("/api/admin/settings", {
      data: { brandName: brand },
    });
    expect(changed.ok()).toBeTruthy();

    await page.goto("/admin/audit");
    const row = page
      .getByTestId("audit-row")
      .filter({ hasText: `Changed the brand name to '${brand}'` });
    await expect(row).toBeVisible();
    await expect(row).toContainText("settings.changed");
    // Made with the signed-in admin's session: recorded as that person.
    await expect(row).toContainText(ADMIN.email);

    await row.click();
    const details = page.getByTestId("audit-event-details").first();
    await expect(details).toContainText('"key": "brand_name"');
    await expect(details).toContainText(brand);

    // Narrowing to another group of actions hides it; resetting brings it back.
    await page.getByLabel("Text").fill("no such event anywhere");
    await page.getByRole("button", { name: "Apply filters" }).click();
    await expect(
      page.getByText("No events match these filters."),
    ).toBeVisible();
    await page.getByRole("button", { name: "Reset" }).click();
    await expect(row).toBeVisible();

    // The CSV export answers with the same event.
    const csv = await api.get("/api/admin/audit/export.csv?q=brand%20name");
    expect(csv.ok()).toBeTruthy();
    expect(csv.headers()["content-type"]).toContain("text/csv");
    expect(await csv.text()).toContain(brand);

    // Leave the brand as it was for the other specs.
    await api.patch("/api/admin/settings", { data: { brandName: null } });
  });
});
