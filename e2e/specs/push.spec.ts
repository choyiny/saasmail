// e2e/specs/push.spec.ts
// Smoke test: verifies that /settings renders either the configured push
// notification UI or the unconfigured-state stub.
//
// Skipped in DEMO_MODE because the smoke test requires a real
// VAPID-configured deployment (or at minimum a running wrangler dev server).

import { test, expect } from "../fixtures/test";

test.describe("push notifications", () => {
  test.skip(
    process.env.DEMO_MODE === "1",
    "Push smoke test requires a real VAPID-configured deployment",
  );

  test("settings page renders configured/unconfigured state", async ({
    page,
  }) => {
    // The custom `test` fixture (e2e/fixtures/test.ts) already attaches the
    // admin auth storage state globally, so the page is authenticated — no
    // explicit login steps are needed here (same pattern used by api-keys.spec,
    // inboxes.spec, etc.).
    await page.goto("/settings");

    // Either VAPID is configured → "Notifications" heading is visible, or it
    // is not configured → the disabled-state stub message is shown instead.
    const heading = page.getByRole("heading", { name: "Notifications" });
    const disabledStub = page.getByText(
      /Push notifications are not configured on this saasmail deployment/,
    );

    await expect(heading.or(disabledStub)).toBeVisible();
  });
});
