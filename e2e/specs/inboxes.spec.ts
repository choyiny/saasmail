// e2e/specs/inboxes.spec.ts
// Covers: inbox CRUD + mode toggle + member scoping via the admin UI.
import { test, expect } from "../fixtures/test";
import { truncateAndReseed } from "../support/reset-db";
import { TEST_IDS } from "../support/selectors";
import { request } from "@playwright/test";
import { BASE_URL, MEMBER, loginViaApi } from "../support/login";

test.describe.serial("inboxes CRUD", () => {
  test.beforeAll(() => {
    truncateAndReseed();
  });

  // ── 1. Create inbox ──────────────────────────────────────────────────────────

  test("create inbox appears in list", async ({ page, uniqueName }) => {
    const inboxEmail = `${uniqueName("create")}@e2e.test`;

    await page.goto("/inboxes");

    // Fill the create form.
    await page.getByTestId(TEST_IDS.inboxCreateEmail).fill(inboxEmail);
    await page
      .getByTestId(TEST_IDS.inboxCreateDisplayName)
      .fill("Created Inbox");
    await page.getByTestId(TEST_IDS.inboxCreateButton).click();

    // The new inbox row should appear.
    const newRow = page
      .getByTestId(TEST_IDS.inboxRow)
      .filter({ hasText: inboxEmail });
    await expect(newRow).toBeVisible();
  });

  // ── 2. Rename display name persists after reload ──────────────────────────────

  test("rename display name persists after reload", async ({ page }) => {
    await page.goto("/inboxes");

    // Pick the support@e2e.test inbox (seeded). Use CSS attribute selector on
    // the same element (data-inbox-email is on the inbox-row element itself).
    const supportRow = page.locator(
      `[data-testid="${TEST_IDS.inboxRow}"][data-inbox-email="support@e2e.test"]`,
    );

    await expect(supportRow).toBeVisible();

    // Clear + type a new display name, then blur.
    const nameInput = supportRow.getByTestId(TEST_IDS.inboxDisplayNameInput);
    await nameInput.fill("Support Renamed");
    // Trigger onBlur by pressing Tab.
    await nameInput.press("Tab");

    // Reload and verify persistence.
    await page.reload();

    const reloadedRow = page.locator(
      `[data-testid="${TEST_IDS.inboxRow}"][data-inbox-email="support@e2e.test"]`,
    );
    await expect(
      reloadedRow.getByTestId(TEST_IDS.inboxDisplayNameInput),
    ).toHaveValue("Support Renamed");
  });

  // ── 3. Toggle thread → chat mode persists after reload ───────────────────────

  test("toggle thread to chat mode persists after reload", async ({ page }) => {
    await page.goto("/inboxes");

    // Pick the marketing@e2e.test inbox (seeded with thread mode).
    const marketingRow = page.locator(
      `[data-testid="${TEST_IDS.inboxRow}"][data-inbox-email="marketing@e2e.test"]`,
    );

    await expect(marketingRow).toBeVisible();

    // Click the "Chat" mode toggle button.
    const chatToggle = marketingRow.locator(
      `[data-testid="${TEST_IDS.inboxModeToggle}"][data-mode="chat"]`,
    );
    await chatToggle.click();

    // Optimistic: button should now be active (aria-pressed=true).
    await expect(chatToggle).toHaveAttribute("aria-pressed", "true");

    // Reload and verify persistence.
    await page.reload();

    const reloadedRow = page.locator(
      `[data-testid="${TEST_IDS.inboxRow}"][data-inbox-email="marketing@e2e.test"]`,
    );
    const reloadedChatToggle = reloadedRow.locator(
      `[data-testid="${TEST_IDS.inboxModeToggle}"][data-mode="chat"]`,
    );
    await expect(reloadedChatToggle).toHaveAttribute("aria-pressed", "true");
  });

  // ── 4. Assign member to inbox — confirm via API ──────────────────────────────

  test("assign member to inbox scopes visibility", async ({ page, api }) => {
    // Get the member user's ID using the admin API context.
    const usersRes = await api.get(`${BASE_URL}/api/admin/users`);
    expect(usersRes.ok()).toBeTruthy();
    const allUsers = (await usersRes.json()) as Array<{
      id: string;
      email: string;
      role: string | null;
    }>;
    const memberUser = allUsers.find((u) => u.email === MEMBER.email);
    expect(memberUser).toBeDefined();
    const memberId = memberUser!.id;

    // Use admin UI to assign member@e2e.test to support@e2e.test.
    await page.goto("/inboxes");

    const supportRow = page.locator(
      `[data-testid="${TEST_IDS.inboxRow}"][data-inbox-email="support@e2e.test"]`,
    );
    await expect(supportRow).toBeVisible();

    // Click the member toggle for the member user (shows name or email).
    const memberToggle = supportRow.locator(
      `[data-testid="${TEST_IDS.inboxMemberToggle}"][data-user-id="${memberId}"]`,
    );
    await expect(memberToggle).toBeVisible();

    // Only click if not already assigned.
    const currentlyAssigned =
      (await memberToggle.getAttribute("data-assigned")) === "true";
    if (!currentlyAssigned) {
      await memberToggle.click();
    }

    // Wait until the toggle reflects assigned state.
    await expect(memberToggle).toHaveAttribute("data-assigned", "true");

    // Confirm scoping via a fresh member request context hitting GET /api/stats.
    // Log in as member explicitly (member.json may be empty if the auth spec
    // didn't persist a session cookie for the member).
    const memberCtx = await request.newContext({ baseURL: BASE_URL });
    await loginViaApi(memberCtx, MEMBER.email, MEMBER.password);

    try {
      const statsRes = await memberCtx.get(`${BASE_URL}/api/stats`);
      const statsBody = await statsRes.text();
      expect(
        statsRes.ok(),
        `stats returned ${statsRes.status()}: ${statsBody}`,
      ).toBeTruthy();
      const stats = JSON.parse(statsBody) as { recipients: string[] };

      // Member should see support@e2e.test (assigned) but NOT marketing@e2e.test
      // (not assigned).
      expect(stats.recipients).toContain("support@e2e.test");
      expect(stats.recipients).not.toContain("marketing@e2e.test");
    } finally {
      await memberCtx.dispose();
    }
  });

  // ── 5. Delete inbox — removed from list with confirm dialog ─────────────────

  test("delete inbox removed from list", async ({ page, uniqueName, api }) => {
    // Create a disposable inbox via API so we can safely delete it.
    const inboxEmail = `${uniqueName("del")}@e2e.test`;
    const createRes = await api.post(`${BASE_URL}/api/admin/inboxes`, {
      data: { email: inboxEmail, displayName: "Delete Me" },
    });
    expect(createRes.ok()).toBeTruthy();

    await page.goto("/inboxes");

    // Confirm the row is there.
    const targetRow = page.locator(
      `[data-testid="${TEST_IDS.inboxRow}"][data-inbox-email="${inboxEmail}"]`,
    );
    await expect(targetRow).toBeVisible();

    // Click Delete and accept the browser confirm dialog.
    page.once("dialog", (dialog) => dialog.accept());
    await targetRow.getByTestId(TEST_IDS.inboxDeleteButton).click();

    // Row should disappear.
    await expect(targetRow).not.toBeVisible();
  });
});
