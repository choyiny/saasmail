// e2e/specs/inboxes.spec.ts
// Covers: inbox CRUD + mode toggle + agent instructions + member scoping via the admin UI.
import { test, expect } from "../fixtures/test";
import {
  execLocalSql,
  queryLocalSql,
  truncateAndReseed,
} from "../support/reset-db";
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

  test("agent instructions persist with a character counter", async ({
    page,
  }) => {
    await page.goto("/inboxes");

    const agentRow = page.locator(
      `[data-testid="${TEST_IDS.inboxRow}"][data-inbox-email="agent-ui@e2e.test"]`,
    );
    await expect(agentRow).toBeVisible();

    const instructions = agentRow.getByTestId(TEST_IDS.inboxAgentInstructions);
    const text = "Prefer concise replies and preserve customer terminology.";
    await instructions.fill(text);
    await expect(
      agentRow.getByTestId(TEST_IDS.inboxAgentInstructionsCount),
    ).toHaveText(`${text.length}/4000`);
    await instructions.press("Tab");

    await page.reload();

    const reloadedRow = page.locator(
      `[data-testid="${TEST_IDS.inboxRow}"][data-inbox-email="agent-ui@e2e.test"]`,
    );
    await expect(
      reloadedRow.getByTestId(TEST_IDS.inboxAgentInstructions),
    ).toHaveValue(text);
  });

  test("auto-suggest replies toggle persists after reload", async ({
    page,
  }) => {
    await page.goto("/inboxes");

    const row = page.locator(
      `[data-testid="${TEST_IDS.inboxRow}"][data-inbox-email="agent-autodraft-ui@e2e.test"]`,
    );
    await expect(row).toBeVisible();

    const toggle = row.getByTestId("inbox-agent-autodraft");
    await expect(toggle).toHaveAttribute("aria-checked", "false");
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-checked", "true");

    await page.reload();

    const reloadedRow = page.locator(
      `[data-testid="${TEST_IDS.inboxRow}"][data-inbox-email="agent-autodraft-ui@e2e.test"]`,
    );
    await expect(
      reloadedRow.getByTestId("inbox-agent-autodraft"),
    ).toHaveAttribute("aria-checked", "true");
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

  // ── 3b. Conversations by thread, then by customer again ─────────────────────

  test("conversations by thread and back regroup the inbox's mail", async ({
    page,
  }) => {
    // See docs/inboxes.md. Alice's second message answers her
    // first; Bob's mail answers nothing.
    execLocalSql(
      "UPDATE emails SET in_reply_to = 'mid_s_a1' WHERE id = 'e_s_a2'",
    );
    const latest = () =>
      queryLocalSql<{ status: string; params: string }>(
        "SELECT status, params FROM async_jobs WHERE job_type = 'thread_backfill' AND ref_id = 'support@e2e.test' ORDER BY created_at DESC, rowid DESC LIMIT 1",
      )[0];
    const keys = () =>
      Object.fromEntries(
        queryLocalSql<{ id: string; thread_key: string | null }>(
          "SELECT id, thread_key FROM emails WHERE recipient = 'support@e2e.test'",
        ).map((row) => [row.id, row.thread_key]),
      );

    await page.goto("/inboxes");
    const row = page.locator(
      `[data-testid="${TEST_IDS.inboxRow}"][data-inbox-email="support@e2e.test"]`,
    );
    const select = row.getByTestId(TEST_IDS.inboxThreadingMode);
    await expect(select).toHaveValue("relationship");

    // The confirmation lists what changes; the regrouping runs on the queue.
    let asked = "";
    page.once("dialog", (dialog) => {
      asked = dialog.message();
      void dialog.accept();
    });
    await select.selectOption("headers");
    await expect.poll(() => asked).toContain("Snoozes and assignments");
    await expect
      .poll(() => latest()?.status, { timeout: 60_000 })
      .toBe("completed");
    const threaded = keys();
    expect(Object.values(threaded).every((key) => key?.startsWith("t:"))).toBe(
      true,
    );
    expect(threaded.e_s_a2).toBe(threaded.e_s_a1);
    expect(new Set(Object.values(threaded)).size).toBe(
      Object.keys(threaded).length - 1,
    );
    await page.reload();
    await expect(select).toHaveValue("headers");

    page.once("dialog", (dialog) => void dialog.accept());
    await select.selectOption("relationship");
    await expect
      .poll(
        () => {
          const job = latest();
          return job && `${JSON.parse(job.params).mode} ${job.status}`;
        },
        { timeout: 60_000 },
      )
      .toBe("relationship completed");
    expect(Object.values(keys()).every((key) => key === null)).toBe(true);
    await page.reload();
    await expect(select).toHaveValue("relationship");
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
